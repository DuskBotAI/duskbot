import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";

// The note under Language shows only in a language other than English, so every one of them carries it.
it("every language pack says in its own words that only part of the app is translated", () => {
  const dir = new URL("./", import.meta.url);
  const packs = readdirSync(dir).filter((name) => name.endsWith(".json") && !["en.json", "source-hashes.json"].includes(name));
  const missing = packs.filter((name) => !JSON.parse(readFileSync(new URL(name, dir), "utf8"))["settings.simple.language.partial"]);
  expect(packs.length).toBeGreaterThan(10);
  expect(missing).toEqual([]);
});
