// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "../../../shared/runtime-events";
import { forgetCommandTails, noteCommandTail } from "@/state/command-tails";
import type { CommandStep } from "./command-step";

const api = vi.fn(async () => ({ output: "line 1\nline 2\nthe whole output" }));
vi.mock("@/state/api", async (original) => ({ ...await original<typeof import("@/state/api")>(), api }));
const { CommandCard } = await import("./CommandCard");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bot = { id: "b1", name: "Nova", color: "green" as const };
const step = (tool: Partial<CommandStep["tool"]>): CommandStep =>
  ({ id: "m1", role: "bot", kind: "activity", at: Date.now() - 2_000, tool: { name: "Bash", itemId: "i1", step: { activity: "command", target: "pnpm test" }, ...tool } }) as CommandStep;
const render = (message: CommandStep, live: boolean) => act(async () => { root.render(createElement(CommandCard, { message, bot, threadId: "t1", live })); });
const card = () => host.querySelector<HTMLElement>("[data-live-card]")!;
const toggle = () => host.querySelector<HTMLButtonElement>("[data-live-card] button")!;

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); forgetCommandTails(); vi.useRealTimers(); vi.clearAllMocks(); });

it("follows the command's output while it runs, then folds to a pill that opens on its final output", async () => {
  await render(step({}), true);
  expect(card().dataset.liveCardState).toBe("running");
  expect(host.textContent).toContain("Output shows here when the command prints some.");
  await act(async () => { noteCommandTail({ type: "turn.progress", activity: "command", threadId: "t1", itemId: "i1", tail: ["✓ a.test.ts", "✓ b.test.ts"] } as unknown as RuntimeEvent); });
  expect(host.querySelector("[data-live-card-output=live]")!.textContent).toBe("✓ a.test.ts\n✓ b.test.ts");
  await act(async () => { toggle().click(); });
  expect(card().hasAttribute("data-live-card-open")).toBe(true);

  await render(step({ ok: true, ms: 4_200, output: "2 passed" }), false);
  expect(card().dataset.liveCardState).toBe("done");
  expect(card().hasAttribute("data-live-card-open")).toBe(false);
  expect(host.querySelector("[data-live-card-meta]")!.textContent).toBe("4s");
  expect(host.textContent).toContain("2 passed");
  expect(host.querySelector(".live-card-peek")!.hasAttribute("data-ducked")).toBe(true);
  await act(async () => { vi.advanceTimersByTime(400); });
  expect(host.textContent).not.toContain("2 passed");
  expect(host.querySelector(".live-card-peek")).toBeNull();

  await act(async () => { toggle().click(); });
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  expect(host.querySelector("[data-live-card-output=final]")!.textContent).toBe("2 passed");
  expect(api).not.toHaveBeenCalled();
  await act(async () => { toggle().click(); });
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
});

it("says so when a command's result was never recorded", async () => {
  await render(step({}), false);
  expect(card().dataset.liveCardState).toBe("ended");
  await act(async () => { toggle().click(); });
  expect(host.textContent).toContain("No result was recorded for this command.");
});

it("loads the whole output of a clipped step only when its pill is opened", async () => {
  vi.useRealTimers();
  await render(step({ ok: true, output: "line 1", clipped: true }), false);
  expect(api).not.toHaveBeenCalled();
  await act(async () => { toggle().click(); });
  expect(api).toHaveBeenCalledWith("/api/threads/t1/messages/m1/tool", expect.anything());
  await act(async () => { await Promise.resolve(); });
  expect(host.querySelector("[data-live-card-output=final]")!.textContent).toBe("line 1\nline 2\nthe whole output");
});
