// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useSlotHandoff } from "./use-slot-handoff";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Bar({ label, send }: { label: string; send: boolean }) {
  const ref = useSlotHandoff(true);
  return createElement("div", { ref }, createElement("button", { key: "mic" }, label), send ? createElement("button", { key: "send" }, "send") : null);
}

it("reads the round button's colours only when the bar's buttons change, never on every render", async () => {
  vi.useFakeTimers();
  const styles = vi.spyOn(window, "getComputedStyle");
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  try {
    await act(async () => root.render(createElement(Bar, { label: "mic", send: false })));
    expect(styles, "a fresh bar reads nothing while it mounts").not.toHaveBeenCalled();
    await act(async () => { vi.runAllTimers(); });
    const read = styles.mock.calls.length;
    for (const label of ["m", "mi", "mic"]) await act(async () => root.render(createElement(Bar, { label, send: false })));
    expect(styles.mock.calls.length, "re-renders with the same buttons force no style").toBe(read);
    await act(async () => root.render(createElement(Bar, { label: "mic", send: true })));
    expect(styles.mock.calls.length, "a new round button is read to hand over").toBeGreaterThan(read);
  } finally {
    act(() => root.unmount());
    styles.mockRestore();
    vi.useRealTimers();
  }
});
