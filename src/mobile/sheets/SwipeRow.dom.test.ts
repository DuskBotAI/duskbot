// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { SwipeRow } from "./SwipeRow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("draws no action under a closed row, so its colour never shows at the row's rounded corners", async () => {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => {
    root.render(createElement(SwipeRow, { actions: [{ label: "Delete", danger: true, onPress: () => {} }], children: "Morning brief" }));
  });
  const actions = document.querySelector<HTMLElement>("[data-swipe-actions]")!;
  expect(actions.style.visibility).toBe("hidden");
  act(() => root.unmount());
});
