import { Children, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({
  values: [] as unknown[], index: 0, effects: [] as EffectCallback[], state: {} as AppState, dispatch: vi.fn(), api: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [fixture.values[index], (next: unknown) => {
      fixture.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(fixture.values[index]) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = { current: initial };
    return fixture.values[index];
  },
  useCallback: (callback: unknown) => callback,
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useEffect: (effect: EffectCallback) => { fixture.effects.push(effect); },
  useLayoutEffect: () => {},
}));
vi.mock("react-dom", () => ({ createPortal: (node: ReactNode) => node }));
vi.mock("./MenuMotion", () => ({
  useMenuMotion: (open: boolean) => ({ shown: open, closing: false, className: "", exitProps: {} }),
  useHeldMenuMotion: (value: unknown) => ({ shown: value !== null, value, closing: false, className: "", exitProps: {} }),
}));
vi.mock("./DesktopCapabilities", async () => {
  const { initialDesktopCapabilities } = await import("@/lib/desktop");
  return { useDesktopCapabilities: () => ({ capabilities: initialDesktopCapabilities() }), windowFramed: () => false };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, api: fixture.api, useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }) };
});

import { initialState } from "@/state/store";
import { Sidebar } from "./Sidebar";
import { SidebarEmpty } from "./SidebarEmpty";

const left = (id: string, extra: Partial<Bot> = {}): Bot => ({
  id, threadId: `${id}-left`, mainThreadId: `${id}-main`, name: id, title: "", description: "", notifications: true,
  color: "green", unread: false, modelSelection: { instanceId: "fake", model: "m" }, messages: [],
  tasks: [{ threadId: `${id}-left`, title: "routine report", createdAt: 1, unread: true }, { threadId: `${id}-main`, title: "Main chat", createdAt: 2 }],
  ...extra,
});

type Props = { children?: ReactNode; onClick?: () => void; onRestore?: () => void; onConfirm?: () => void; onArchive?: (bot: Bot) => void; open?: boolean; role?: string; [key: string]: unknown };
function nodes(value: ReactNode): ReactElement<Props>[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement<Props>(child)) return [];
    return [child, ...nodes(child.props.children)];
  });
}
function render(component: () => ReactNode) {
  fixture.index = 0;
  fixture.effects = [];
  return nodes(component());
}

beforeEach(() => {
  fixture.values = [];
  fixture.dispatch.mockReset();
  fixture.api.mockReset();
  vi.stubGlobal("window", Object.assign(new EventTarget(), { innerWidth: 1280, innerHeight: 800, duskDesktop: undefined, setTimeout, clearTimeout }));
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal("document", { body: {} });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("a sidebar with no bot in it", () => {
  const sidebar = () => render(() => Sidebar({ open: false, onClose: () => {} }));
  const empty = () => sidebar().filter((node) => node.type === SidebarEmpty);

  it("says so when every bot is hidden or archived, instead of an empty column", () => {
    fixture.state = { ...initialState, hydrated: true, bots: [left("dusk", { defaultBot: { person: "" }, sidebarHidden: true }), left("scout", { hidden: true })], selectedId: "scout", activeView: "chat" };
    expect(empty()).toHaveLength(1);
  });

  it("stays out of a sidebar with a bot in it", () => {
    fixture.state = { ...initialState, bots: [left("scout")], selectedId: "scout", activeView: "chat" };
    expect(empty()).toHaveLength(0);
  });
});
