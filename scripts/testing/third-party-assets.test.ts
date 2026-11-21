// Third-party material removed from the app must not come back. third-party-asset-hashes.txt holds only SHA-1 hashes:
// of the non-code assets in Grok Bot 0.78.5's renderer and of the files that were copied from it.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SELF = ["scripts/testing/third-party-assets.test.ts", "scripts/testing/third-party-asset-hashes.txt"];
const DETECTORS = ["apps/mobile/scripts/flagged-assets.txt", "apps/mobile/scripts/release-gate.mjs", "docs/mobile-readiness.md", "scripts/testing/mobile-release-gate.test.ts"];

const REMOVED = [
  "src/assets/fonts/xvf.woff2",
  "src/assets/fonts/xvf-mono.woff2",
  "src/assets/fonts/grok-icons.woff2",
  "src/components/grok-icon-glyphs.ts",
  "src/components/GrokIcon.tsx",
  "src/styles/grok-icon.css",
  "src/assets/sounds/gallery-loop.mp3",
  "src/components/mascot-motion-engine.js",
  "src/components/mascot-motion-engine.d.ts",
  "shared/grok-bodies.ts",
  "src/components/mascot-motion-mark.ts",
  "src/components/mascot-motion-view.tsx",
  "src/components/mascot-clips.ts",
  "src/components/mascot-click.ts",
  "src/components/mascot-personality.ts",
  "src/components/mascot-optics.ts",
];

const MARKERS: Array<[RegExp, string]> = [
  [/\bXVF\b|"X VF"|\bX Mono VF\b/, "xAI's X VF type"],
  [/Grok Icons|[Cc]ursor[ -][Ii]cons/, "the Cursor Icons 16 icon font"],
  [/GROK_ICON_(OUTLINE|FILLED)|grokIconChar|grok-icon-glyphs/, "the icon-font name map"],
  [/tree-shaken out of|eager-common/, "Grok's bundled engine"],
  [/not for redistribution/i, "a third-party file marked not for redistribution"],
  [/Grok Bot's own/i, "material taken from Grok Bot"],
];

// files the mascot and look-and-feel rewrites are replacing; each entry goes once its file no longer matches
const PENDING: Record<string, string> = {
  "src/lib/motion-presets.ts": "the look and feel rewrite",
};

const TEXT = /\.(ts|tsx|js|jsx|mjs|cjs|css|html|json|md|svg|yml|yaml|txt)$/;

function files(): string[] {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
  return [...new Set(out.split("\0").filter(Boolean))].filter((file) => existsSync(ROOT + file) && !SELF.includes(file));
}

const read = (file: string) => readFileSync(ROOT + file);

describe("third-party assets stay out", () => {
  const all = files();

  it("ships no file identical to a removed third-party asset", () => {
    const banned = new Set(readFileSync(ROOT + SELF[1], "utf8").split("\n").map((line) => line.trim()).filter(Boolean));
    expect(banned.size).toBeGreaterThan(60);
    const hits = all.filter((file) => banned.has(createHash("sha1").update(read(file)).digest("hex")));
    expect(hits).toEqual([]);
  });

  it("keeps the removed files removed", () => {
    expect(REMOVED.filter((file) => existsSync(ROOT + file))).toEqual([]);
  });

  it("names none of the removed fonts, icon map or engine", () => {
    const hits: string[] = [];
    for (const file of all.filter((name) => TEXT.test(name) && !PENDING[name] && !DETECTORS.includes(name))) {
      const text = read(file).toString("utf8");
      for (const [marker, what] of MARKERS) if (marker.test(text)) hits.push(`${file}: ${what}`);
      // a name -> private-use codepoint table is an icon font's glyph map, whatever it is called
      if ((text.match(/:\s*0x[ef][0-9a-f]{3}\b/gi) ?? []).length > 20) hits.push(`${file}: an icon-font codepoint map`);
    }
    expect(hits).toEqual([]);
  });

  it("lists only pending files that still need their rewrite", () => {
    const stale = Object.keys(PENDING).filter((file) => !existsSync(ROOT + file) || !MARKERS.some(([marker]) => marker.test(read(file).toString("utf8"))));
    expect(stale).toEqual([]);
  });
});
