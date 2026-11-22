// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { TimeField } from "./RoutineForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function typeInto(input: HTMLInputElement, text: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  for (let end = 0; end <= text.length; end++) {
    await act(async () => {
      setValue.call(input, text.slice(0, end));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
}

it.each([["24:00", "00:00"], ["25:99", null], ["9:3", null], ["21:30", "21:30"]])("typing %s leaves the time as %s", async (typed, time) => {
  const seen: Array<string | null> = [];
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(createElement(TimeField, { value: "09:00", onChange: (next: string | null) => seen.push(next) })));
  await typeInto(host.querySelector("input")!, typed);
  expect(seen.at(-1)).toBe(time);
  await act(async () => root.unmount());
});
