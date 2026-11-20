import { afterEach, describe, expect, it, vi } from "vitest";
import { inThreadOrder, SEND_ORDER_WAIT_MS } from "./send-order";

afterEach(() => vi.useRealTimers());

const later = () => {
  let settle!: (ok: boolean) => void;
  const promise = new Promise<string>((done, fail) => { settle = (ok) => (ok ? done("ok") : fail(new Error("lost"))); });
  return { promise, settle };
};
const OFFLINE = true, ONLINE = false;

describe("sends in one conversation", () => {
  it("reach the server in the order they were written when the first went out offline and is still retrying", async () => {
    const order: string[] = [];
    const first = later();
    const a = inThreadOrder("t1", () => { order.push("A"); return first.promise; }, SEND_ORDER_WAIT_MS, OFFLINE);
    const b = inThreadOrder("t1", async () => { order.push("B"); return "ok"; }, SEND_ORDER_WAIT_MS, ONLINE);
    const c = inThreadOrder("t1", async () => { order.push("C"); return "ok"; }, SEND_ORDER_WAIT_MS, ONLINE);
    await Promise.resolve();
    expect(order).toEqual(["A"]);
    first.settle(true);
    await Promise.all([a, b, c]);
    expect(order).toEqual(["A", "B", "C"]);
  });

  it("go at once while the device is online", async () => {
    const order: string[] = [];
    void inThreadOrder("t2", () => { order.push("A"); return new Promise(() => {}); }, SEND_ORDER_WAIT_MS, ONLINE);
    await inThreadOrder("t2", async () => { order.push("B"); return "ok"; }, SEND_ORDER_WAIT_MS, ONLINE);
    expect(order).toEqual(["A", "B"]);
  });

  it("go on after an earlier send fails, and never wait on another conversation", async () => {
    const order: string[] = [];
    const first = later();
    const a = inThreadOrder("t3", () => { order.push("A"); return first.promise; }, SEND_ORDER_WAIT_MS, OFFLINE);
    const other = inThreadOrder("u3", async () => { order.push("other"); return "ok"; }, SEND_ORDER_WAIT_MS, OFFLINE);
    const b = inThreadOrder("t3", async () => { order.push("B"); return "ok"; }, SEND_ORDER_WAIT_MS, ONLINE);
    await other;
    expect(order).toEqual(["A", "other"]);
    first.settle(false);
    await expect(a).rejects.toThrow("lost");
    await b;
    expect(order).toEqual(["A", "other", "B"]);
  });

  it("go anyway once an earlier offline send has been stuck for the wait", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    void inThreadOrder("t4", () => { order.push("A"); return new Promise(() => {}); }, SEND_ORDER_WAIT_MS, OFFLINE);
    const b = inThreadOrder("t4", async () => { order.push("B"); return "ok"; }, SEND_ORDER_WAIT_MS, ONLINE);
    await vi.advanceTimersByTimeAsync(SEND_ORDER_WAIT_MS - 1);
    expect(order).toEqual(["A"]);
    await vi.advanceTimersByTimeAsync(1);
    await b;
    expect(order).toEqual(["A", "B"]);
  });
});
