// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { initialState, type Bot } from "@/state/store";

const dispatch = vi.fn();
const bots = ["Pepper", "Quill", "Nova", "Rivet", "Moss"].map((name) => ({ id: name.toLowerCase(), name }) as Bot);
vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), useStore: () => ({ state: { ...initialState, bots }, dispatch }) }));
vi.mock("@/lib/analytics", () => ({ track: () => {} }));

import { defaultGroupName, NewRoomPanel } from "./SidebarNewRoomPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
  dispatch.mockReset();
});

const createButton = () => [...document.querySelectorAll("button")].find((button) => button.textContent === "Create group chat")!;
const tick = async (name: string) => {
  const row = document.querySelector<HTMLElement>(`[aria-label="${name}"]`)!;
  await act(async () => { row.click(); });
};

it("names a group after its bots, two or three in full and the rest as a count", () => {
  expect(defaultGroupName(["Pepper", "Quill"])).toBe("Pepper and Quill");
  expect(defaultGroupName(["Pepper", "Quill", "Nova"])).toBe("Pepper, Quill, and Nova");
  expect(defaultGroupName(["Pepper", "Quill", "Nova", "Rivet", "Moss"])).toBe("Pepper, Quill, and 3 more");
});

it("needs two bots before a group chat can be made, and an unnamed group is named after them", async () => {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => { root.render(createElement(NewRoomPanel, { onClose: () => {} })); });

  await tick("Pepper");
  expect(createButton().disabled).toBe(true);
  expect(document.body.textContent).toContain("Pick at least two bots.");
  expect(document.getElementById(createButton().getAttribute("aria-describedby")!)?.textContent).toBe("Pick at least two bots.");
  await act(async () => { createButton().click(); });
  expect(dispatch).not.toHaveBeenCalled();

  await tick("Quill");
  expect(createButton().disabled).toBe(false);
  expect(document.body.textContent).not.toContain("Pick at least two bots.");
  expect(createButton().hasAttribute("aria-describedby")).toBe(false);
  expect(document.querySelector("input")!.placeholder).toBe("Pepper and Quill");
  await act(async () => { createButton().click(); });
  expect(dispatch).toHaveBeenCalledWith({ type: "createGroup", memberIds: ["pepper", "quill"], name: "Pepper and Quill" });
  await act(async () => { root.unmount(); });
});
