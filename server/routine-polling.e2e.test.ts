import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlDusk } from "../scripts/control-dusk.ts";
import { removeTempDir } from "./testing/cleanup.ts";

async function fixture(name: string, env: Record<string, string>) {
  const folder = mkdtempSync(join(tmpdir(), `dusk-polling-${name}-`));
  const server = await launchVerificationServer({ FAKE_CLAUDE_REPLY_STATE: join(folder, "replies"), ...env });
  const evidence: unknown[] = [];
  const api = async (method: string, path: string, body?: unknown, expected = 200, token?: string) => {
    const response = await fetch(server.info.url + path, {
      method, headers: { "content-type": "application/json", origin: server.info.url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    evidence.push({ method, path, body, status: response.status, result });
    expect(response.status, JSON.stringify(result)).toBe(expected);
    return result;
  };
  const bot = (await api("POST", "/api/bots", { name: "Scout" }, 201)).bot;
  const transcript = async (): Promise<any[]> => (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).messages;
  const idle = () => expect.poll(async () => (await api("GET", "/api/bots?messages=0")).bots.find((one: any) => one.id === bot.id).busy, { timeout: 30_000 }).toBe(false);
  const send = (text: string) => runControlDusk(["send", "--bot", bot.id, "--task", bot.threadId, "--text", text, "--url", server.info.url]);
  const dump = () => JSON.parse(readFileSync(server.fixtureDumpPath, "utf8"));
  const close = async () => {
    writeFileSync(`${server.info.logPath}.polling-${name}.json`, JSON.stringify(evidence, null, 2));
    await server.close();
    await removeTempDir(folder);
  };
  return { folder, api, bot, transcript, idle, send, dump, close, logPath: server.info.logPath };
}

it("a wait_until kind=time follow-up that finds nothing new leaves no visible line and sends no push", async () => {
  const waitCall = { server: "agents", name: "wait_until", input: { label: "the deploy", kind: "time", minutes: 1, follow_up: "Check whether the deploy finished; if nothing changed answer NOTHING NEW." } };
  const f = await fixture("time-wait", {
    FAKE_CLAUDE_REPLIES: JSON.stringify(["I'll check back in a minute.", "NOTHING NEW"]),
    FAKE_CLAUDE_TOOL_CALLS_BY_TURN: JSON.stringify([[waitCall], []]),
  });
  try {
    await f.send("Check back on the deploy in a minute");
    await f.idle();
    const card = (await f.transcript()).find((message) => message.card?.waitRequest);
    expect(card.card.title).toBe("Waiting: the deploy");
    const pushes = async () => (await f.api("GET", "/api/notifications")).notifications.filter((n: any) => n.kind === "done" || n.kind === "wait").length;
    const before = await pushes();
    await expect.poll(async () => (await f.transcript()).some((m) => m.role === "user" && m.text?.includes("[Wait finished: the deploy]")), { timeout: 120_000, interval: 2_000 }).toBe(true);
    await f.idle();
    const after = await f.transcript();
    const reply = after.findLast((m) => m.role === "bot" && m.kind === "text");
    expect(reply).toMatchObject({ text: "NOTHING NEW", quietRun: true });
    expect(after.filter((m) => m.wait)).toEqual([]);
    expect(await pushes()).toBe(before);
    const run = (await f.api("GET", "/api/routines")).runs.find((one: any) => one.eventSource === "wait");
    expect(run).toMatchObject({ status: "completed", report: { state: "quiet" } });
  } finally {
    await f.close();
  }
}, 180_000);

it("a script-check routine made from chat wakes the model only when the script's output changed", async () => {
  const folder = mkdtempSync(join(tmpdir(), "dusk-polling-source-"));
  const source = join(folder, "last-id.txt");
  writeFileSync(source, "last message id: 100\n");
  const create = {
    server: "agents", name: "trigger",
    input: { action: "create", when: "schedule", name: "Group watch", instructions: "Tell me about new messages in the group.",
      schedule: { type: "interval", every_minutes: 60 }, check: { kind: "script", command: `cat ${JSON.stringify(source)}` } },
  };
  const f = await fixture("script-check", {
    FAKE_CLAUDE_REPLIES: JSON.stringify(["Set it up.", "Message 101 arrived."]),
    FAKE_CLAUDE_TOOL_CALLS_BY_TURN: JSON.stringify([[create], []]),
  });
  try {
    await f.send("Watch the group for new messages, but don't spend anything when nothing changed");
    await f.idle();
    const routine = await expect.poll(async () => (await f.api("GET", "/api/routines")).routines.find((one: any) => one.name === "Group watch"), { timeout: 15_000 }).toBeTruthy()
      .then(async () => (await f.api("GET", "/api/routines")).routines.find((one: any) => one.name === "Group watch"));
    expect(routine).toMatchObject({ checks: ["probe"], continuity: true, probe: { kind: "script", command: `cat ${JSON.stringify(source)}` } });
    const runOnce = async () => {
      const { run } = await f.api("POST", `/api/routines/${routine.id}/run`, undefined, 201);
      return expect.poll(async () => (await f.api("GET", "/api/routines")).runs.find((one: any) => one.id === run.id), { timeout: 30_000 })
        .toMatchObject({ status: expect.stringMatching(/^(completed|failed)$/) })
        .then(async () => (await f.api("GET", "/api/routines")).runs.find((one: any) => one.id === run.id));
    };
    const promptCount = () => JSON.stringify(f.dump().prompt ?? "");
    const baseline = await runOnce();
    expect(baseline).toMatchObject({ status: "completed", output: "Nothing new since the last check", report: { state: "quiet" } });
    const same = await runOnce();
    expect(same).toMatchObject({ status: "completed", output: "Nothing new since the last check" });
    expect(promptCount()).not.toContain("script check");
    writeFileSync(source, "last message id: 101\n");
    const changed = await runOnce();
    expect(changed.status).toBe("completed");
    expect(changed.threadId).toBeTruthy();
    await f.idle();
    const prompt = promptCount();
    expect(prompt).toContain("last message id: 101");
    expect(prompt).toContain("last message id: 100");
  } finally {
    await f.close();
    await removeTempDir(folder);
  }
}, 180_000);

it("a script check asked for after the turn read a web page waits on the person's card, which shows the command", async () => {
  const command = "curl -s https://status.example/last-id";
  const calls = [
    { name: "WebFetch", input: { url: "https://forum.example/thread", prompt: "read it" } },
    { server: "agents", name: "trigger", input: { action: "create", when: "schedule", name: "Status watch", instructions: "Tell me when the status changes.",
      schedule: { type: "interval", every_minutes: 60 }, check: { kind: "script", command } } },
  ];
  const f = await fixture("script-card", {
    FAKE_CLAUDE_REPLIES: JSON.stringify(["Asked you to allow it.", "Your status watch is on."]),
    FAKE_CLAUDE_TOOL_CALLS_BY_TURN: JSON.stringify([calls, []]),
  });
  try {
    await f.api("PATCH", `/api/bots/${f.bot.id}`, { approvalMode: "auto" });
    await f.send("Read that forum thread and set up what it says");
    await f.idle();
    const lines = await f.transcript();
    expect(lines.some((message) => message.tool?.name === "WebFetch")).toBe(true);
    expect((await f.api("GET", "/api/routines")).routines.find((one: any) => one.name === "Status watch")).toBeUndefined();
    const card = lines.find((message) => message.card?.routineRequest);
    expect(card.card.options).toEqual(["Confirm", "Cancel"]);
    expect(card.card.subtitle).toContain(command);
    expect(card.card.dismissed).toBeUndefined();
    await f.api("POST", `/api/bots/${f.bot.id}/respond`, { threadId: f.bot.threadId, requestId: card.card.requestId, behavior: "allow" });
    expect((await f.api("GET", "/api/routines")).routines.find((one: any) => one.name === "Status watch")).toMatchObject({ probe: { kind: "script", command } });
    await expect.poll(async () => (await f.transcript()).findLast((m) => m.role === "bot" && m.kind === "text")?.text, { timeout: 30_000 }).toBe("Your status watch is on.");
    expect(JSON.stringify(f.dump().prompt)).toContain("the person allowed the script check");
  } finally {
    await f.close();
  }
}, 120_000);
