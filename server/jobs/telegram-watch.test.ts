import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const fixtures: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });

function update(updateId: number, text: string) {
  return { update_id: updateId, message: { message_id: updateId - 100, date: 1_795_680_000, text,
    chat: { id: -10, title: "Fixture alerts", type: "group" }, from: { first_name: "Fixture" } } };
}

async function fixture(updates: ReturnType<typeof update>[], options: { refuseAt?: number; keywords?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dusk-watch-delivery-"));
  const file = join(root, "telegram-watch.json");
  const state = (): { offset?: number } => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; } };
  const polls: number[] = [], accepted: string[] = [], checkpoints: Array<number | undefined> = [];
  let attempts = 0, refused = false, child: ChildProcess | undefined;
  let log = "";
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://fixture");
    if (url.pathname.endsWith("/getMe")) {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ ok: true, result: { username: "fixture", can_read_all_group_messages: true } }));
    }
    if (url.pathname.endsWith("/getUpdates")) {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      polls.push(offset);
      const pending = updates.filter((item) => item.update_id >= offset);
      if (!pending.length) return;
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ ok: true, result: pending }));
    }
    if (url.pathname === "/notify") {
      req.setEncoding("utf8");
      let raw = "";
      for await (const part of req) raw += part;
      const note = JSON.parse(raw) as { text: string };
      attempts++;
      if (attempts === options.refuseAt) {
        refused = true;
        res.writeHead(503, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "Fixture delivery unavailable" }));
      }
      checkpoints.push(state().offset);
      accepted.push(note.text);
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ ok: true }));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  };
  const start = () => {
    child = spawn(process.execPath, [fileURLToPath(new URL("./telegram-watch.ts", import.meta.url))], {
      env: { PATH: process.env.PATH, TELEGRAM_BOT_TOKEN: "fixture", DUSK_TELEGRAM_API_URL: base,
        DUSK_JOB_NOTIFY_URL: `${base}/notify`, DUSK_JOB_TOKEN: "fixture-notify", DUSK_JOB_DIR: root,
        ...(options.keywords ? { TELEGRAM_WATCH_KEYWORDS: options.keywords } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (part) => { log += part; });
    child.stderr!.on("data", (part) => { log += part; });
  };
  const close = async () => {
    await stop();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
  };
  const result = { start, stop, close, state, polls, accepted, checkpoints,
    refused: () => refused, log: () => log,
    complete: () => expect.poll(() => polls.at(-1), { timeout: 8_000 }).toBe(updates.at(-1)!.update_id + 1) };
  fixtures.push(result);
  return result;
}

function deliveredText(notes: string[], messageId: number): string {
  const pattern = new RegExp(`message ${messageId}(?:, part \\d+/\\d+)?\\): (.*)$`, "gm");
  return notes.flatMap((note) => [...note.matchAll(pattern)].map((match) => match[1])).join("");
}

it("keeps a short batch in one notification and acknowledges its last update", async () => {
  const f = await fixture([update(101, "first"), update(102, "second"), update(103, "third")]);
  f.start(); await f.complete();
  expect(f.accepted).toHaveLength(1);
  expect(f.accepted[0]).toMatch(/^New Telegram messages \(3\),.*\n\[Fixture alerts\] Fixture \(2026-11-26 08:00 UTC, message 1\): first\n/);
  expect([1, 2, 3].map((id) => deliveredText(f.accepted, id))).toEqual(["first", "second", "third"]);
  expect(f.state().offset).toBe(104);
});

it("forwards every message in a large batch before acknowledging it", async () => {
  const texts = ["a".repeat(2_000), "b".repeat(2_000), "c".repeat(2_000)];
  const f = await fixture(texts.map((text, i) => update(101 + i, text)));
  f.start(); await f.complete();
  expect([1, 2, 3].map((id) => deliveredText(f.accepted, id))).toEqual(texts);
  expect(f.accepted.every((note) => note.length <= 3_800)).toBe(true);
  expect(f.checkpoints).toEqual([undefined, 102, 103]);
});

it.each(["x".repeat(4_096), "🙂".repeat(2_048), "a ".repeat(2_048).trim()])("forwards a long message in bounded complete parts: %#", async (text) => {
  const f = await fixture([update(101, text)]);
  f.start(); await f.complete();
  expect(deliveredText(f.accepted, 1)).toBe(text);
  expect(f.accepted.length).toBeGreaterThan(1);
  expect(f.accepted.every((note) => note.length <= 3_800)).toBe(true);
  for (const note of f.accepted) expect(note).not.toMatch(/[\uD800-\uDFFF]/u);
  expect(f.checkpoints.every((offset) => offset === undefined)).toBe(true);
  expect(f.state().offset).toBe(102);
});

it("retains the accepted prefix across a failed delivery and restart", async () => {
  const texts = ["a".repeat(2_000), "b".repeat(2_000), "c".repeat(2_000)];
  const f = await fixture(texts.map((text, i) => update(101 + i, text)), { refuseAt: 2 });
  f.start();
  await expect.poll(f.refused, { timeout: 8_000 }).toBe(true);
  expect(f.state().offset).toBe(102);
  await f.stop(); f.start(); await f.complete();
  expect(f.polls).toContain(102);
  expect([1, 2, 3].map((id) => deliveredText(f.accepted, id))).toEqual(texts);
});

it("does not acknowledge an incomplete long message and retries it after restart", async () => {
  const text = "z".repeat(4_096);
  const f = await fixture([update(101, text)], { refuseAt: 2 });
  f.start();
  await expect.poll(f.refused, { timeout: 8_000 }).toBe(true);
  expect(f.state().offset).toBeUndefined();
  await f.stop();
  const previousNotes = f.accepted.length;
  f.start(); await f.complete();
  expect(f.polls.filter((offset) => offset === 0)).toHaveLength(2);
  expect(deliveredText(f.accepted.slice(previousNotes), 1)).toBe(text);
});

it("acknowledges filtered-out updates without forwarding them", async () => {
  const f = await fixture([update(101, "ignore"), update(102, "keep this"), update(103, "ignore too")], { keywords: "keep" });
  f.start(); await f.complete();
  expect(f.accepted).toHaveLength(1);
  expect(deliveredText(f.accepted, 2)).toBe("keep this");
  expect(f.accepted[0]).not.toContain("ignore");
  expect(f.state().offset).toBe(104);
});

it("keeps the offset unchanged when the first notification fails", async () => {
  const f = await fixture([update(101, "retry me")], { refuseAt: 1 });
  f.start(); await expect.poll(f.refused, { timeout: 8_000 }).toBe(true);
  expect(f.accepted).toEqual([]);
  expect(f.state().offset).toBeUndefined();
});
