import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlDusk } from "../scripts/control-dusk.ts";
import { removeTempDir } from "./testing/cleanup.ts";

it("a bot's background_job call starts a job that outlives its turn, and the job's notify wakes the bot in a run", async () => {
  const folder = mkdtempSync(join(tmpdir(), "dusk-jobs-e2e-"));
  const gate = join(folder, "finish");
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
  const api = async (method: string, path: string, body?: unknown, expected = 200, token?: string) => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.status, JSON.stringify(result)).toBe(expected);
    return result;
  };
  const dump = () => { try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); } catch { return {}; } };
  const turnPrompt = (): string => {
    const content = dump().prompt?.message?.content;
    return Array.isArray(content) ? content.map((block: { text?: string }) => block.text ?? "").join("\n") : String(content ?? "");
  };
  try {
    const bot = (await api("POST", "/api/bots", { name: "Scout" }, 201)).bot;
    const transcript = async (): Promise<any[]> => (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).messages;
    const busy = async () => (await api("GET", "/api/bots?messages=0")).bots.find((candidate: any) => candidate.id === bot.id).busy;
    await runControlDusk(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "Watch my brand deals group and tell me when a deal moves forward", "--url", fixture.info.url]);
    let token = "";
    await expect.poll(() => { token = dump().mcpConfig?.mcpServers?.agents?.env?.DUSK_COMMS_TOKEN ?? ""; return Boolean(token); }, { timeout: 15_000 }).toBe(true);

    const beats = join(folder, "beats.txt");
    const command = `dusk-notify --tell "watching the deals group" && sleep 3 && dusk-notify "Acme moved to contract" && while true; do echo beat >> ${beats}; sleep 1; done`;
    const started = await api("POST", "/api/internal/jobs", { action: "start", label: "Deal watch", command, on_notify: "Tell the person only when a deal moves forward." }, 201, token);
    expect(started.text).toContain("keeps running after this turn");

    writeFileSync(gate, "finish");
    await expect.poll(busy, { timeout: 15_000 }).toBe(false);
    await expect.poll(async () => (await transcript()).some((m) => m.role === "bot" && m.text === "watching the deals group"), { timeout: 15_000 }).toBe(true);
    await expect.poll(turnPrompt, { timeout: 40_000 }).toContain("Acme moved to contract");
    expect(turnPrompt()).toContain("Tell the person only when a deal moves forward.");
    const lines = () => { try { return readFileSync(beats, "utf8").split("\n").length; } catch { return 0; } };
    await expect.poll(lines, { timeout: 10_000 }).toBeGreaterThan(2);
    await fixture.close();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const stopped = lines();
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(lines()).toBe(stopped);
  } finally {
    await fixture.close().catch(() => {});
    await removeTempDir(folder);
  }
}, 120_000);

it("at Ask before every action the start shows one card, and Allow starts the job", async () => {
  const folder = mkdtempSync(join(tmpdir(), "dusk-jobs-e2e-ask-"));
  const gate = join(folder, "finish");
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
  const api = async (method: string, path: string, body?: unknown, expected = 200, token?: string) => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.status, JSON.stringify(result)).toBe(expected);
    return result;
  };
  const dump = () => { try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); } catch { return {}; } };
  try {
    const bot = (await api("POST", "/api/bots", { name: "Scout" }, 201)).bot;
    await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask" });
    const transcript = async (): Promise<any[]> => (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).messages;
    await runControlDusk(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "Watch the deals group for me", "--url", fixture.info.url]);
    let token = "";
    await expect.poll(() => { token = dump().mcpConfig?.mcpServers?.agents?.env?.DUSK_COMMS_TOKEN ?? ""; return Boolean(token); }, { timeout: 15_000 }).toBe(true);
    const beats = join(folder, "beats.txt");
    const asked = await api("POST", "/api/internal/jobs", { action: "start", label: "Deal watch", command: `while true; do echo beat >> ${beats}; sleep 1; done` }, 202, token);
    expect(asked.text).toContain("A card now asks the person");
    const card = (await transcript()).find((m) => m.card?.tool === "background_job")?.card;
    expect(card).toMatchObject({ title: "Keep running Deal watch in the background", options: ["Allow", "Deny"] });
    writeFileSync(gate, "finish");
    await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: card.requestId, behavior: "allow" });
    await expect.poll(async () => (await transcript()).some((m) => m.role === "bot" && String(m.text).startsWith("Started Deal watch")), { timeout: 15_000 }).toBe(true);
    const lines = () => { try { return readFileSync(beats, "utf8").split("\n").length; } catch { return 0; } };
    await expect.poll(lines, { timeout: 10_000 }).toBeGreaterThan(2);
  } finally {
    await fixture.close();
    await removeTempDir(folder);
  }
}, 120_000);
