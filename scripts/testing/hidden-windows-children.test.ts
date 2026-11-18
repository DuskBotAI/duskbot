import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const STARTED_FROM_A_WINDOWLESS_PROCESS = [
  "server/mcp-bridge.ts",
  "server/container-computer.ts",
  "server/local-vm-profiles.ts",
  "electron/cua.mjs",
];
const STARTS_A_CHILD = /(?<![.\w])(?:spawn|spawnSync|execFile|execFileSync|execFileAsync|run)\(/gu;
const POSIX_ONLY_BINARY = /^\w+\(\s*"\/(?:usr|bin)\//u;

function childStarts(source: string): string[] {
  const calls: string[] = [];
  for (const match of source.matchAll(STARTS_A_CHILD)) {
    if (/function\s+$/u.test(source.slice(0, match.index))) continue;
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (; end < source.length; end++) {
      if (source[end] === "(") depth++;
      else if (source[end] === ")" && --depth === 0) break;
    }
    calls.push(source.slice(match.index, end + 1));
  }
  return calls;
}

describe("children of the windowless desktop app", () => {
  it.each(STARTED_FROM_A_WINDOWLESS_PROCESS)("%s starts every child hidden on Windows", (file) => {
    const starts = childStarts(readFileSync(join(ROOT, file), "utf8")).filter((call) => !POSIX_ONLY_BINARY.test(call));
    expect(starts.length).toBeGreaterThan(0);
    expect(starts.filter((call) => !call.includes("windowsHide: true"))).toEqual([]);
  });

  it("reads a call's whole argument list, nested calls included", () => {
    expect(childStarts('const a = spawn(cmd, args(1), { stdio: "pipe" });\nawait run("/usr/bin/diff", []);'))
      .toEqual(['spawn(cmd, args(1), { stdio: "pipe" })', 'run("/usr/bin/diff", [])']);
  });
});
