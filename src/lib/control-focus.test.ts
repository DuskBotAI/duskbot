// Chromium matches :focus-visible on a pointer click, so styles.css shows the keyboard ring only while lib/focus-nav sets
// data-focus-nav (WCAG 2.4.7, 1.4.11).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8");

/** Cut every `@layer` block: unlayered CSS outranks Tailwind's utilities. */
function unlayered(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const start = source.indexOf("@layer", i);
    if (start === -1) return out + source.slice(i);
    out += source.slice(i, start);
    const open = source.indexOf("{", start);
    const semi = source.indexOf(";", start);
    if (semi !== -1 && semi < open) {
      i = semi + 1;
      continue;
    }
    let depth = 0;
    let j = open;
    for (; j < source.length; j++) {
      if (source[j] === "{") depth++;
      else if (source[j] === "}" && --depth === 0) break;
    }
    i = j + 1;
  }
  return out;
}

const withoutComments = unlayered(css).replace(/\/\*[\s\S]*?\*\//g, "");

const outlineRemovers = [...withoutComments.matchAll(/([^{}]+)\{([^}]*)\}/g)]
  .filter(([, , body]) => /(?:^|;)\s*outline\s*:\s*(?:none|0)\s*(?:;|$)/.test(body))
  .map(([, selector]) => selector.trim());

const CONTROLS = ["checkbox", "radio", "range", "color", "file"];

describe("keyboard focus on form controls", () => {
  it("draws no ring for the mouse", () => {
    expect(withoutComments).toMatch(/:focus-visible,[^{]*\{[^}]*outline-color:\s*transparent !important;[^}]*--tw-ring-color:\s*transparent !important/);
  });

  it("draws a focus-coloured ring on every control while someone moves with the keyboard", () => {
    const rule = /:root\[data-focus-nav\] :focus-visible\s*\{([^}]*)\}/.exec(withoutComments);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/outline:\s*2px solid var\(--color-focus\) !important;/);
  });

  it("lets nothing else take the keyboard ring off with an important outline", () => {
    const important = [...withoutComments.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter(([, , body]) => /outline(?:-style)?\s*:\s*(?:none|0)[^;]*!important/.test(body));
    expect(important.map(([, selector]) => selector.trim())).toEqual([]);
  });

  it("still takes the outline off text fields, so the composer pill stays clean", () => {
    const fieldRule = outlineRemovers.find((selector) => selector.includes("textarea"));
    expect(fieldRule).toBeDefined();
    expect(fieldRule).toContain("input");
  });

  it.each(CONTROLS)("never takes the outline off a %s input", (type) => {
    for (const selector of outlineRemovers) {
      for (const [compound] of selector.matchAll(/(?<![\w-])input(?![\w-])(?::not\((?:[^()]|\([^()]*\))*\))?/g)) {
        expect(compound, selector).toContain(`[type="${type}"]`);
      }
    }
  });
});
