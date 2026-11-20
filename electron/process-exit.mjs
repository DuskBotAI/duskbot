import { scrubText } from "./error-report.mjs";

// NTSTATUS and C runtime codes a crashed Windows process exits with (winnt.h / ntstatus.h)
const WINDOWS_CODES = new Map([
  [0xC0000005, "access violation"], [0xC0000409, "fail-fast"], [0xC00000FD, "stack overflow"], [0xC0000374, "heap corruption"],
  [0xC000001D, "illegal instruction"], [0xC0000135, "dll not found"], [0xC0000142, "dll init failed"], [0x80000003, "breakpoint"],
  [0xE06D7363, "c++ exception"], [0xC0000017, "no memory"], [0xC0000420, "assertion failure"],
]);

/** An exit code as Windows people and tools name it (Electron sign-extends the 32-bit code: -36861 is 0xFFFF7003). */
export function exitCodeText(code, platform = process.platform) {
  if (!Number.isInteger(code)) return "none";
  if (platform !== "win32" || (code >= 0 && code < 256)) return String(code);
  const unsigned = code >>> 0;
  const hex = `0x${unsigned.toString(16).toUpperCase().padStart(8, "0")}`;
  const known = WINDOWS_CODES.get(unsigned);
  return known ? `${hex} ${known}` : `${code} ${hex}`;
}

/** A process name as one analytics word: "Network Service" is network_service. */
export function serviceWord(name) {
  const slug = String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return slug || null;
}

const PROBLEM = /\b(error|fatal|abort(ed)?|panic|exception|assert(ion)?|segmentation|terminat(e|ing)|mutex|out of memory|oom)\b/i;

/** The last lines a child wrote to stderr; problem() is the latest that names a failure, scrubbed and short. */
export function createStderrTail(limit = 40) {
  const lines = [];
  return {
    push(chunk) {
      for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) lines.push(line);
      if (lines.length > limit) lines.splice(0, lines.length - limit);
    },
    problem() {
      for (let i = lines.length - 1; i >= 0; i--) if (PROBLEM.test(lines[i])) return scrubText(lines[i]).slice(0, 160);
      return null;
    },
  };
}
