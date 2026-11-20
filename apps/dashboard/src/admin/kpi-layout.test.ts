import { expect, test } from "vitest";
import { KPI_IDS, KPI_KEY, loadLayout, mainOf, moveTo, normalOrder, saveLayout, slotAt, tintOf, type KpiLayout } from "./kpi-layout";

function memory() {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
}

test("nothing stored gives today's strip: trials first and green, the rest plain", () => {
  const layout = loadLayout(memory());
  expect(layout.order).toEqual([...KPI_IDS]);
  expect(layout.order[0]).toBe("trials");
  expect(tintOf(layout, "trials")).toBe("green");
  expect(tintOf(layout, "trial mrr")).toBe("none");
  expect(tintOf(layout, "visitors")).toBe("none");
});

test("order and colours survive a save and load", () => {
  const store = memory();
  const layout: KpiLayout = { order: moveTo([...KPI_IDS], "visitors", 0), tints: { "trial mrr": "purple", cancelling: "none" } };
  saveLayout(layout, store);
  const back = loadLayout(store);
  expect(back.order.slice(0, 2)).toEqual(["visitors", "trials"]);
  expect(tintOf(back, "trial mrr")).toBe("purple");
  expect(tintOf(back, "cancelling")).toBe("none");
});

test("saving the default layout clears the stored key", () => {
  const store = memory();
  saveLayout({ order: ["signups", ...KPI_IDS.filter((id) => id !== "signups")], tints: {} }, store);
  expect(store.data.has(KPI_KEY)).toBe(true);
  saveLayout({ order: [...KPI_IDS], tints: { trials: "green" } }, store);
  expect(store.data.has(KPI_KEY)).toBe(false);
});

test("a stored strip from the revenue-first panel drops its old cards and keeps the rest", () => {
  const store = memory();
  store.setItem(KPI_KEY, "{not json");
  expect(loadLayout(store).order).toEqual([...KPI_IDS]);
  store.setItem(KPI_KEY, JSON.stringify({ order: ["mrr", "signups", "signups", "revenue", "visitors"], tints: { mrr: "green", visitors: "neon", signups: "blue" } }));
  const layout = loadLayout(store);
  expect(layout.order).toHaveLength(KPI_IDS.length);
  expect(layout.order.slice(0, 3)).toEqual(["signups", "visitors", "trials"]);
  expect(layout.tints).toEqual({ signups: "blue" });
  expect(mainOf(layout)).toBe("trials");
  expect(normalOrder(null)).toEqual([...KPI_IDS]);
});

test("moveTo shifts one card and clamps at the ends", () => {
  const order = [...KPI_IDS];
  expect(moveTo(order, "trials", 1).slice(0, 2)).toEqual(["trial to paid", "trials"]);
  expect(moveTo(order, "trials", -1)).toBe(order);
  expect(moveTo(order, "signups", 0)[0]).toBe("signups");
});

test("slotAt finds the box under a point", () => {
  const boxes = [{ left: 0, top: 0, width: 100, height: 50 }, { left: 106, top: 0, width: 100, height: 50 }];
  expect(slotAt(boxes, 150, 20)).toBe(1);
  expect(slotAt(boxes, 103, 20)).toBeNull();
});

test("the chart draws trials while their card is green, and nothing when it is not", () => {
  const store = memory();
  expect(mainOf(loadLayout(store))).toBe("trials");
  saveLayout({ order: [...KPI_IDS], tints: { trials: "none", visitors: "green" } }, store);
  expect(mainOf(loadLayout(store))).toBeNull();
});
