// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/testing/quiet-canceled-animations";

import { phraseAt, phraseHoldMs, rotationHoldMs } from "@/lib/live-activity";
import { LONG_TURN_MS, STATUS_HOLD_MS, STATUS_QUIET_MS, TurnPresence, WORD_DWELL_MS, WORD_SWAP } from "./TurnPresence";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const thinking = ["Thinking", "Mulling it over", "Piecing it together", "Chipping away"];
const seed = "bot:thread:1";

let host: HTMLDivElement;
let root: Root;

function render(props: Record<string, unknown>) {
  act(() => root.render(createElement(TurnPresence, { avatar: null, visible: true, seed, since: null, ...props })));
}

const visibleText = () =>
  Array.from(host.querySelectorAll(".thinking-shimmer:not([aria-hidden])")).map((node) => node.textContent);

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("TurnPresence phrases", () => {
  it("holds each phrase for its seeded 4 to 6 seconds, then moves on", () => {
    render({ phrases: thinking, phase: "think" });
    expect(visibleText()).toEqual(["Thinking"]);
    const hold = phraseHoldMs(`${seed}|think`, 0);
    act(() => void vi.advanceTimersByTime(hold - 1));
    expect(visibleText()).toEqual(["Thinking"]);
    act(() => void vi.advanceTimersByTime(1));
    expect(visibleText()).toEqual([phraseAt(thinking, `${seed}|think`, 1)]);
  });

  it("swaps one phrase for the next and never draws two at once", () => {
    // The fading old phrase sat out of flow: a longer one drew over the size beside it ("Piecing it together" over "· 2 KB").
    render({ label: "Working", phrases: thinking, phase: "think", since: Date.now(), size: "2 KB" });
    act(() => void vi.advanceTimersByTime(phraseHoldMs(`${seed}|think`, 0)));
    const drawn = () => Array.from(host.querySelectorAll("[data-turn-now] .thinking-shimmer")).map((node) => node.textContent);
    expect(drawn()).toEqual([phraseAt(thinking, `${seed}|think`, 1)]);
    expect(host.querySelector(".turn-phrase-in")).not.toBeNull();
    act(() => void vi.advanceTimersByTime(320));
    expect(drawn()).toEqual([phraseAt(thinking, `${seed}|think`, 1)]);
  });

  it("starts a new step at its plain label", () => {
    render({ phrases: thinking, phase: "think" });
    act(() => void vi.advanceTimersByTime(phraseHoldMs(`${seed}|think`, 0)));
    render({ phrases: ["Searching the web", "Looking it up"], phase: "web" });
    expect(visibleText()).toEqual(["Searching the web"]);
  });

  it("starts a returning phase over, even after a step too short to swap", () => {
    render({ phrases: thinking, phase: "think" });
    act(() => void vi.advanceTimersByTime(phraseHoldMs(`${seed}|think`, 0)));
    expect(visibleText()).not.toEqual(["Thinking"]);
    render({ phrases: ["Reading a file", "Reading through"], phase: "read" });
    act(() => void vi.advanceTimersByTime(1000));
    render({ phrases: thinking, phase: "think" });
    expect(visibleText()).toEqual(["Thinking"]);
  });

  it("keeps a single phrase steady", () => {
    render({ phrases: ["Running the test suite"], phase: "spoken" });
    act(() => void vi.advanceTimersByTime(60_000));
    expect(visibleText()).toEqual(["Running the test suite"]);
    expect(host.querySelector(".turn-phrase-out")).toBeNull();
  });

  it("still takes a plain label, as the sidebar-era callers pass", () => {
    const markup = renderToStaticMarkup(createElement(TurnPresence, { avatar: null, visible: true, label: "Running a command", since: 1 }));
    expect(markup).toContain("Running a command");
    expect(markup).toContain("thinking-shimmer");
  });
});

describe("the status line", () => {
  const line = () => {
    const shown = host.querySelector("[data-turn-status]");
    return shown?.textContent?.replace(/\s+/g, " ").trim();
  };

  it("reads Working, what is happening now and how much is written, and never counts seconds", () => {
    vi.setSystemTime(100_000);
    render({ label: "Working", since: 28_000, phrases: ["Writing index.html"], phase: "live:w", size: "14 KB" });
    expect(line()).toBe("Working · Writing index.html · 14 KB");
    expect(visibleText(), "the live part shimmers, the lead does not").toEqual(["Writing index.html"]);
  });

  it("is the lead alone when nothing is reported, and the lead shimmers", () => {
    vi.setSystemTime(100_000);
    render({ label: "Working", since: 88_000 });
    expect(line()).toBe("Working");
    expect(visibleText()).toEqual(["Working"]);
    expect(host.querySelector("[data-turn-size]")).toBeNull();
  });

  it("fades the first phrase in from nothing, never from the lead", () => {
    render({ label: "Working", since: null });
    render({ label: "Working", since: null, phrases: ["Thinking"], phase: "think" });
    expect(host.querySelector(".turn-phrase-out")).toBeNull();
    expect(line()).toBe("Working · Thinking");
  });
});

describe("a long step's quiet part", () => {
  const line = () => host.querySelector("[data-turn-status]")?.textContent?.replace(/\s+/g, " ").trim();

  it("follows the step with how it is doing, and counts the time since its last output on its own", () => {
    vi.setSystemTime(1_000_000);
    render({ label: "Working", since: 1_000_000 - 72_000, phrases: ["Running scrape.py"], phase: "step", hover: "python3 scrape.py --pages 40", quiet: { kind: "busy" } });
    expect(line()).toBe("Working · Running scrape.py · Busy, no output yet");
    expect(host.querySelector("[data-turn-now]")?.getAttribute("title")).toBe("python3 scrape.py --pages 40");
    render({ label: "Working", since: 1_000_000 - 72_000, phrases: ["Running scrape.py"], phase: "step", quiet: { kind: "output", at: 1_000_000 - 30_000 } });
    expect(host.querySelector("[data-turn-quiet]")?.textContent).toBe("Last output just now");
    act(() => void vi.advanceTimersByTime(45_000));
    expect(host.querySelector("[data-turn-quiet]")?.textContent).toBe("Last output 1 min ago");
  });

  it("says it in Simple mode too, after the one phrase", () => {
    render({ simple: true, phrases: ["Running scrape.py"], phase: "step", quiet: { kind: "network" } });
    expect(line() ?? "", "the mark comes alone first, as grok's does").toBe("");
    act(() => void vi.advanceTimersByTime(STATUS_QUIET_MS.max));
    expect(line()).toBe("Running scrape.py · Waiting on the network");
  });
});

/** What the line says now: a word still blurring out is the old one, not part of it. */
const saying = () => {
  const shown = host.querySelector("[data-turn-status]")?.cloneNode(true) as HTMLElement | undefined;
  shown?.querySelectorAll("[data-word-out]").forEach((word) => word.remove());
  return shown?.textContent?.replace(/\s+/g, " ").trim() ?? "";
};

describe("Simple mode's rotating words", () => {
  const line = saying;
  const pool = Array.from({ length: 12 }, (_, index) => `Word ${index}`);

  it("shows the mark alone first, then one word, and only a long turn moves on, 7.9 to 9.9 s apart, never the same word twice in a row", () => {
    vi.setSystemTime(10_000);
    render({ simple: true, since: 10_000, phrases: pool, phase: "friendly:generic" });
    expect(line(), "the mascot alone for a beat").toBe("");
    act(() => void vi.advanceTimersByTime(STATUS_QUIET_MS.max));
    const said: Array<{ word: string; at: number }> = [{ word: line(), at: Date.now() }];
    while (Date.now() < 10_000 + 60_000) {
      act(() => void vi.advanceTimersByTime(100));
      if (line() !== said.at(-1)!.word) said.push({ word: line(), at: Date.now() });
    }
    expect(said[0]!.word, "it opens with the pool's first word").toBe("Word 0");
    expect(said[1]!.at - 10_000, "nothing else until the turn is long").toBeGreaterThanOrEqual(LONG_TURN_MS);
    expect(said.length, "a minute says a handful of words").toBeGreaterThanOrEqual(5);
    for (let i = 2; i < said.length; i++) expect(said[i]!.at - said[i - 1]!.at, `gap ${i}`).toBeGreaterThanOrEqual(WORD_SWAP.duration + 7000);
    for (let i = 1; i < said.length; i++) expect(said[i]!.word, `word ${i}`).not.toBe(said[i - 1]!.word);
    for (const { word } of said) expect(pool).toContain(word);
    expect(host.querySelector("[data-turn-now]")?.classList, "a later word crossfades in place, it does not rise").not.toContain("turn-label-in");
  });

  it("says one phrase through a short turn, whatever its steps", () => {
    vi.setSystemTime(10_000);
    render({ simple: true, since: 10_000, phrases: ["Running a command"], phase: "friendly:commands", wordsAtOnce: true });
    const said = new Set([line()]);
    for (const [phrase, phase] of [["Reading files", "friendly:files"], ["Writing", "friendly:chat.typing"], ["Searching", "friendly:web"], ["Writing", "friendly:chat.typing"]]) {
      act(() => void vi.advanceTimersByTime(1_100));
      render({ simple: true, since: 10_000, phrases: [phrase], phase, wordsAtOnce: true });
      said.add(line());
    }
    expect(Date.now() - 10_000).toBeLessThan(6_000);
    expect([...said]).toEqual(["Thinking"]);
  });

  it("never changes its words for a step in the same coarse group", () => {
    vi.setSystemTime(10_000);
    render({ simple: true, since: 0, phrases: ["Reading files"], phase: "friendly:files" });
    for (const [phrase, phase] of [["Searching", "friendly:web"], ["Opening a page", "friendly:page"], ["Clicking", "friendly:clicking"], ["Reading files", "friendly:files"]]) {
      act(() => void vi.advanceTimersByTime(STATUS_HOLD_MS + 1_000));
      render({ simple: true, since: 0, phrases: [phrase], phase });
      expect(line(), phase).toBe("Reading files");
    }
    act(() => void vi.advanceTimersByTime(STATUS_HOLD_MS));
    render({ simple: true, since: 0, phrases: ["Running a command"], phase: "friendly:commands" });
    expect(line(), "working on it is a new group").toBe("Running a command");
  });

  it("holds a word for its swap and its seeded time before the next", () => {
    vi.setSystemTime(10_000);
    render({ simple: true, since: 0, phrases: pool, phase: "friendly:generic" });
    const first = line();
    act(() => void vi.advanceTimersByTime(WORD_SWAP.duration + rotationHoldMs(`${seed}|friendly:generic`, 0) - 1));
    expect(line()).toBe(first);
    act(() => void vi.advanceTimersByTime(1));
    expect(line()).not.toBe(first);
  });

  it("opens with Thinking, then a step's own words, and the bot's own words beat the generic pool at once", () => {
    vi.setSystemTime(10_000);
    render({ simple: true, since: 10_000 - STATUS_QUIET_MS.max, phrases: ["Running a command"], phase: "friendly:commands" });
    expect(line(), "every turn opens with Thinking").toBe("Thinking");
    act(() => void vi.advanceTimersByTime(STATUS_HOLD_MS));
    expect(line(), "the step's word beats the generic one").toBe("Running a command");
    render({ simple: true, since: 0, phrases: pool, phase: "friendly:generic" });
    act(() => void vi.advanceTimersByTime(STATUS_HOLD_MS));
    expect(pool).toContain(line());
    render({ simple: true, since: 0, label: "Comparing standing desks", phrases: pool, phase: "friendly:generic" });
    act(() => void vi.advanceTimersByTime(STATUS_HOLD_MS));
    expect(line()).toBe("Comparing standing desks");
    act(() => void vi.advanceTimersByTime(30_000));
    expect(line(), "one specific phrase stays put").toBe("Comparing standing desks");
  });

  it("says Writing at once while the reply is written, then Wrapping up", () => {
    vi.setSystemTime(10_000);
    render({ simple: true, since: 0, phrases: ["Writing", "Wrapping up"], phase: "friendly:chat.typing" });
    expect(line()).toBe("Writing");
    act(() => void vi.advanceTimersByTime(WORD_SWAP.duration + 9000));
    expect(line()).toBe("Wrapping up");
  });

  it("keeps each step's words readable 5 s past their swap however fast the steps come, then says only the newest", () => {
    vi.setSystemTime(10_000);
    render({ simple: true, since: 0, phrases: ["Running a command"], phase: "friendly:commands" });
    expect(STATUS_HOLD_MS).toBe(WORD_SWAP.duration + WORD_DWELL_MS);
    expect(WORD_DWELL_MS).toBeGreaterThanOrEqual(5000);
    const said = [line()];
    for (const [phrase, phase] of [["Reading files", "friendly:files"], ["Searching", "friendly:web"], ["Opening a page", "friendly:page"]]) {
      act(() => void vi.advanceTimersByTime(700));
      render({ simple: true, since: 0, phrases: [phrase], phase });
      said.push(line());
    }
    expect(said, "steps 0.7 s apart change nothing before the hold ends").toEqual(["Running a command", "Running a command", "Running a command", "Running a command"]);
    act(() => void vi.advanceTimersByTime(STATUS_HOLD_MS - 2100));
    expect(line(), "the newest step, the two between never said").toBe("Opening a page");
  });

  it("keeps fun words out of a short turn and mixes them into a long one, never one word twice in a row", () => {
    const normal = ["Thinking", "Working", "On it", "Getting it done", "Figuring it out", "Almost there"];
    const fun = ["Noodling", "Percolating", "Brewing", "Tinkering", "Stargazing", "Scheming"];
    vi.setSystemTime(10_000);
    render({ simple: true, since: 10_000, phrases: normal, fun, phase: "friendly:generic" });
    act(() => void vi.advanceTimersByTime(STATUS_QUIET_MS.max));
    const said = [line()];
    while (Date.now() < 10_000 + 120_000) {
      act(() => void vi.advanceTimersByTime(500));
      if (line() !== said.at(-1)) said.push(line());
    }
    expect(said[0]).toBe("Thinking");
    const early = said.slice(0, 2);
    expect(early.every((word) => normal.includes(word)), `first 20 s: ${early.join(", ")}`).toBe(true);
    expect(said.some((word) => fun.includes(word)), "a two minute turn says some fun words").toBe(true);
    expect(said.filter((word) => normal.includes(word)).length, "plain words still lead overall").toBeGreaterThan(said.filter((word) => fun.includes(word)).length);
  });
});

describe("the working line swapping words", () => {
  type Run = { el: HTMLElement; keyframes: Keyframe[]; options: KeyframeAnimationOptions; onfinish: (() => void) | null };
  let runs: Run[] = [];
  const reduce = (on: boolean) => vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: on && query.includes("reduce"), media: query, addEventListener: () => {}, removeEventListener: () => {},
  }) as unknown as MediaQueryList);
  const words = () => [...host.querySelectorAll<HTMLElement>("[data-turn-status] .status-shimmer")];
  /** The line says "Running a command", then a step later "Writing the reply". */
  const swap = () => {
    vi.setSystemTime(10_000);
    render({ simple: true, since: 10_000, phrases: ["Running a command"], phase: "step" });
    act(() => void vi.advanceTimersByTime(STATUS_QUIET_MS.max));
    render({ simple: true, since: 10_000, phrases: ["Writing the reply"], phase: "write" });
    act(() => void vi.advanceTimersByTime(STATUS_HOLD_MS));
  };

  beforeEach(() => {
    runs = [];
    vi.spyOn(HTMLElement.prototype, "animate").mockImplementation(function (this: HTMLElement, keyframes, options) {
      const run: Run = { el: this, keyframes: keyframes as Keyframe[], options: options as KeyframeAnimationOptions, onfinish: null };
      runs.push(run);
      return Object.assign(run, { cancel: () => {} }) as unknown as Animation;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("never counts seconds, on the line or in its tooltip", () => {
    reduce(false);
    vi.setSystemTime(100_000);
    render({ simple: true, since: 100_000 - 8_000, phrases: ["Running a command"], phase: "step" });
    act(() => void vi.advanceTimersByTime(STATUS_QUIET_MS.max + 61_000));
    expect(saying()).toBe("Running a command");
    const row = host.querySelector<HTMLElement>("[data-turn-status]")!.closest("[title]");
    expect(row?.getAttribute("title") ?? "").not.toMatch(/\d+\s*s\b|\dm\b/);
    expect(host.textContent).not.toMatch(/·\s*\d+\s*(s|m)\b/);
  });

  it("keeps the old and the new words mounted in one cell while they crossfade, with no blur, then drops the old", () => {
    reduce(false);
    swap();
    const [out, into] = words().map((word) => word.parentElement!);
    expect(words().map((word) => word.textContent)).toEqual(["Running a command", "Writing the reply"]);
    expect(out!.hasAttribute("data-word-out") && out!.getAttribute("aria-hidden")).toBe("true");
    expect(into!.hasAttribute("data-word-in")).toBe(true);
    expect(out!.parentElement, "both words share one grid cell").toBe(into!.parentElement);
    for (const word of [out!, into!]) expect(word.className).toContain("[grid-area:1/1]");
    const fadeOut = runs.find((run) => run.el === out)!;
    const fadeIn = runs.find((run) => run.el === into)!;
    expect(fadeOut.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    expect(fadeIn.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    for (const run of [fadeOut, fadeIn]) expect(run.options).toMatchObject({ duration: 880, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
    expect(into!.classList, "no rise on a swap").not.toContain("turn-label-in");
    act(() => fadeOut.onfinish!());
    expect(words().map((word) => word.textContent)).toEqual(["Writing the reply"]);
    expect(host.querySelector("[data-word-out], [data-word-in]")).toBeNull();
  });

  it("swaps at once under reduced motion, with no blur and nothing left behind", () => {
    reduce(true);
    swap();
    expect(words().map((word) => word.textContent)).toEqual(["Writing the reply"]);
    expect(runs.some((run) => run.keyframes.some((frame) => "filter" in frame))).toBe(false);
  });
});

describe("the Now card", () => {
  const toggle = () => host.querySelector<HTMLButtonElement>("button[aria-expanded]");
  const card = () => host.querySelector("[role=region]");
  const open = (extra: Record<string, unknown> = {}) =>
    render({ label: "Working", since: Date.now(), phrases: ["Running scrape.py"], phase: "step", card: createElement("p", null, "steps"), cardLabel: "What Ledger is doing", ...extra });

  it("is one calm line by default; a click unfolds the card under it and another folds it", () => {
    open();
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(toggle()?.getAttribute("aria-label")).toBe("What Ledger is doing");
    expect(card()).toBeNull();
    act(() => toggle()!.click());
    expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(card()?.textContent).toBe("steps");
    expect(toggle()?.getAttribute("aria-controls")).toBe(card()?.id);
    act(() => toggle()!.click());
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(card()).toBeNull();
  });

  it("folds on Escape and gives focus back to the line", () => {
    open();
    act(() => toggle()!.click());
    toggle()!.focus();
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(toggle());
  });

  it("leaves Escape to whatever else has the focus", () => {
    const field = document.createElement("textarea");
    document.body.append(field);
    open();
    act(() => toggle()!.click());
    field.focus();
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(card()).not.toBeNull();
    field.remove();
  });

  it("is a plain line with nothing to show, in Simple mode a button as well, and folds when the turn ends", () => {
    render({ label: "Working", since: Date.now(), phrases: ["Thinking"], phase: "think" });
    expect(toggle()).toBeNull();
    open({ simple: true });
    act(() => void vi.advanceTimersByTime(STATUS_QUIET_MS.max));
    act(() => toggle()!.click());
    expect(card()).not.toBeNull();
    render({ visible: false, card: createElement("p", null, "steps"), cardLabel: "What Ledger is doing" });
    act(() => void vi.advanceTimersByTime(300));
    open({ simple: true });
    expect(toggle()?.getAttribute("aria-expanded"), "a new turn starts folded").toBe("false");
  });
});

describe("thinking shimmer box", () => {
  const css = readFileSync("src/styles.css", "utf8");

  it("pads the phrase and its sheen past ascenders, descenders and arabic marks without moving the layout", () => {
    const rule = css.match(/\.thinking-shimmer \{[^}]*\}/)?.[0] ?? "";
    expect(rule).toMatch(/padding: 0\.35em 0\.12em/);
    expect(rule).toMatch(/margin: -0\.35em -0\.12em/);
    const copy = css.match(/\.thinking-sheen > span::before \{[^}]*\}/)?.[0] ?? "";
    expect(copy).toMatch(/padding: 0\.35em 0\.12em/);
    expect(copy).toContain("content: attr(data-text) / \"\"");
  });

  it("moves the sheen by transform alone, in steps, so a turn does not redraw the page every display frame", () => {
    for (const name of ["sheen-band", "sheen-letters"]) {
      const frames = css.match(new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
      const properties = [...frames.matchAll(/([a-z-]+):/g)].map((match) => match[1]);
      expect(new Set(properties)).toEqual(new Set(["transform", "animation-timing-function"]));
      expect(frames).toMatch(/steps\(\d+/);
    }
  });

  it("keeps the phrase's text to one copy for screen readers, selection and tests", () => {
    render({ label: "Running a command", since: null });
    const phrase = host.querySelector(".thinking-shimmer")!;
    expect(phrase.textContent).toBe("Running a command");
    expect(phrase.querySelector(".thinking-sheen")?.getAttribute("aria-hidden")).toBe("true");
  });
});
