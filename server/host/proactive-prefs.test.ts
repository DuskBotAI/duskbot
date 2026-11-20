import { describe, expect, it } from "vitest";

import { createProactivePrefs, isQuiet, neverAbout, outsideQuiet, parsePrefs, prefsBlock, renderPrefs, withRule } from "./proactive-prefs.ts";

describe("What to tell me about", () => {
  it("reads and writes the three sections, hand edits included", () => {
    const prefs = parsePrefs("# notes\n## Tell me about\n- Big client emails\n## Never tell me about\n* crypto\n## Quiet hours\n- 22 to 7:30\n");
    expect(prefs).toEqual({ tell: ["Big client emails"], never: ["crypto"], quiet: { from: "22:00", to: "07:30" } });
    expect(parsePrefs(renderPrefs(prefs))).toEqual(prefs);
    expect(renderPrefs(prefs)).toContain("title: What to tell me about");
  });

  it("lets the newest word win between tell and never", () => {
    const never = withRule({ tell: ["Crypto"], never: [], quiet: null }, "never", "crypto")!;
    expect(never).toEqual({ tell: [], never: ["crypto"], quiet: null });
    expect(withRule(never, "tell", "Crypto")).toEqual({ tell: ["Crypto"], never: [], quiet: null });
    expect(withRule(never, "quiet", "whenever")).toBeNull();
  });

  it("knows quiet hours across midnight and narrows the waking window", () => {
    const quiet = { from: "21:30", to: "08:00" };
    expect(isQuiet(quiet, 22 * 60)).toBe(true);
    expect(isQuiet(quiet, 7 * 60)).toBe(true);
    expect(isQuiet(quiet, 12 * 60)).toBe(false);
    expect(outsideQuiet({ start: "07:00", end: "23:00" }, quiet)).toEqual({ start: "08:00", end: "21:30" });
    expect(outsideQuiet(null, quiet)).toEqual({ start: "08:00", end: "21:30" });
    expect(outsideQuiet({ start: "07:00", end: "23:00" }, null)).toEqual({ start: "07:00", end: "23:00" });
  });

  it("matches a never line by its words", () => {
    const prefs = { tell: [], never: ["crypto prices"], quiet: null };
    expect(neverAbout(prefs, "Crypto: prices are up 5%")).toBe("crypto prices");
    expect(neverAbout(prefs, "Stock prices")).toBeNull();
    expect(prefsBlock({ tell: [], never: [], quiet: null })).toBe("");
    expect(prefsBlock(prefs)).toContain("Never: crypto prices");
  });

  it("saves a rule in the owner's file once, and nothing without an owner", () => {
    const files = new Map<string, string>();
    const writes: string[] = [];
    let owner: { id: string } | null = { id: "dusk" };
    const store = createProactivePrefs({ owner: () => owner, read: (id) => files.get(id) ?? null, write: (id, _before, after, actor) => { files.set(id, after); writes.push(actor); } });
    expect(store.rule("never", "crypto")).toBe("saved");
    expect(store.rule("never", "Crypto")).toBe("known");
    expect(store.rule("quiet", "21:30 to 08:00", "person")).toBe("saved");
    expect(writes).toEqual(["bot", "person"]);
    expect(store.get()).toEqual({ tell: [], never: ["crypto"], quiet: { from: "21:30", to: "08:00" } });
    owner = null;
    expect(store.rule("tell", "x")).toBeNull();
    expect(store.block()).toBe("");
  });
});
