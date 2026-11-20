import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/state/store";
import type { BrowserStep } from "./browser-step";

vi.mock("@/lib/live-events", () => ({ listenLiveFrames: () => () => {} }));
const { forgetBrowserSnapshots, noteBrowserFrame, watchBrowserSnapshots } = await import("@/state/browser-snapshots");
const { BrowserCard } = await import("./BrowserCard");

const bot = { id: "b1", name: "Nova", color: "green" as const };
let seq = 0;
const step = (action: string, tool: Partial<NonNullable<Message["tool"]>> = {}): BrowserStep =>
  ({ id: `m${++seq}`, role: "bot", kind: "activity", at: Date.now() - 3_000, tool: { name: `mcp__browser__agent_browser_${action}`, ...tool } }) as BrowserStep;
const opened = (site: string, detail = site) => step("open", { ok: true, step: { activity: "fetch", target: site, detail } });
const card = (steps: BrowserStep[], running: boolean, pictures?: boolean) =>
  renderToStaticMarkup(createElement(BrowserCard, { steps, bot, threadId: "t1", running, pictures }));
const pictured = (steps: BrowserStep[], png = "PAGE") => {
  const stop = watchBrowserSnapshots("b1", "t1", steps[0]!.id);
  noteBrowserFrame({ kind: "screen", botId: "b1", threadId: "t1", png, surface: "browser" });
  stop();
};

afterEach(() => forgetBrowserSnapshots());

describe("BrowserCard", () => {
  it("is an open window on the site while the bot browses, with a calm placeholder until a page arrives", () => {
    const html = card([opened("example.com", "example.com/pricing"), step("click")], true);
    expect(html).toContain('data-live-card="browser"');
    expect(html).toContain('data-live-card-state="running"');
    expect(html).toContain('data-live-card-open=""');
    expect(html).toContain("data-working-mascot");
    expect(html).toContain("example.com");
    expect(html).toContain('data-live-card-snapshot="waiting"');
    expect(html).toContain("The page shows here in a moment.");
    expect(html).not.toContain("<img");
    expect(html).toContain("Clicking on the page");
    expect(html).toContain("Opened example.com/pricing");
    expect(html).toContain("2 steps");
    expect(html).toContain("Browser on example.com · Running · show what it did");
  });

  it("shows the newest page small, with alt text and a control that shows it larger, and nothing to open before a page arrived", () => {
    const steps = [opened("example.com"), step("fill")];
    expect(card(steps, true)).toContain('disabled=""');
    pictured(steps);
    const html = card(steps, true);
    expect(html).toContain('src="data:image/png;base64,PAGE"');
    expect(html).toContain('alt="Nova&#x27;s browser on example.com"');
    expect(html).toContain('aria-label="Show Nova&#x27;s browser larger"');
    expect(html).not.toContain("data-live-card-thumb");
    expect(html).not.toContain('disabled=""');
  });

  it("draws no picture where the live browser is already on screen, only what the bot is doing", () => {
    const steps = [opened("example.com"), step("click")];
    pictured(steps);
    const html = card(steps, true, false);
    expect(html).not.toContain("data-live-card-snapshot");
    expect(html).not.toContain("<img");
    expect(html).toContain("Clicking on the page");
    expect(html).toContain("Opened example.com");
  });

  it("shows only the last few earlier steps while it runs", () => {
    const steps = [opened("a.example"), opened("b.example"), opened("c.example"), opened("d.example"), step("snapshot")];
    const html = card(steps, true);
    expect(html).not.toContain("Opened a.example");
    expect(html).toContain("Opened b.example");
    expect(html).toContain("Opened d.example");
    expect(html).toContain("Reading the page");
  });

  it("folds to one line: a thumbnail of the last page, the site, how many steps and a tick", () => {
    const steps = [opened("example.com"), step("click", { ok: true }), step("get_text", { ok: true })];
    pictured(steps);
    const html = card(steps, false);
    expect(html).toContain('data-live-card-state="done"');
    expect(html).not.toContain("data-live-card-open");
    expect(html).not.toContain("data-working-mascot");
    expect(html).toContain("data-live-card-thumb");
    expect(html).toContain("3 steps");
    expect(html).toContain("Browser on example.com · Finished · show what it did");
    expect(html).toMatch(/data-folded=""[^>]*inert/);
  });

  it("is a pill without a thumbnail once the page is no longer in memory, and says when its last step failed", () => {
    const html = card([opened("example.com"), step("click", { ok: false })], false);
    expect(html).toContain('data-live-card-state="failed"');
    expect(html).not.toContain("<img");
    expect(html).toContain("example.com");
  });

  it("is called Browser when no page was opened, and counts one step as one", () => {
    const html = card([step("snapshot", { ok: true })], false);
    expect(html).toContain("Browser on Browser");
    expect(html).toContain("1 step");
    expect(html).not.toContain("1 steps");
  });
});
