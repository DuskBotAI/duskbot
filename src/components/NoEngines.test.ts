// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: { instances: [] }, refreshInstances: async () => {} }),
}));
vi.mock("./onboarding/AiCards", () => ({ AiCards: () => createElement("div", { "data-ai-cards": "" }) }));

const { NoEngines } = await import("./NoEngines");

it("signed out of every AI, the app shows the welcome's Connect an AI step, not install cards", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(createElement(NoEngines)));
  expect(host.querySelector("h1")!.textContent).toBe("Connect an AI");
  expect(host.textContent).toContain("Use an account you already have.");
  expect(host.querySelector("[data-ai-cards]")).not.toBeNull();
  expect(host.textContent).not.toMatch(/Install .* here|doesn't ship a model/);
  flushSync(() => root.unmount());
});
