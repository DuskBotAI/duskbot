import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { openSse, type SseRecorder } from "../../server/testing/sse.ts";
import { launchVerificationServer } from "../control-dusk.ts";
import { ensureUiBrowser, UI_TOOLS_DIR } from "./control-dusk-ui.ts";

const enabled = process.env.DUSK_UI_E2E === "1" || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));
if (!enabled) console.log(`skipping group browser frames e2e: no agent-browser binary resolves (looked in ${UI_TOOLS_DIR}, DUSK_AGENT_BROWSER_PATH and PATH); set DUSK_UI_E2E=1 to install the pinned release`);
const run = enabled ? it : it.skip;

const PAGE = "<!doctype html><title>Group fixture</title><body><h1>Price list</h1><p>Desk 65 is $129 today.</p></body>";
const JPEG_START = "/9j/";

let pages: Server;
let base = "";
let browser: Awaited<ReturnType<typeof ensureUiBrowser>>;

beforeAll(async () => {
  if (!enabled) return;
  browser = await ensureUiBrowser(process.env, () => {}, UI_TOOLS_DIR);
  pages = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => pages.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(pages.address() as { port: number }).port}`;
}, 600_000);
afterAll(async () => { if (enabled) await new Promise((resolve) => pages.close(resolve)); });

run("a group member's browser reaches the group's thread as live frames while its call runs, and no screenshot is posted when the turn ends", async () => {
  const release = join(tmpdir(), `dusk-group-browser-release-${randomBytes(4).toString("hex")}`);
  const fixture = await launchVerificationServer({
    FAKE_CLAUDE_TOOL_CALLS: JSON.stringify([
      { name: "agent_browser_open", server: "browser", input: { url: `${base}/` } },
      { name: "mcp__browser__agent_browser_wait_for_text", input: { text: "applied" }, hold: true },
    ]),
    FAKE_CLAUDE_RELEASE: release,
  }, undefined, undefined, { binaryPath: browser.binary, executablePath: browser.chrome ?? "" });
  const { url } = fixture.info;
  let stream: SseRecorder | undefined;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    expect((await api("PATCH", "/api/config", { features: { browser: true }, browserEngine: { egress: { allow: ["127.0.0.1"] } } })).status).toBe(200);
    const members = [];
    for (const name of ["Lead", "Second"]) {
      const made = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });
      expect(made.status).toBe(201);
      members.push(made.body.bot);
    }
    const [lead] = members;
    const made = await api("POST", "/api/groups", { name: "Launch", memberIds: members.map((bot) => bot.id),
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } } });
    expect(made.status).toBe(201);
    const group = made.body.group;
    expect(group.threadId).toEqual(expect.any(String));

    stream = await openSse(`${url}/api/events`, { origin: url });
    expect((await api("POST", `/api/groups/${group.id}/messages`, { text: "What does the Desk 65 cost?" })).status).toBeLessThan(300);
    const frame = await stream.until((one) => one.kind === "screen" && one.surface === "browser", 60_000);
    expect(frame).toMatchObject({ botId: lead.id, threadId: group.threadId, mime: "image/jpeg" });
    expect(frame.png.startsWith(JPEG_START)).toBe(true);
    expect(stream.frames.filter((one) => one.kind === "screen" && one.threadId !== group.threadId)).toEqual([]);

    writeFileSync(release, "");
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.groups.find((one: any) => one.id === group.id)?.working, { timeout: 30_000 }).toBe(false);
    const messages = (await api("GET", `/api/threads/${group.threadId}/messages?limit=100`)).body.messages as Array<{ kind: string }>;
    expect(messages.some((message) => message.kind === "text")).toBe(true);
    expect(messages.filter((message) => message.kind === "screen")).toEqual([]);
  } finally {
    stream?.close();
    writeFileSync(release, "");
    await fixture.close();
    rmSync(release, { force: true });
  }
}, 180_000);
