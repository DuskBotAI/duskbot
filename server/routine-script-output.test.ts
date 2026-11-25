import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { runCheckScript, SCRIPT_OUTPUT_MAX } from "./routine-script.ts";

const fixture = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: fixture.spawn }));

beforeEach(() => fixture.spawn.mockReset());
afterEach(() => vi.useRealTimers());

function scriptOutput(stdout: Buffer[], stderr: Buffer[] = [], code = 0) {
  fixture.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    queueMicrotask(() => {
      for (const chunk of stdout) child.stdout.write(chunk);
      for (const chunk of stderr) child.stderr.write(chunk);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit("close", code));
    });
    return child;
  });
}

const bytes = (text: string) => [...Buffer.from(text)].map((byte) => Buffer.from([byte]));
const run = () => runCheckScript("fixture-command", { sandbox: false, env: {}, timeoutMs: 1_000 });

it.each(["€", "नमस्ते", "🙂"])("preserves stdout %s split across byte boundaries", async (text) => {
  scriptOutput(bytes(text));
  expect(await run()).toEqual({ ok: true, output: text });
});

it.each(["€", "नमस्ते", "🙂"])("preserves stderr %s split across byte boundaries", async (text) => {
  scriptOutput([], bytes(text), 2);
  expect(await run()).toEqual({ ok: false, error: `The script stopped with exit code 2: ${text}` });
});

it("preserves ASCII and whole UTF-8 chunks", async () => {
  scriptOutput([Buffer.from("Report: "), Buffer.from("€12 · नमस्ते 🙂\n")]);
  expect(await run()).toEqual({ ok: true, output: "Report: €12 · नमस्ते 🙂\n" });
});

it("flushes a trailing incomplete UTF-8 sequence when stdout ends", async () => {
  scriptOutput([Buffer.from([0xe2]), Buffer.from([0x82])]);
  expect(await run()).toEqual({ ok: true, output: "�" });
});

it("keeps the stdout limit after decoding streamed text", async () => {
  scriptOutput([Buffer.from("a".repeat(SCRIPT_OUTPUT_MAX - 1)), ...bytes("€"), Buffer.from("discarded")]);
  const result = await run();
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.output.length).toBe(SCRIPT_OUTPUT_MAX);
  expect(result.output.slice(-2)).toBe("a€");
  expect(result.output).not.toContain("discarded");
});
