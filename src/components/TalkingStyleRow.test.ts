// @vitest-environment happy-dom
// Settings > General's Talking style: the first run's choice, casual, warm (until another is picked) or native.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const f = vi.hoisted(() => ({ config: {} as object, api: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({ api: f.api, useStore: () => ({ state: { config: f.config }, dispatch: f.dispatch }) }));
vi.mock("./SettingsSelect", async () => {
  const { createElement: h } = await import("react");
  return {
    SettingsSelect: ({ value, options, onChange, "aria-label": label }: { value: string; options: Array<{ value: string; label: string }>; onChange: (event: { target: { value: string } }) => void; "aria-label": string }) =>
      h("select", { value, "aria-label": label, onChange: (event: { target: { value: string } }) => onChange({ target: { value: event.target.value } }) },
        options.map((option) => h("option", { key: option.value, value: option.value }, option.label))),
  };
});
const { TalkingStyleRow } = await import("./AppSettingsRows");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const select = () => host.querySelector("select")!;
const show = async () => { await act(async () => { root.render(createElement(TalkingStyleRow)); }); };

beforeEach(() => {
  setLocale("en");
  f.config = {};
  f.api.mockReset();
  f.dispatch.mockReset();
  f.api.mockImplementation(async (_path: string, init?: { body?: string }) => JSON.parse(init?.body ?? "{}"));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("the Talking style row", () => {
  it("offers the three styles and reads Warm before any is chosen", async () => {
    await show();
    expect(host.textContent).toContain("Talking style");
    expect(select().getAttribute("aria-label")).toBe("Talking style");
    expect([...select().options].map((option) => [option.value, option.textContent])).toEqual([["casual", "Casual"], ["warm", "Warm"], ["native", "Native"]]);
    expect(select().value).toBe("warm");
  });

  it("shows the saved style and saves a new one to the app config", async () => {
    f.config = { talkingStyle: "native" };
    await show();
    expect(select().value).toBe("native");
    await act(async () => {
      select().value = "casual";
      select().dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(f.api).toHaveBeenCalledWith("/api/config", { method: "PATCH", body: JSON.stringify({ talkingStyle: "casual" }) });
    expect(f.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: { talkingStyle: "casual" } });
  });

  it("says so when the save fails", async () => {
    f.api.mockRejectedValue(new Error("offline"));
    await show();
    await act(async () => {
      select().value = "casual";
      select().dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("offline");
  });

  it("keeps the picked style in Spanish when a live config update lands after the save", async () => {
    setLocale("es");
    const { configStatusFromFrame } = await vi.importActual<typeof import("@/state/store")>("@/state/store");
    f.dispatch.mockImplementation((action: { config: object }) => { f.config = action.config; });
    await show();
    expect([...select().options].map((option) => option.textContent)).toEqual(["Informal", "Cercano", "Nativo"]);
    await act(async () => {
      select().value = "native";
      select().dispatchEvent(new Event("change", { bubbles: true }));
    });
    await show();
    expect(select().value).toBe("native");
    f.config = configStatusFromFrame({ language: "es", talkingStyle: "native" } as Parameters<typeof configStatusFromFrame>[0]);
    await show();
    expect(select().value).toBe("native");
  });
});
