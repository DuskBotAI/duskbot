// @vitest-environment happy-dom
import { createElement, Fragment } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineLimit } from "../../../shared/limit-reset";

const fixture = vi.hoisted(() => ({ api: vi.fn(async (..._args: unknown[]) => ({}) as unknown) }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: (...args: unknown[]) => fixture.api(...args),
}));

const { setLocale } = await import("@/lib/i18n");
const limits = await import("@/lib/limit-resets");
const { USAGE_DISPLAY_KEY, setUsageDisplay } = await import("@/lib/usage-display");
const { UsageBanner, UsageMeterRow } = await import("../native/UsageMeter");
const { ProviderSummary } = await import("./ProviderSummary");
const { UsageDisplayRow } = await import("./UsageDisplayRow");

const NOW = new Date(2026, 9, 19, 10, 0, 0).getTime();
const HOUR = 3_600_000;
const engine = (usedPercent: number, weekly: number): EngineLimit => ({
  engine: "claude", name: "Claude", driver: "claude", window: "5-hour", usedPercent, resetsAt: NOW + 3 * HOUR, blocked: false,
  windows: [{ window: "5-hour", usedPercent, resetsAt: NOW + 3 * HOUR }, { window: "weekly", usedPercent: weekly, resetsAt: NOW + 72 * HOUR }],
});

let root: Root | null = null;
function mount(limit: EngineLimit) {
  fixture.api.mockImplementation(async () => ({ checkedAt: NOW, engines: [limit] }));
  limits.rememberLimits({ checkedAt: NOW, engines: [limit] });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(createElement(Fragment, null,
    createElement(UsageDisplayRow),
    createElement(ProviderSummary, { limits: [limit], now: NOW }),
    createElement(UsageMeterRow, { engine: "claude" }),
    createElement(UsageBanner, { engine: "claude", onSeeUsage: () => {} }),
  )));
  return container;
}

let stored: Map<string, string>;
beforeEach(() => {
  stored = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  setLocale("en");
  fixture.api.mockReset();
});
afterEach(() => {
  setUsageDisplay("used");
  root?.unmount();
  root = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("show usage as", () => {
  it("flips every figure and its meter between used and remaining, and remembers the choice", () => {
    const page = mount(engine(38, 12));
    const radio = (value: string) => page.querySelector<HTMLButtonElement>(`[data-settings-select="usage-display"] [role="radio"][data-value="${value}"]`)!;
    const plan = () => page.querySelector("[data-usage-provider='claude']")!;
    const row = () => page.querySelector("[data-panel-row='usage']")!;
    const fill = () => row().querySelector<HTMLElement>("[data-usage-meter] > div")!.style.width;

    expect([radio("used").getAttribute("aria-checked"), radio("left").getAttribute("aria-checked")]).toEqual(["true", "false"]);
    expect([radio("used").textContent, radio("left").textContent]).toEqual(["Used", "Remaining"]);
    expect(plan().textContent).toContain("38%Used");
    expect(plan().querySelector("[data-usage-window='weekly']")?.textContent).toBe("Weekly 12%");
    expect(plan().querySelector("[role='meter']")?.getAttribute("aria-valuenow")).toBe("38");
    expect(row().textContent).toContain("38% used");
    expect(fill()).toBe("38%");

    flushSync(() => radio("left").click());
    expect([radio("used").getAttribute("aria-checked"), radio("left").getAttribute("aria-checked")]).toEqual(["false", "true"]);
    expect(plan().textContent).toContain("62%Left");
    expect(plan().querySelector("[data-usage-window='weekly']")?.textContent).toBe("Weekly 88%");
    expect(plan().querySelector("[role='meter']")?.getAttribute("aria-valuenow")).toBe("62");
    expect(row().textContent).toContain("62% left");
    expect(fill()).toBe("62%");
    expect(stored.get(USAGE_DISPLAY_KEY)).toBe("left");

    flushSync(() => radio("used").click());
    expect(row().textContent).toContain("38% used");
    expect(stored.get(USAGE_DISPLAY_KEY)).toBe("used");
  });

  it("words the near-limit warning to match", () => {
    const page = mount(engine(92, 40));
    const banner = () => page.querySelector("[data-usage-banner]")!.textContent;
    expect(banner()).toContain("You're at 92% of your Claude usage limit.");
    flushSync(() => setUsageDisplay("left"));
    expect(banner()).toContain("You have 8% of your Claude usage limit left.");
  });

  it("renders Antigravity and Cursor monthly plan cards in Your AI plans", () => {
    const cursor: EngineLimit = {
      engine: "cursor", name: "Cursor", driver: "cursor", window: "monthly", usedPercent: 42, resetsAt: NOW + 240 * HOUR, blocked: false,
      windows: [{ window: "monthly", usedPercent: 42, resetsAt: NOW + 240 * HOUR }],
    };
    const antigravity: EngineLimit = {
      engine: "antigravity", name: "Antigravity", driver: "antigravity", window: "weekly", usedPercent: 30, resetsAt: NOW + 72 * HOUR, blocked: false,
      windows: [
        { window: "5-hour", usedPercent: 10, resetsAt: NOW + 3 * HOUR },
        { window: "weekly", usedPercent: 30, resetsAt: NOW + 72 * HOUR },
      ],
    };
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    flushSync(() => root!.render(createElement(ProviderSummary, { limits: [cursor, antigravity], now: NOW })));
    const cursorCard = container.querySelector("[data-usage-provider='cursor']")!;
    const agCard = container.querySelector("[data-usage-provider='antigravity']")!;
    expect(cursorCard.textContent).toContain("Cursor");
    expect(cursorCard.textContent).toContain("Monthly");
    expect(cursorCard.textContent).toContain("42%Used");
    expect(agCard.textContent).toContain("Antigravity");
    expect(agCard.textContent).toContain("Weekly");
    expect(agCard.textContent).toContain("30%Used");
    expect(agCard.querySelector("[data-usage-window='5-hour']")?.textContent).toBe("5-hour 10%");
  });
});
