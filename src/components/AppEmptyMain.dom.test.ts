// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LOAD_GIVE_UP_MS, loadingLine, useLoadGaveUp } from "@/lib/app-loading";

const retryLoad = vi.fn();
vi.mock("@/state/store", () => ({ retryLoad: () => retryLoad() }));
const { AppEmptyMain } = await import("./AppEmptyMain");

let root: Root | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  retryLoad.mockReset();
  vi.useRealTimers();
});

function Screen({ failed }: { failed: boolean }) {
  const unreachable = useLoadGaveUp(failed);
  return createElement(AppEmptyMain, { loading: loadingLine({ connected: false, hydrated: false, developer: true, unreachable }), notice: null });
}

const main = () => document.querySelector<HTMLElement>("[data-app-loading]")!;

it("keeps connecting quietly at first, then says the server can't be reached, with the command and Try again", () => {
  act(() => root!.render(createElement(Screen, { failed: true })));
  act(() => { vi.advanceTimersByTime(LOAD_GIVE_UP_MS - 1); });
  expect(main().dataset.appLoading).toBe("app.loading.connecting");
  expect(document.querySelector("[data-app-load-retry]")).toBeNull();

  act(() => { vi.advanceTimersByTime(1); });
  expect(main().dataset.appLoading).toBe("app.loading.unreachable");
  expect(main().textContent).toContain("Can't connect to dusk bot");
  expect(main().textContent).toContain("pnpm dev:server");
  expect(document.querySelector("[role=alert]")).not.toBeNull();
  expect(document.querySelector("[data-app-empty-create]"), "not the no-bots offer").toBeNull();

  act(() => document.querySelector<HTMLButtonElement>("[data-app-load-retry]")!.click());
  expect(retryLoad).toHaveBeenCalledTimes(1);
});

it("never gives up while the first read has not failed", () => {
  act(() => root!.render(createElement(Screen, { failed: false })));
  act(() => { vi.advanceTimersByTime(LOAD_GIVE_UP_MS * 4); });
  expect(main().dataset.appLoading).toBe("app.loading.connecting");
});
