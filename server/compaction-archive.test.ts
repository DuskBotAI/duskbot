import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { archiveFoldedTools, archivePointer, renderToolArchive, writeToolArchive } from "./compaction-archive.ts";
import type { Message } from "./store.ts";
import { spillToolResult } from "./tool-result-spill.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("saves each folded call's result word for word, secrets masked, and points at the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "dusk-archive-"));
  dirs.push(dir);
  const secret = "sk-ant-api03-" + "b".repeat(40);
  const written = writeToolArchive(dir, "through-m42", [
    { name: "Bash", ok: true, input: '{"command": "psql -c \\"select count(*) from orders\\""}', result: " count \n-------\n 1284\n(1 row)" },
    { name: "Read", ok: false, input: "notes.md", result: `token=${secret}\n\`\`\`fence inside\`\`\`` },
    { name: "WebFetch" },
  ]);
  expect(written).toEqual({ path: join(dir, "context-archive", "through-m42.md"), count: 3 });
  const text = readFileSync(written!.path, "utf8");
  expect(text).toContain("## 1. Bash (ok)");
  expect(text).toContain(" count \n-------\n 1284\n(1 row)");
  expect(text).toContain("## 2. Read (failed)");
  expect(text).not.toContain(secret);
  expect(text).toContain("````\ntoken=");
  expect(text).toContain("## 3. WebFetch (no result recorded)\nResult: none recorded");
  expect(statSync(written!.path).mode & 0o777).toBe(0o600);
  expect(archivePointer(written!)).toBe(`- ${written!.path}: 3 tool results from before this point, word for word. Read or search it with your file tools when an exact earlier result matters.`);
});

it("writes nothing without calls and refuses a name that leaves the folder", () => {
  expect(writeToolArchive("/nonexistent", "x", [])).toBeNull();
  expect(() => writeToolArchive(tmpdir(), "../escape", [{ name: "Bash" }])).toThrow("invalid archive name");
});

it("keeps the file bounded", () => {
  const text = renderToolArchive(Array.from({ length: 80 }, (_, i) => ({ name: `call ${i}`, ok: true, result: "y".repeat(30_000) })));
  expect(text.length).toBeLessThan(1_100_000);
  expect(text).toMatch(/\[\d+ later calls did not fit in this file\]/);
});

it("archives only the calls between the last fold and this one, with the full result the harness kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "dusk-archive-"));
  dirs.push(dir);
  const spillDir = join(dir, "spill");
  spillToolResult(spillDir, "t1:turn2:call-b", "FULL RESULT of b", 100_000);
  const row = (id: string, extra: Partial<Message>) => ({ id, role: "bot", at: 0, kind: "text", ...extra }) as Message;
  const messages = [
    row("m1", { role: "user", text: "first" }),
    row("x1", { kind: "activity", turnId: "turn1", tool: { name: "Bash", itemId: "call-a", ok: true, output: "already archived" } }),
    row("m2", { text: "reply" }),
    row("m3", { role: "user", text: "second" }),
    row("x2", { kind: "activity", turnId: "turn2", tool: { name: "Read", itemId: "call-b", ok: true, output: "preview of b", fullResult: true } }),
    row("x3", { kind: "activity", turnId: "turn2", tool: { name: "context compaction started", ok: true } }),
    row("m4", { text: "reply two" }),
    row("x4", { kind: "activity", turnId: "turn3", tool: { name: "Bash", itemId: "call-c", ok: true, output: "after the fold" } }),
  ];
  const pointer = archiveFoldedTools({ botId: "b1", threadId: "t1", messages, afterId: "m2", throughId: "m4", spillDir, taskDir: dir, boxed: false });
  const path = join(dir, "context-archive", "through-m4.md");
  expect(pointer).toBe(archivePointer({ path, count: 1 }));
  const text = readFileSync(path, "utf8");
  expect(text).toContain("FULL RESULT of b");
  expect(text).not.toContain("already archived");
  expect(text).not.toContain("after the fold");
  expect(archiveFoldedTools({ botId: "b1", threadId: "t1", messages, throughId: "gone", spillDir, taskDir: dir, boxed: false })).toBeUndefined();
  // the box mounts only the working folder: a boxed chat working elsewhere gets no pointer it could not follow
  expect(archiveFoldedTools({ botId: "b1", threadId: "t1", messages, throughId: "m4", spillDir, taskDir: dir, boxed: true, cwd: "/srv/project" })).toBeUndefined();
  expect(archiveFoldedTools({ botId: "b1", threadId: "t1", messages, throughId: "m4", spillDir, taskDir: dir, boxed: true, cwd: dir })).toContain("context-archive");
  expect(archiveFoldedTools({ botId: "b1", threadId: "t1", messages, throughId: "m4", spillDir, taskDir: dir, boxed: false, cwd: "/srv/project" })).toContain("context-archive");
});
