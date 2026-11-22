// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { InstanceInfo } from "@/state/store";
import type { ConnectState } from "./connect-flow";

const f = vi.hoisted(() => ({ instances: [] as InstanceInfo[], state: { stage: "idle" } as ConnectState, cancel: vi.fn() }));
vi.mock("@/state/store", () => ({ api: async () => ({ instances: f.instances }), useStore: () => ({ state: { instances: f.instances }, dispatch: vi.fn() }) }));
vi.mock("@/components/EngineSetup", () => ({ EngineSetup: () => null }));
vi.mock("./SignInPill", () => ({
  ConnectPanel: () => null,
  revealIfCovered: () => {},
  useConnectFlow: () => ({ state: f.state, target: null, start: vi.fn(), cancel: f.cancel, retry: vi.fn(), openAgain: vi.fn(), submit: vi.fn() }),
}));
const { AiCards } = await import("./AiCards");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const codex = (ready: boolean): InstanceInfo => ({
  instanceId: "codex", driverKind: "codex", displayName: "Codex", authentication: { method: "device-code" },
  snapshot: { state: "available", authenticated: ready }, models: { default: "m", options: [] },
} as unknown as InstanceInfo);
let host: HTMLDivElement, root: Root;

beforeEach(() => {
  setLocale("en");
  f.instances = [codex(false)];
  f.state = { stage: "idle" };
  f.cancel.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("tells it connected only once its sign-in finished confirming, so the dialog does not close on it mid-way", async () => {
  const onConnected = vi.fn();
  const show = () => act(async () => { root.render(createElement(AiCards, { tested: null, onConnected })); });
  await show();
  await act(async () => { document.body.querySelector<HTMLElement>("[data-funnel-ai=chatgpt]")!.click(); });
  f.state = { stage: "confirming", since: Date.now() };
  // the confirming stage's fresh status read already shows the AI signed in
  f.instances = [codex(true)];
  await show();
  expect(onConnected).not.toHaveBeenCalled();
  f.state = { stage: "connected", reused: false };
  await show();
  expect(onConnected).toHaveBeenCalledExactlyOnceWith("chatgpt");
});

it("makes a connected card a button to its accounts where the grid offers that, and leaves it still elsewhere", async () => {
  f.instances = [codex(true)];
  const onManage = vi.fn();
  await act(async () => { root.render(createElement(AiCards, { tested: null, onManage })); });
  const card = host.querySelector<HTMLElement>("[data-funnel-ai=chatgpt]")!;
  expect(card.tagName).toBe("BUTTON");
  expect(card.hasAttribute("data-connected")).toBe(true);
  await act(async () => { card.click(); });
  expect(onManage).toHaveBeenCalledExactlyOnceWith(f.instances[0]);
  await act(async () => { root.render(createElement(AiCards, { tested: null })); });
  expect(host.querySelector("[data-funnel-ai=chatgpt]")!.tagName).toBe("DIV");
});
