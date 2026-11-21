// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { PlatformContext, type MobilePlatform } from "../platform";
import { TableViewer } from "./TableViewer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

const PLANS = ["Free", "Pro", "Team", "Enterprise", "Basic", "Plus", "Max", "Studio", "School", "Nonprofit"];
const columns = [{ text: "Plan" }, { text: "Seats" }];
const rows = (count: number) => PLANS.slice(0, count).map((plan, index) => [{ text: plan }, { text: String((index * 7) % 11) }]);

async function open(count: number) {
  const phone = { kind: "ios", native: true } as unknown as MobilePlatform;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(PlatformContext, { value: phone },
    createElement(TableViewer, { columns, rows: rows(count), name: "Plans", open: true, onClose: () => {} }))));
  return host;
}

const firstColumn = (el: Element) => [...el.querySelectorAll("tbody tr")].map((row) => row.querySelector("td")!.textContent);

describe("the phone's full-screen table", () => {
  it("sorts by a column whose name is tapped, then the other way, then back to the reply's order", async () => {
    const el = await open(4);
    const seats = el.querySelectorAll<HTMLButtonElement>("thead button")[1]!;
    await act(async () => seats.click());
    expect(firstColumn(el)).toEqual(["Free", "Team", "Pro", "Enterprise"]);
    expect(seats.closest("th")!.getAttribute("aria-sort")).toBe("ascending");
    await act(async () => seats.click());
    expect(firstColumn(el)).toEqual(["Enterprise", "Pro", "Team", "Free"]);
    expect(seats.closest("th")!.getAttribute("aria-sort")).toBe("descending");
    await act(async () => seats.click());
    expect(firstColumn(el)).toEqual(["Free", "Pro", "Team", "Enterprise"]);
  });

  it("lines a column of figures up on the right", async () => {
    const el = await open(4);
    expect([...el.querySelectorAll<HTMLElement>("tbody tr:first-child td")].map((td) => td.style.textAlign)).toEqual(["left", "right"]);
  });

  it("can search a long table, and says in the search field how many rows match", async () => {
    expect((await open(8)).querySelector("input[type=search]")).toBeNull();
    act(() => root!.unmount());
    host!.remove();
    const el = await open(10);
    const search = el.querySelector<HTMLInputElement>("input[type=search]")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "pro");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(firstColumn(el)).toEqual(["Pro", "Nonprofit"]);
    expect(search.closest("label")!.querySelector("[role=status]")!.textContent).toBe("2 rows");
  });
});
