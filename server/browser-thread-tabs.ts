// Each conversation's pages live in tabs of their own in the bot's one browser, named by an agent-browser tab label, so the
// tie survives a server restart and the live view can say which chat a tab belongs to. agent-browser 0.37: tab_new takes a
// label, tab_switch and tab_close take a label or CDP target id as `tab`, the live stream's tabs carry `label`, and the
// last tab cannot be closed.

import { CarriedRefs } from "./browser/agent-browser-refs.ts";

const PREFIX = "chat-";
// agent-browser 0.37.0 refuses a tab label outside [A-Za-z][A-Za-z0-9_-]*.
const EXTRA = "__";
const THREAD_ID = /^[\w-]{1,128}$/u;

export type TabRpc = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export interface ListedTab { tabId: string; targetId: string; label: string | null; url: string; title: string; active: boolean }

/** A closed tab as the Computer tab's "What it worked on" keeps it: its last screen as JPEG, or null. */
export interface ClosedThreadTab { title: string; url: string; image: Buffer | null }

/** The label of a conversation's first tab; later ones it opens itself add a suffix. */
export function threadTabLabel(threadId: string, extra?: string): string {
  return PREFIX + threadId + (extra ? EXTRA + extra : "");
}

/** The conversation a tab label names, or null for a tab no conversation owns (a person's, or one opened before). */
export function threadOfTabLabel(label: unknown): string | null {
  if (typeof label !== "string" || !label.startsWith(PREFIX)) return null;
  const threadId = label.slice(PREFIX.length).split(EXTRA, 1)[0]!;
  return THREAD_ID.test(threadId) ? threadId : null;
}

function engineData(result: unknown): Record<string, unknown> | null {
  const response = (result as { structuredContent?: { response?: { success?: unknown; data?: unknown } } } | null)?.structuredContent?.response;
  return response?.success === true && response.data && typeof response.data === "object" ? response.data as Record<string, unknown> : null;
}

export function listedTabs(result: unknown): ListedTab[] | null {
  const tabs = engineData(result)?.tabs;
  if (!Array.isArray(tabs)) return null;
  return tabs.flatMap((value) => {
    const tab = value as Record<string, unknown> | null;
    if (!tab || typeof tab.tabId !== "string" || typeof tab.targetId !== "string" || (tab.type !== undefined && tab.type !== "page")) return [];
    return [{ tabId: tab.tabId, targetId: tab.targetId, label: typeof tab.label === "string" ? tab.label : null, url: typeof tab.url === "string" ? tab.url : "",
      title: typeof tab.title === "string" ? tab.title : "", active: tab.active === true }];
  });
}

const succeeded = (result: unknown): boolean => engineData(result) !== null;

async function lastScreen(tab: ListedTab, rpc: TabRpc): Promise<Buffer | null> {
  if (!succeeded(await rpc("agent_browser_tab_switch", { tab: tab.targetId }).catch(() => null))) return null;
  const result = await rpc("agent_browser_screenshot", { format: "jpeg", quality: 70 }).catch(() => null);
  const content = (result as { isError?: boolean; content?: unknown } | null)?.isError ? null : (result as { content?: unknown } | null)?.content;
  const image = Array.isArray(content) ? content.find((part) => part?.type === "image" && typeof part.data === "string" && part.data.length > 0) as { data: string } | undefined : undefined;
  return image ? Buffer.from(image.data, "base64") : null;
}

/** Calls that manage tabs or the browser itself run on whatever tab is in front. */
const TAB_TOOLS = new Set(["agent_browser_tab_new", "agent_browser_tab_list", "agent_browser_tab_switch", "agent_browser_tab_close", "agent_browser_close"]);

export class ThreadTabs {
  /** Per browser, the conversation turn whose tab was last put in front by this server. */
  readonly #front = new Map<string, string>();
  /** Per browser and conversation, the tab of its own it last worked in. */
  readonly #last = new Map<string, string>();
  readonly refs = new CarriedRefs();

  /** A bot's own new tab is labelled as its conversation's, so it is shown and closed with that conversation. */
  labelNewTab(threadId: string, args: Record<string, unknown>): Record<string, unknown> {
    return { ...args, label: threadTabLabel(threadId, Date.now().toString(36)) };
  }

  /** Before a call from a conversation's turn: its tab goes in front unless one of its tabs already is (a switch clears
   * the engine's refs, which are then carried over), and its first page opens in a new tab of its own. */
  async front(session: string, turn: { threadId: string; generation: string }, tool: string, rpc: TabRpc): Promise<void> {
    if (TAB_TOOLS.has(tool)) return;
    const key = `${turn.threadId}:${turn.generation}`;
    const label = threadTabLabel(turn.threadId);
    const last = `${session}\u0000${turn.threadId}`;
    const tabs = listedTabs(await rpc("agent_browser_tab_list", {}).catch(() => null));
    if (tabs) {
      const active = tabs.find((tab) => tab.active);
      if (active && threadOfTabLabel(active.label) === turn.threadId) {
        this.#last.set(last, active.targetId);
        this.#front.set(session, key);
        return;
      }
      const own = tabs.find((tab) => tab.targetId === this.#last.get(last) && threadOfTabLabel(tab.label) === turn.threadId) ?? tabs.find((tab) => tab.label === label);
      if (own && succeeded(await rpc("agent_browser_tab_switch", { tab: own.targetId }).catch(() => null))) {
        this.#last.set(last, own.targetId);
        this.#front.set(session, key);
        await this.refs.restore(session, turn.threadId, (args) => rpc("agent_browser_snapshot", args));
        return;
      }
    } else {
      if (this.#front.get(session) === key) return;
      if (succeeded(await rpc("agent_browser_tab_switch", { tab: label }).catch(() => null))) {
        this.#front.set(session, key);
        await this.refs.restore(session, turn.threadId, (args) => rpc("agent_browser_snapshot", args));
        return;
      }
    }
    if (tool !== "agent_browser_open") return;
    if (succeeded(await rpc("agent_browser_tab_new", { label }).catch(() => null))) {
      this.#front.set(session, key);
      this.#last.delete(last);
    }
  }

  /** Closes a conversation's tabs, each pictured first, opening a blank one when they are all the browser has. */
  async close(session: string, threadId: string, rpc: TabRpc): Promise<{ closed: ClosedThreadTab[] }> {
    const tabs = listedTabs(await rpc("agent_browser_tab_list", {}));
    if (!tabs) return { closed: [] };
    const owned = tabs.filter((tab) => threadOfTabLabel(tab.label) === threadId);
    if (!owned.length) return { closed: [] };
    const pictured: Array<ListedTab & { image: Buffer | null }> = [];
    for (const tab of owned) pictured.push({ ...tab, image: await lastScreen(tab, rpc) });
    if (owned.length === tabs.length) await rpc("agent_browser_tab_new", {});
    const closed: ClosedThreadTab[] = [];
    for (const tab of pictured) {
      if (succeeded(await rpc("agent_browser_tab_close", { tab: tab.targetId }).catch(() => null))) closed.push({ title: tab.title, url: tab.url, image: tab.image });
    }
    if (this.#front.get(session)?.startsWith(`${threadId}:`)) this.#front.delete(session);
    this.#last.delete(`${session}\u0000${threadId}`);
    this.refs.forgetThread(session, threadId);
    return { closed };
  }

  forget(session: string): void {
    this.#front.delete(session);
    for (const key of this.#last.keys()) if (key.startsWith(`${session}\u0000`)) this.#last.delete(key);
    this.refs.forget(session);
  }
}
