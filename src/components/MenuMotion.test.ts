import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// No DOM here: state is held by call order, layout effects run after each render when their deps change, and a state
// change renders again.
const react = vi.hoisted(() => {
  const slots: unknown[] = [];
  const effects: Array<{ deps: unknown[]; cleanup: void | (() => void) }> = [];
  let queued: Array<() => void> = [];
  let cursor = 0;
  let effectCursor = 0;
  let changed = false;
  return {
    reset() {
      for (const effect of effects) if (typeof effect.cleanup === "function") effect.cleanup();
      slots.length = 0;
      effects.length = 0;
    },
    render<T>(hook: () => T): T {
      let result: T;
      let passes = 0;
      do {
        if (++passes > 10) throw new Error("hook never settled");
        changed = false;
        cursor = 0;
        effectCursor = 0;
        queued = [];
        result = hook();
        for (const run of queued) run();
      } while (changed);
      return result;
    },
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (next: unknown) => {
        const value = typeof next === "function" ? (next as (current: unknown) => unknown)(slots[index]) : next;
        if (Object.is(value, slots[index])) return;
        slots[index] = value;
        changed = true;
      }];
    },
    useRef(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useLayoutEffect(effect: () => void | (() => void), deps: unknown[]) {
      const index = effectCursor++;
      const previous = effects[index];
      if (previous && deps.every((dep, at) => Object.is(dep, previous.deps[at]))) return;
      queued.push(() => {
        if (typeof previous?.cleanup === "function") previous.cleanup();
        effects[index] = { deps, cleanup: effect() };
      });
    },
    get changed() { return changed; },
  };
});
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: react.useState,
  useRef: react.useRef,
  useLayoutEffect: react.useLayoutEffect,
}));

const { MENU_MOTION_MS, useHeldMenuMotion, useMenuMotion } = await import("./MenuMotion");

let reduced = false;
beforeEach(() => {
  vi.useFakeTimers();
  reduced = false;
  vi.stubGlobal("window", {
    setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    matchMedia: () => ({ matches: reduced }),
  });
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
});
afterEach(() => {
  react.reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("menu motion", () => {
  it("shows a menu on the render it opens and pops it in", () => {
    expect(react.render(() => useMenuMotion(false))).toMatchObject({ shown: false, closing: false });
    const open = react.render(() => useMenuMotion(true));
    expect(open).toMatchObject({ shown: true, closing: false, className: "animate-pop-in", exitProps: {} });
  });

  it("keeps a closing menu on screen for the pop, but out of reach and out of the accessibility tree", () => {
    react.render(() => useMenuMotion(true));
    const closing = react.render(() => useMenuMotion(false));
    expect(closing.shown).toBe(true);
    expect(closing.closing).toBe(true);
    expect(closing.className).toBe("animate-pop-out pointer-events-none");
    expect(closing.exitProps).toEqual({ inert: true, "aria-hidden": true });
    vi.advanceTimersByTime(MENU_MOTION_MS - 1);
    expect(react.render(() => useMenuMotion(false)).shown).toBe(true);
    vi.advanceTimersByTime(1);
    expect(react.changed).toBe(true);
    expect(react.render(() => useMenuMotion(false))).toMatchObject({ shown: false, closing: false, exitProps: {} });
  });

  it("closes at once under reduced motion", () => {
    reduced = true;
    react.render(() => useMenuMotion(true));
    expect(react.render(() => useMenuMotion(false))).toMatchObject({ shown: false, closing: false, exitProps: {} });
  });

  it("reopens a menu that is still closing as a live menu", () => {
    react.render(() => useMenuMotion(true));
    react.render(() => useMenuMotion(false));
    const reopened = react.render(() => useMenuMotion(true));
    expect(reopened).toMatchObject({ shown: true, closing: false, className: "animate-pop-in", exitProps: {} });
    vi.advanceTimersByTime(MENU_MOTION_MS * 2);
    expect(react.render(() => useMenuMotion(true)).shown).toBe(true);
  });

  it("holds the last payload while a positioned menu closes", () => {
    const anchor = { x: 10, y: 20 };
    react.render(() => useHeldMenuMotion(anchor));
    const closing = react.render(() => useHeldMenuMotion<typeof anchor>(null));
    expect(closing).toMatchObject({ shown: true, closing: true, value: anchor });
    expect(closing.exitProps).toEqual({ inert: true, "aria-hidden": true });
  });
});

// the hook's classes only move a menu while overlays.css animates them; a "raw" rewrite once set both to nothing
describe("the menu motion in overlays.css", () => {
  const css = readFileSync(new URL("../styles/overlays.css", import.meta.url), "utf8");
  const anchored = ':is([role="menu"], [role="listbox"], .popover-surface, .menu-surface, [role="dialog"]:not([aria-modal="true"], .ui-modal, .ui-dialog))';
  const rule = (selector: string) => css.match(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m"))?.[1] ?? "";

  it("grows a menu in from .97 toward its trigger and shrinks it out", () => {
    expect(rule(`${anchored}.animate-pop-in`)).toMatch(/transition:\s*opacity calc\(120ms \* var\(--motion-scale, 1\)\) var\(--motion-ease-out, var\(--ease-menu-in\)\), transform calc\(120ms \* var\(--motion-scale, 1\)\) var\(--motion-ease-out, var\(--ease-menu-in\)\)/);
    expect(css).toMatch(/@starting-style \{\s*:is\(\[role="menu"\][^{]*\.animate-pop-in \{ opacity: 0; transform: translate3d\(0, calc\(var\(--menu-shift, -4px\)\), 0\) scale\(0\.97\); \}/);
    const out = rule(`${anchored}.animate-pop-out`);
    expect(out).toMatch(/opacity: 0;\s*transform: translate3d\(0, calc\(var\(--menu-shift, -4px\) \/ 2\), 0\) scale\(0\.98\);/);
    expect(out).toMatch(/transition:\s*opacity calc\(80ms \* var\(--motion-scale, 1\)\) var\(--motion-ease-out, var\(--ease-out-bencho\)\), transform calc\(80ms \* var\(--motion-scale, 1\)\) var\(--motion-ease-out, var\(--ease-out-bencho\)\)/);
    expect(css).toMatch(/--ease-menu-in: cubic-bezier\(0\.16, 1, 0\.3, 1\);/);
  });

  // a keyframe starts over from its first frame when the class flips back; a transition turns around where it is
  it("turns a menu opened again mid-close back from where it is, on every anchored surface", () => {
    for (const selector of [`${anchored}.animate-pop-in`, `${anchored}.animate-pop-out`, '[role="dialog"][data-model-picker-content].animate-pop-in',
      '[role="dialog"][data-model-picker-content].animate-pop-out', '[role="menu"][data-sidebar-popover-menu].animate-pop-in', '[role="menu"][data-sidebar-popover-menu].animate-pop-out']) {
      expect(rule(selector), selector).toMatch(/transition/);
      expect(rule(selector), selector).not.toMatch(/animation/);
    }
  });

  // a running keyframe wins over a transition on the same property: left on, the utilities' general pop plays instead
  it("moves every anchored surface on its own transitions, with the general pop keyframe off", () => {
    expect(rule(`${anchored}:is(.animate-pop-in, .animate-pop-out)`)).toMatch(/^\s*animation:\s*none;\s*$/);
    expect(rule(`${anchored}.animate-pop-in`)).toMatch(/transition:\s*opacity/);
    expect(rule(`${anchored}.animate-pop-out`)).toMatch(/transition:\s*opacity/);
    expect(MENU_MOTION_MS).toBeGreaterThanOrEqual(80);
  });

  it("fades instead of moving under reduced motion", () => {
    const reducedBlock = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reducedBlock).toMatch(/:is\(\.animate-pop-in, \.animate-pop-out\) \{\s*transform: none;\s*transition: opacity var\(--overlay-fast\) ease-out;/);
    expect(reducedBlock).toMatch(/@starting-style \{\s*:is\([^{]*\.animate-pop-in \{ transform: none; \}/);
  });
});
