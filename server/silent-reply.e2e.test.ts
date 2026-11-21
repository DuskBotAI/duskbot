import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-dusk.ts";
import { botReactor } from "../shared/reactions.ts";
import { failedTurnCause } from "../shared/failed-turn.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { openSse } from "./testing/sse.ts";

it("lets a bot stay quiet with (pass) in a 1:1 chat without flashing (pass), marking unread or notifying, while keeping bare Pass. visible", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "dusk-silent-reply-"));
  const fixture = await launchVerificationServer({
    FAKE_CLAUDE_REPLIES: JSON.stringify([
      "o7. I also took the Z2U check off my list.",
      "(pass)",
      "Pass.",
    ]),
    FAKE_CLAUDE_REPLY_STATE: join(scratch, "reply-state"),
    FAKE_CLAUDE_TOOL_CALLS: "[]",
    FAKE_CLAUDE_STREAM_CADENCE: "2:5",
  });
  const api = async (method: string, path: string, body?: unknown, expected = 200) => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(expected);
    return result;
  };
  const stream = await openSse(`${fixture.info.url}/api/events`, { origin: fixture.info.url });
  try {
    const { bot } = await api("POST", "/api/bots", { name: "Scout" }, 201);
    const threadId = bot.threadId as string;
    const transcript = async (): Promise<any[]> => (await api("GET", `/api/threads/${threadId}/messages`)).messages;
    const botRow = async () => (await api("GET", "/api/bots?messages=0")).bots.find((candidate: any) => candidate.id === bot.id);
    const waitIdle = () => expect.poll(async () => Boolean((await botRow()).busy), { timeout: 20_000 }).toBe(false);

    await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "I deleted the Z2U check." }, 202);
    await expect.poll(async () => (await transcript()).some((m) => m.text === "o7. I also took the Z2U check off my list."), { timeout: 20_000 }).toBe(true);
    await waitIdle();

    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    expect(dump.systemPrompt).toContain("Know when not to reply: in a 1:1 chat");
    expect(dump.systemPrompt).toContain("end with just (pass)");

    await api("PATCH", `/api/bots/${bot.id}`, { unread: false });
    expect((await botRow()).unread).toBe(false);

    const beforeFrames = stream.frames.length;
    const beforeBotTexts = (await transcript()).filter((m) => m.role === "bot" && m.kind === "text");
    const target = beforeBotTexts.at(-1);

    const reacted = await api("POST", `/api/threads/${threadId}/messages/${target.id}/reactions`, { emoji: "👍", on: true });
    expect(reacted).toMatchObject({ delivery: "started" });
    await stream.until((frame) => stream.frames.indexOf(frame) >= beforeFrames && frame.kind === "runtime" && frame.event?.type === "turn.completed" && frame.event.threadId === threadId, 20_000);
    await waitIdle();

    const passFrames = stream.frames.slice(beforeFrames);
    const passTextEvents = passFrames.filter((frame) =>
      frame.kind === "runtime" &&
      frame.event?.threadId === threadId &&
      ((frame.event.type === "content.delta" && frame.event.streamKind === "assistant_text") ||
        (frame.event.type === "item.completed" && frame.event.itemType === "assistant_text")));
    expect(passTextEvents).toEqual([]);
    expect(passFrames.filter((frame) => frame.kind === "notify" && frame.notification?.kind === "done" && frame.notification.threadId === threadId)).toEqual([]);

    const afterPass = await transcript();
    expect(afterPass.filter((m) => m.role === "bot" && m.kind === "text")).toHaveLength(beforeBotTexts.length);
    expect(afterPass.filter((m) => m.tool && failedTurnCause(m.tool.name) !== null)).toEqual([]);
    expect((await botRow()).unread).toBe(false);

    await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "Did CI pass or fail? One word." }, 202);
    await expect.poll(async () => (await transcript()).some((m) => m.role === "bot" && m.text === "Pass."), { timeout: 20_000 }).toBe(true);
    await waitIdle();
    expect((await botRow()).unread).toBe(true);
  } finally {
    stream.close();
    await fixture.close();
    await removeTempDir(scratch);
  }
}, 90_000);

it("lets a bot react via the react tool and end quietly with (pass)", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "dusk-react-pass-"));
  const fixture = await launchVerificationServer({
    FAKE_CLAUDE_MCP_TOOLS: JSON.stringify([{ tool: "react", arguments: { emoji: "❤️" } }]),
    FAKE_CLAUDE_REPLIES: JSON.stringify(["(pass)"]),
    FAKE_CLAUDE_REPLY_STATE: join(scratch, "reply-state"),
    FAKE_CLAUDE_TOOL_CALLS: "[]",
    FAKE_CLAUDE_STREAM_CADENCE: "2:5",
  });
  const api = async (method: string, path: string, body?: unknown, expected = 200) => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(expected);
    return result;
  };
  const stream = await openSse(`${fixture.info.url}/api/events`, { origin: fixture.info.url });
  try {
    const { bot } = await api("POST", "/api/bots", { name: "Scout" }, 201);
    const threadId = bot.threadId as string;
    const transcript = async (): Promise<any[]> => (await api("GET", `/api/threads/${threadId}/messages`)).messages;
    const botRow = async () => (await api("GET", "/api/bots?messages=0")).bots.find((candidate: any) => candidate.id === bot.id);

    await api("PATCH", `/api/bots/${bot.id}`, { unread: false });
    const beforeFrames = stream.frames.length;
    const beforeBotTexts = (await transcript()).filter((m) => m.role === "bot" && m.kind === "text");

    await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "thanks!" }, 202);
    await stream.until((frame) => stream.frames.indexOf(frame) >= beforeFrames && frame.kind === "runtime" && frame.event?.type === "turn.completed" && frame.event.threadId === threadId, 20_000);
    await expect.poll(async () => Boolean((await botRow()).busy), { timeout: 20_000 }).toBe(false);

    const rows = await transcript();
    const thanks = rows.find((m) => m.role === "user" && m.text === "thanks!");
    expect(thanks?.reactions).toEqual([{ emoji: "❤️", by: botReactor(bot.id), name: "Scout", at: expect.any(Number) }]);
    expect(rows.filter((m) => m.role === "bot" && m.kind === "text")).toHaveLength(beforeBotTexts.length);
    expect(rows.filter((m) => m.tool && failedTurnCause(m.tool.name) !== null)).toEqual([]);
    expect((await botRow()).unread).toBe(false);

    const frames = stream.frames.slice(beforeFrames);
    expect(frames.filter((frame) => frame.kind === "notify" && frame.notification?.kind === "done" && frame.notification.threadId === threadId)).toEqual([]);
  } finally {
    stream.close();
    await fixture.close();
    await removeTempDir(scratch);
  }
}, 90_000);
