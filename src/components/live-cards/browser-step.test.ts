import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { browserAction, browserDid, browserDoing, isBrowserStep, stretchSite, stretchState, type BrowserStep } from "./browser-step";

let seq = 0;
const step = (name: string, tool: Partial<NonNullable<Message["tool"]>> = {}): Message =>
  ({ id: `m${++seq}`, role: "bot", kind: "activity", at: 1, tool: { name, ...tool } });
const opened = (site: string, detail?: string) =>
  step("mcp__browser__agent_browser_open", { ok: true, step: { activity: "fetch", target: site, ...(detail ? { detail } : {}) } }) as BrowserStep;

describe("isBrowserStep", () => {
  it.each([
    "mcp__browser__agent_browser_open",
    "mcp__browser__agent_browser_click",
    "browser_agent_browser_fill",
    "agent_browser_snapshot",
    "browser__agent_browser_wait",
  ])("counts %s, a call on the built-in browser", (name) => {
    expect(isBrowserStep(step(name))).toBe(true);
  });

  it.each([
    "WebSearch",
    "WebFetch",
    "web_search_many",
    "Bash",
    "Read",
    "mcp__computer__click",
    "mcp__computer__browser_click",
    "computer_screenshot",
    "mcp__agents__set_status",
  ])("leaves %s out: it does not use the built-in browser", (name) => {
    expect(isBrowserStep(step(name))).toBe(false);
  });

  it("leaves out a command, a status row and a row that is not a tool call", () => {
    expect(isBrowserStep(step("mcp__browser__agent_browser_eval", { step: { activity: "command", target: "ls" } }))).toBe(false);
    expect(isBrowserStep(step("notice: the browser closed"))).toBe(false);
    expect(isBrowserStep({ id: "t", role: "bot", kind: "text", at: 1, text: "agent_browser_open" })).toBe(false);
  });
});

describe("browser step wording", () => {
  it.each([
    ["mcp__browser__agent_browser_open", "open"],
    ["mcp__browser__agent_browser_navigate", "open"],
    ["browser_agent_browser_tab_new", "open"],
    ["mcp__browser__agent_browser_click", "click"],
    ["mcp__browser__agent_browser_select", "click"],
    ["mcp__browser__agent_browser_fill", "type"],
    ["mcp__browser__agent_browser_press", "type"],
    ["mcp__browser__agent_browser_scroll", "scroll"],
    ["mcp__browser__agent_browser_snapshot", "read"],
    ["mcp__browser__agent_browser_get_text", "read"],
    ["mcp__browser__agent_browser_screenshot", "look"],
    ["mcp__browser__agent_browser_wait_for_text", "wait"],
    ["mcp__browser__agent_browser_wait", "wait"],
    ["mcp__browser__browser_navigate", "open"],
    ["mcp__browser__agent_browser_tools_profiles", "use"],
  ])("reads %s as %s", (name, action) => {
    expect(browserAction(name)).toBe(action);
  });

  it("names the page an open went to, and says what every other step did in plain words", () => {
    expect(browserDoing(opened("example.com", "example.com/pricing"))).toBe("Opening example.com/pricing");
    expect(browserDid(opened("example.com"))).toBe("Opened example.com");
    expect(browserDid(step("mcp__browser__agent_browser_open", { ok: true }) as BrowserStep)).toBe("Opened a page");
    expect(browserDoing(step("mcp__browser__agent_browser_fill") as BrowserStep)).toBe("Typing on the page");
    expect(browserDid(step("mcp__browser__agent_browser_click", { ok: true }) as BrowserStep)).toBe("Clicked on the page");
  });

  it("never shows what was typed or which element was clicked", () => {
    const typed = step("mcp__browser__agent_browser_fill", { ok: true, input: '{"selector":"#password","text":"hunter2"}' }) as BrowserStep;
    expect(browserDid(typed)).toBe("Typed on the page");
    expect(browserDoing(typed)).not.toContain("hunter2");
  });
});

describe("a stretch of browser steps", () => {
  it("is on the site it opened last", () => {
    const steps = [opened("example.com"), step("mcp__browser__agent_browser_click", { ok: true }) as BrowserStep, opened("docs.example.org"), step("mcp__browser__agent_browser_snapshot") as BrowserStep];
    expect(stretchSite(steps)).toBe("docs.example.org");
    expect(stretchSite([step("mcp__browser__agent_browser_snapshot") as BrowserStep])).toBeUndefined();
  });

  it("is running while the bot is still on it, then ends as its last step did", () => {
    const ok = step("mcp__browser__agent_browser_click", { ok: true }) as BrowserStep;
    const failed = step("mcp__browser__agent_browser_click", { ok: false }) as BrowserStep;
    const open = step("mcp__browser__agent_browser_click") as BrowserStep;
    expect(stretchState([ok, open], true)).toBe("running");
    expect(stretchState([failed, ok], false)).toBe("done");
    expect(stretchState([ok, failed], false)).toBe("failed");
    expect(stretchState([ok, open], false)).toBe("ended");
  });
});
