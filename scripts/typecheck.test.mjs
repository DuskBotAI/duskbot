import { describe, expect, it } from "vitest";
import { HEAP_MB, STEPS, nodeOptionsFor, typecheck } from "./typecheck.mjs";

describe("the typecheck runner", () => {
  it("gives tsc the heap the server project needs", () => {
    expect(nodeOptionsFor("")).toBe(`--max-old-space-size=${HEAP_MB}`);
    expect(nodeOptionsFor("--inspect")).toBe(`--max-old-space-size=${HEAP_MB} --inspect`);
  });

  it("keeps a bigger heap the caller asked for", () => {
    expect(nodeOptionsFor("--max-old-space-size=8192")).toBe("--max-old-space-size=8192");
    expect(nodeOptionsFor("--max-old-space-size=8192 --inspect")).toBe("--max-old-space-size=8192 --inspect");
  });

  it("runs both passes, in order, with that heap", () => {
    const spawned = [];
    const status = typecheck({ env: {}, spawn: (file, args, options) => (spawned.push({ file, args, options }), { status: 0 }) });
    expect(status).toBe(0);
    expect(spawned.map((call) => call.args.slice(1))).toEqual(STEPS);
    expect(spawned.every((call) => call.options.env.NODE_OPTIONS === `--max-old-space-size=${HEAP_MB}`)).toBe(true);
    expect(spawned.every((call) => call.args[0].endsWith(`bin${process.platform === "win32" ? "\\" : "/"}tsc`))).toBe(true);
  });

  it("stops at the first failing pass and returns its status", () => {
    const spawned = [];
    const status = typecheck({ env: {}, spawn: (file, args) => (spawned.push(args), { status: 2 }) });
    expect(status).toBe(2);
    expect(spawned).toHaveLength(1);
  });
});
