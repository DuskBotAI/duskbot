import { describe, expect, it } from "vitest";

import { ThreadTabs, threadOfTabLabel, threadTabLabel } from "./browser-thread-tabs.ts";
import { normalizeBrowserLiveMessage } from "./browser-live.ts";

type Tab = { tabId: string; targetId: string; label: string | null; url: string; active: boolean };

/** agent-browser 0.37's answers, shaped as its MCP server returns them. */
function engine(initial: Tab[] = []) {
  const tabs = [...initial];
  let next = tabs.length + 1;
  const calls: Array<[string, Record<string, unknown>]> = [];
  const ok = (data: Record<string, unknown>) => ({ content: [{ type: "text", text: "" }], structuredContent: { response: { success: true, data } } });
  const fail = (error: string) => ({ isError: true, content: [{ type: "text", text: error }], structuredContent: { response: { success: false, data: null, error } } });
  const find = (tab: unknown) => tabs.find((one) => one.label === tab || one.targetId === tab || one.tabId === tab);
  const rpc = async (name: string, args: Record<string, unknown>) => {
    calls.push([name, args]);
    if (name === "agent_browser_tab_list") return ok({ tabs: tabs.map((tab) => ({ ...tab, type: "page", title: "" })) });
    if (name === "agent_browser_tab_switch") {
      const tab = find(args.tab);
      if (!tab) return fail(`Tab not found: ${String(args.tab)}`);
      for (const one of tabs) one.active = one === tab;
      return ok({ tabId: tab.tabId, targetId: tab.targetId });
    }
    if (name === "agent_browser_tab_new") {
      const tab = { tabId: `t${next}`, targetId: `T${next}`, label: typeof args.label === "string" ? args.label : null, url: "about:blank", active: true };
      next++;
      for (const one of tabs) one.active = false;
      tabs.push(tab);
      return ok({ tabId: tab.tabId, targetId: tab.targetId, label: tab.label });
    }
    if (name === "agent_browser_tab_close") {
      if (tabs.length === 1) return fail("Cannot close the last tab");
      const tab = find(args.tab);
      if (!tab) return fail("Tab not found");
      tabs.splice(tabs.indexOf(tab), 1);
      return ok({ closed: true });
    }
    if (name === "agent_browser_screenshot") {
      const active = tabs.find((tab) => tab.active);
      return { content: [{ type: "image", data: Buffer.from(`shot-${active?.targetId}`).toString("base64"), mimeType: "image/jpeg" }] };
    }
    return ok({});
  };
  return { tabs, calls, rpc };
}

const blank = (): Tab => ({ tabId: "t1", targetId: "T1", label: null, url: "about:blank", active: true });

describe("a conversation's own tabs", () => {
  it("opens a conversation's first page in a new tab of its own and goes back to it on its next turn", async () => {
    const browser = engine([blank()]);
    const tabs = new ThreadTabs();
    await tabs.front("s", { threadId: "a", generation: "g1" }, "agent_browser_open", browser.rpc);
    expect(browser.tabs.find((tab) => tab.active)?.label).toBe(threadTabLabel("a"));
    await tabs.front("s", { threadId: "a", generation: "g1" }, "agent_browser_click", browser.rpc);
    await tabs.front("s", { threadId: "b", generation: "g2" }, "agent_browser_open", browser.rpc);
    expect(browser.tabs.map((tab) => tab.label)).toEqual([null, "chat-a", "chat-b"]);
    await tabs.front("s", { threadId: "a", generation: "g3" }, "agent_browser_open", browser.rpc);
    expect(browser.tabs.find((tab) => tab.active)?.label).toBe("chat-a");
    expect(browser.calls.filter(([name]) => name === "agent_browser_tab_new")).toHaveLength(2);
  });

  it("never switches to a tab already in front, which would clear the engine's refs, and goes back to its own after someone moved the front", async () => {
    const browser = engine([blank()]);
    const tabs = new ThreadTabs();
    await tabs.front("s", { threadId: "a", generation: "g1" }, "agent_browser_open", browser.rpc);
    tabs.refs.saw("s", "a", "agent_browser_snapshot", {}, { content: [{ type: "text", text: '- textbox "Message" [ref=e5]' }] });
    await tabs.front("s", { threadId: "a", generation: "g2" }, "agent_browser_type", browser.rpc);
    expect(browser.calls.filter(([name]) => name === "agent_browser_tab_switch")).toEqual([]);

    await browser.rpc("agent_browser_tab_new", { label: threadTabLabel("a", "x1") });
    await tabs.front("s", { threadId: "a", generation: "g2" }, "agent_browser_click", browser.rpc);
    expect(browser.calls.filter(([name]) => name === "agent_browser_tab_switch")).toEqual([]);
    await browser.rpc("agent_browser_tab_switch", { tab: "T1" });
    browser.calls.length = 0;
    await tabs.front("s", { threadId: "a", generation: "g2" }, "agent_browser_type", browser.rpc);
    expect(browser.calls.map(([name, args]) => [name, args.tab ?? null])).toEqual([
      ["agent_browser_tab_list", null], ["agent_browser_tab_switch", "T3"], ["agent_browser_snapshot", null],
    ]);
  });

  it("leaves a read with no tab of its own on the page in front, and tab tools alone", async () => {
    const browser = engine([blank()]);
    const tabs = new ThreadTabs();
    await tabs.front("s", { threadId: "a", generation: "g1" }, "agent_browser_snapshot", browser.rpc);
    await tabs.front("s", { threadId: "a", generation: "g1" }, "agent_browser_tab_list", browser.rpc);
    expect(browser.tabs).toHaveLength(1);
  });

  it("closes only that conversation's tabs, each pictured first, opening a blank one before closing the last", async () => {
    const browser = engine([{ ...blank(), label: "chat-a", active: true }, { tabId: "t2", targetId: "T2", label: "chat-a__x1", url: "https://example.com/", active: false }]);
    const tabs = new ThreadTabs();
    expect(await tabs.close("s", "b", browser.rpc)).toEqual({ closed: [] });
    const { closed } = await tabs.close("s", "a", browser.rpc);
    expect(closed.map((tab) => [tab.url, tab.image?.toString()])).toEqual([["about:blank", "shot-T1"], ["https://example.com/", "shot-T2"]]);
    expect(browser.tabs.map((tab) => tab.label)).toEqual([null]);
  });

  it("labels a bot's own new tab as its conversation's", () => {
    const label = new ThreadTabs().labelNewTab("a", { url: "https://example.com/", label: "chat-b" }).label;
    expect(threadOfTabLabel(label)).toBe("a");
    const uuid = "21eddb13-14c0-4708-b5bb-bcdefd2e6b39", own = new ThreadTabs().labelNewTab(uuid, {}).label;
    // the only labels agent-browser 0.37.0 accepts; anything else fails every new tab
    expect(own).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/u);
    expect(threadOfTabLabel(own)).toBe(uuid);
  });

  it("names the conversation of each tab in the live view, and none for tabs no conversation owns", () => {
    expect(threadOfTabLabel("chat-0b1c-2d")).toBe("0b1c-2d");
    expect(threadOfTabLabel("chat-0b1c__lq2")).toBe("0b1c");
    expect(threadOfTabLabel("mine")).toBeNull();
    expect(threadOfTabLabel(null)).toBeNull();
    expect(normalizeBrowserLiveMessage({ type: "tabs", tabs: [
      { tabId: "t1", title: "", url: "about:blank", active: false, label: null, targetId: "T1" },
      { tabId: "t2", title: "Example", url: "https://example.com/", active: true, label: "chat-th1", targetId: "T2" },
    ] })).toEqual({ type: "tabs", tabs: [
      { tabId: "t1", title: "", url: "about:blank", active: false },
      { tabId: "t2", title: "Example", url: "https://example.com/", active: true, threadId: "th1" },
    ] });
  });
});
