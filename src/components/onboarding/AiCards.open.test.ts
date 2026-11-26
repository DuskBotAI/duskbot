// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { InstanceInfo } from "@/state/store";

const f = vi.hoisted(() => ({ instances: [] as InstanceInfo[], reveal: vi.fn() }));
vi.mock("@/state/store", () => ({ api: async () => ({ instances: f.instances }), useStore: () => ({ state: { instances: f.instances }, dispatch: vi.fn() }) }));
vi.mock("@/components/EngineSetup", () => ({ EngineSetup: () => createElement("input", { "aria-label": "API key" }) }));
vi.mock("./SignInPill", () => ({
  ConnectPanel: () => null,
  revealIfCovered: f.reveal,
  useConnectFlow: () => ({ state: { stage: "idle" }, target: null, start: vi.fn(), cancel: vi.fn(), retry: vi.fn(), openAgain: vi.fn(), submit: vi.fn() }),
}));
const { AiCards } = await import("./AiCards");
const { CONNECT_LEAVE_MS } = await import("./ConnectMotion");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const openrouter = {
  instanceId: "openrouter", driverKind: "openai-compat", displayName: "OpenRouter", access: "api",
  snapshot: { state: "available", authenticated: false }, models: { default: "m", options: [] },
} as unknown as InstanceInfo;
let host: HTMLDivElement, root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  setLocale("en");
  f.instances = [openrouter];
  f.reveal.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

it("moves focus into an opened card's field and, once it has grown in, scrolls it clear of what covers it", async () => {
  await act(async () => { root.render(createElement(AiCards, { tested: null })); });
  const tile = document.body.querySelector<HTMLButtonElement>("[data-funnel-ai=openrouter]")!;
  tile.focus();
  await act(async () => { tile.click(); });
  const field = document.body.querySelector<HTMLInputElement>("[data-funnel-ai-connect=openrouter] input")!;
  expect(document.activeElement).toBe(field);
  expect(f.reveal).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(CONNECT_LEAVE_MS); });
  expect(f.reveal).toHaveBeenCalledExactlyOnceWith(document.body.querySelector("[data-funnel-ai-connect=openrouter]"));
});

it("on the first run, the AIs already connected when the grid opens lead it, tinted, and the order holds while it is open", async () => {
  const sub = (instanceId: string, driverKind: string, ready: boolean) => ({ instanceId, driverKind, displayName: instanceId, access: "subscription",
    snapshot: { state: "available", authenticated: ready }, authentication: { method: "browser-pkce" }, models: { default: "m", options: [] } }) as unknown as InstanceInfo;
  f.instances = [sub("chatgpt", "codex", false), sub("claude", "claudeAgent", true), openrouter];
  const order = () => [...document.body.querySelectorAll<HTMLElement>("[data-funnel-ai]")].map((tile) => tile.dataset.funnelAi);
  await act(async () => { root.render(createElement(AiCards, { tested: null, foundFirst: true })); });
  expect(order()).toEqual(["claude", "chatgpt", "openrouter"]);
  expect(document.body.querySelector("[data-funnel-ai=claude]")?.className).toContain("bg-success");
  f.instances = [sub("chatgpt", "codex", true), sub("claude", "claudeAgent", true), openrouter];
  await act(async () => { root.render(createElement(AiCards, { tested: null, foundFirst: true })); });
  expect(order(), "one connected while open stays where it was").toEqual(["claude", "chatgpt", "openrouter"]);
  expect(document.body.querySelector("[data-funnel-ai=chatgpt]")?.className).not.toContain("bg-success");
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => { root.render(createElement(AiCards, { tested: null })); });
  expect(order(), "everywhere else the grid keeps its fixed order").toEqual(["chatgpt", "claude", "openrouter"]);
});

it("laid out in two parts, the AIs already connected sit in their own row on top and the rest under Connect more", async () => {
  const sub = (instanceId: string, driverKind: string, ready: boolean) => ({ instanceId, driverKind, displayName: instanceId, access: "subscription",
    snapshot: { state: "available", authenticated: ready }, authentication: { method: "browser-pkce" }, models: { default: "m", options: [] } }) as unknown as InstanceInfo;
  f.instances = [sub("chatgpt", "codex", false), sub("claude", "claudeAgent", true), openrouter];
  await act(async () => { root.render(createElement(AiCards, { tested: null, foundRow: true })); });
  const group = (name: string) => [...document.body.querySelector(`[data-ai-cards-group=${name}]`)!.parentElement!.querySelectorAll<HTMLElement>("[data-funnel-ai]")].map((tile) => tile.dataset.funnelAi);
  expect(document.body.querySelector("[data-ai-cards-group=found]")?.textContent).toBe("On your computer");
  expect(group("found")).toEqual(["claude"]);
  expect(document.body.querySelector("[data-ai-cards-group=more]")?.textContent).toBe("Connect more");
  expect(group("more")).toEqual(["chatgpt", "openrouter"]);
});
