import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { startFakeTelegram, type FakeTelegram } from "../testing/fake-telegram.ts";
import { notesFor, type Update } from "./telegram-watch.ts";

const TOKEN = "7000001:AAH-fake-token-for-the-watch-test-0123456";
const WATCH = join(import.meta.dirname, "telegram-watch.ts");
const open: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of open.splice(0).reverse()) await close(); });

const update = (id: number, text: string): Update => ({ update_id: id, message: { message_id: id, date: 1_700_000_000, text, chat: { id: -10, title: "Deals", type: "supergroup" }, from: { first_name: "Ana" } } });
const texts = (n: number, size: number) => Array.from({ length: n }, (_, i) => `${String.fromCharCode(97 + i)}${"x".repeat(size - 2)}${String.fromCharCode(65 + i)}`);
const bodies = (notes: readonly string[]) => notes.flatMap((note) => note.split("\n").slice(1).map((line) => line.slice(line.indexOf("): ") + 3))).join("");

describe("telegram_watch notes", () => {
  it("keeps every message of a poll, each note bounded, and never saves an offset past text it has not sent", () => {
    const long = texts(3, 2_000), notes = notesFor(long.map((text, i) => update(101 + i, text)), [], []);
    expect(notes.length).toBe(3);
    for (const note of notes) expect(note.text.length).toBeLessThanOrEqual(3_800);
    for (const text of long) expect(notes.some((note) => note.text.includes(text))).toBe(true);
    expect(notes.map((note) => note.offset)).toEqual([102, 103, 104]);
    expect(notesFor([update(1, "hi"), update(2, "there")], [], []).map((note) => note.offset)).toEqual([3]);
  });

  it("sends a message too long for one note in parts, and its update counts as read only with the last part", () => {
    const [text] = texts(1, 4_096), notes = notesFor([update(101, text!)], [], []);
    expect(notes.length).toBe(2);
    expect(notes[0]!.text).toContain("part 1 of 2");
    expect(notes.map((note) => note.offset)).toEqual([0, 102]);
    expect(bodies(notes.map((note) => note.text))).toBe(text);
  });

  it.each(["🙂".repeat(2_048), "a" + "🙂".repeat(2_047)])("keeps Unicode characters whole at either split boundary: %#", (text) => {
    const notes = notesFor([update(101, text)], [], []);
    expect(notes.length).toBeGreaterThan(1);
    for (const note of notes) {
      expect(note.text.length).toBeLessThanOrEqual(3_800);
      expect(note.text).not.toMatch(/[\uD800-\uDFFF]/u);
    }
    expect(bodies(notes.map((note) => note.text))).toBe(text);
    expect(notes.slice(0, -1).every((note) => note.offset === 0)).toBe(true);
    expect(notes.at(-1)!.offset).toBe(102);
  });
});

async function notifier(answer: () => number) {
  const notes: string[] = [];
  let asked = 0;
  const server: Server = createServer((req, res) => {
    req.setEncoding("utf8");
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => { asked++; const status = answer(); if (status < 300) notes.push((JSON.parse(body) as { text: string }).text); res.writeHead(status).end("{}"); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { notes, asked: () => asked, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/notify` };
}

function watch(telegram: FakeTelegram, notifyUrl: string, dir: string): ChildProcess {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", WATCH], {
    env: { PATH: process.env.PATH, TELEGRAM_BOT_TOKEN: TOKEN, DUSK_TELEGRAM_API_URL: telegram.origin, DUSK_JOB_DIR: dir, DUSK_JOB_NOTIFY_URL: notifyUrl, DUSK_JOB_TOKEN: "job-token" },
    stdio: "ignore",
  });
  open.push(() => { child.kill("SIGKILL"); });
  return child;
}

async function telegram() {
  const fake = await startFakeTelegram({ token: TOKEN });
  open.push(() => fake.close());
  return fake;
}
const offsetIn = (dir: string) => { try { return (JSON.parse(readFileSync(join(dir, "telegram-watch.json"), "utf8")) as { offset?: number }).offset; } catch { return undefined; } };
const polledFrom = (fake: FakeTelegram) => fake.calls.filter((call) => call.method === "getUpdates").map((call) => Number(call.params.offset ?? 0));

describe.skipIf(process.platform === "win32")("telegram_watch process", () => {
  it.each(["🙂".repeat(2_048), "a" + "🙂".repeat(2_047)])("forwards individually valid Unicode parts through the notify endpoint: %#", async (text) => {
    const fake = await telegram(), notify = await notifier(() => 200);
    const dir = mkdtempSync(join(tmpdir(), "tg-watch-")); open.push(() => rmSync(dir, { recursive: true, force: true }));
    fake.message({ from: { id: 5, first_name: "Ana" }, chat: { id: -10, type: "supergroup", title: "Deals" }, text });
    watch(fake, notify.url, dir);
    await expect.poll(() => offsetIn(dir), { timeout: 15_000 }).toBe(2);
    expect(notify.notes.length).toBeGreaterThan(1);
    for (const note of notify.notes) {
      expect(note.length).toBeLessThanOrEqual(3_800);
      expect(note).not.toMatch(/[\uD800-\uDFFF]/u);
    }
    expect(bodies(notify.notes)).toBe(text);
  });

  it("forwards three long messages and a 4,096-character one whole before it polls past them", async () => {
    const fake = await telegram(), notify = await notifier(() => 200);
    const dir = mkdtempSync(join(tmpdir(), "tg-watch-")); open.push(() => rmSync(dir, { recursive: true, force: true }));
    const long = [...texts(3, 2_000), ...texts(1, 4_096)];
    for (const text of long) fake.message({ from: { id: 5, first_name: "Ana" }, chat: { id: -10, type: "supergroup", title: "Deals" }, text });
    watch(fake, notify.url, dir);
    await expect.poll(() => offsetIn(dir), { timeout: 15_000 }).toBe(5);
    for (const text of long.slice(0, 3)) expect(notify.notes.some((note) => note.includes(text))).toBe(true);
    expect(bodies(notify.notes)).toBe(long.join(""));
    expect(polledFrom(fake)).not.toContain(4);
    for (const note of notify.notes) expect(note.length).toBeLessThanOrEqual(3_800);
  });

  it("reads again what dusk bot did not take, and saves no offset past it", async () => {
    const fake = await telegram();
    let refuse = true;
    const notify = await notifier(() => (refuse ? 503 : 200));
    const dir = mkdtempSync(join(tmpdir(), "tg-watch-")); open.push(() => rmSync(dir, { recursive: true, force: true }));
    const [text] = texts(1, 300);
    fake.message({ from: { id: 5, first_name: "Ana" }, text: text! });
    watch(fake, notify.url, dir);
    await expect.poll(() => notify.asked(), { timeout: 10_000 }).toBe(1);
    expect(offsetIn(dir)).toBeUndefined();
    refuse = false;
    await expect.poll(() => offsetIn(dir), { timeout: 30_000 }).toBe(2);
    expect(notify.notes.some((note) => note.includes(text!))).toBe(true);
    expect(polledFrom(fake).slice(0, 2)).toEqual([0, 0]);
  }, 40_000);
});
