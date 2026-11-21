// config.json is the settings file people edit by hand. A good read leaves a copy beside it; a read that fails starts
// from that copy (or the defaults) and leaves the broken file as it is, for the person to fix.
import { readFileSync } from "node:fs";
import { z } from "zod";

import { writeFileAtomicIfChanged } from "./atomic.ts";
import { lastGoodPath } from "./registry-file.ts";
import { parseJson, type JsonObject, type JsonValue } from "./schema.ts";
import { settledFileCache } from "./settled-file.ts";

/** config.json could not be read: `lastGood` says whether its last good copy is in use; otherwise the defaults are. */
export interface ConfigFileProblem { file: "config.json"; reason: string; lastGood: boolean }

/** JSON.parse errors can quote the input; a credential must never reach the log or the app, so only the place is kept. */
export function unreadableConfigReason(error: unknown): string {
  if (error instanceof SyntaxError) {
    const at = /\(line (\d+) column (\d+)\)/.exec(error.message);
    return at ? `invalid JSON at line ${at[1]}, column ${at[2]}` : "invalid JSON";
  }
  return error instanceof Error ? error.message : "unable to read configuration";
}

const jsonObjectSchema = z.record(z.string(), z.json());

function readObject(file: string): JsonObject | "missing" | "unreadable" {
  try {
    const parsed = jsonObjectSchema.safeParse(parseJson(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : "unreadable";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
}

export function configFile<T>(path: () => string, parse: (value: JsonValue) => T) {
  const keepLastGood = (text: string) => {
    try {
      writeFileAtomicIfChanged(lastGoodPath(path()), text, { mode: 0o600 });
    } catch (error) {
      console.error(`[config] could not keep a copy of config.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const stored = settledFileCache(path, () => {
    const text = readFileSync(path(), "utf8");
    const value = parse(parseJson(text));
    keepLastGood(text);
    return value;
  });
  const lastGood = settledFileCache(() => lastGoodPath(path()), () => parse(parseJson(readFileSync(lastGoodPath(path()), "utf8"))));
  const accepts = (value: JsonObject) => {
    try { parse(value); return true; } catch { return false; }
  };
  let problem: ConfigFileProblem | null = null;
  let lastWarning = "";

  return {
    /** The settings in use: the file's, its last good copy's while it cannot be read, or undefined for the defaults. */
    read(): T | undefined {
      try {
        const value = stored.read();
        problem = null;
        lastWarning = "";
        return value;
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
          problem = null;
          lastWarning = "";
          return undefined;
        }
        let copy: T | undefined;
        try { copy = lastGood.read(); } catch { copy = undefined; }
        problem = { file: "config.json", reason: unreadableConfigReason(error), lastGood: copy !== undefined };
        const warning = `config: ${path()} could not be read (${problem.reason}); left it as it is and ${copy !== undefined ? `using its last good copy, ${lastGoodPath(path())}` : "using defaults"}`;
        if (warning !== lastWarning) console.warn(warning);
        lastWarning = warning;
        return copy;
      }
    },
    problem: (): ConfigFileProblem | null => problem,
    /** Where a save goes and what it starts from: a broken config.json is never written over, its last good copy is. */
    saveTarget(): { file: string; disk: JsonObject } {
      const current = readObject(path());
      if (current === "missing") return { file: path(), disk: {} };
      if (current !== "unreadable" && accepts(current)) return { file: path(), disk: current };
      const copy = readObject(lastGoodPath(path()));
      return { file: lastGoodPath(path()), disk: typeof copy === "object" ? copy : {} };
    },
    forget(): void {
      stored.forget();
      lastGood.forget();
    },
  };
}
