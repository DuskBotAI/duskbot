import { describe, expect, it } from "vitest";

import { COMPUTER_PURCHASE_REFUSAL, ComputerPurchasePasses, ComputerPurchaseWatch, PURCHASE_QUERY } from "./computer-purchase.ts";

const call = (name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
const answer = (text: string) => ({ content: [{ type: "text", text }] });

const checkoutWindow = answer([
  "Window: \"Checkout - Acme Home\" (Safari) https://shop.example.com/checkout/payment",
  "[3] AXTextField \"Card number\"",
  "[7] AXButton \"Apply\"",
  "[9] AXButton \"Place your order\"",
].join("\n"));
const productWindow = answer("title: Breville Kettle | Acme Home https://shop.example.com/p/breville\n[2] AXButton \"Add to cart\"\n[4] AXButton \"Buy now\"");

describe("a computer's screen and the last step of a purchase", () => {
  it("marks a click on an element whose label finishes a purchase, not one that does not", () => {
    const watch = new ComputerPurchaseWatch();
    watch.observe(checkoutWindow);
    expect(watch.finishes(call("click", { pid: 7, window_id: 3, element_index: 9 }))).toBe(true);
    expect(watch.finishes(call("click", { pid: 7, window_id: 3, element_index: 7 }))).toBe(false);
    expect(watch.query(call("click", { element_index: 9 }))).toEqual({ [PURCHASE_QUERY]: "1" });
    expect(watch.query(call("screenshot", {}))).toEqual({});
  });

  it("on a checkout page, a click by point or on an element it never saw counts, and so do Enter and a typed line break", () => {
    const watch = new ComputerPurchaseWatch();
    watch.observe(checkoutWindow);
    expect(watch.finishes(call("click", { x: 640, y: 520 }))).toBe(true);
    expect(watch.finishes(call("click", { element_index: 42 }))).toBe(true);
    expect(watch.finishes(call("press_key", { key: "Return" }))).toBe(true);
    expect(watch.finishes(call("hotkey", { keys: "cmd+enter" }))).toBe(true);
    expect(watch.finishes(call("type_text", { element_index: 3, text: "4242 4242 4242 4242" }))).toBe(false);
    expect(watch.finishes(call("type_text", { text: "yes\n" }))).toBe(true);
  });

  it("a window showing Buy now counts as a checkout, a plain one does not, and a driver browser click is named by its text", () => {
    const watch = new ComputerPurchaseWatch();
    watch.observe(productWindow);
    expect(watch.finishes(call("click", { x: 10, y: 20 }))).toBe(true);
    const plain = new ComputerPurchaseWatch();
    plain.observe(answer("title: Inbox - Mail\n[2] AXButton \"Archive\""));
    expect(plain.finishes(call("click", { x: 10, y: 20 }))).toBe(false);
    expect(plain.finishes(call("press_key", { key: "Enter" }))).toBe(false);
    const product = new ComputerPurchaseWatch();
    product.observe(answer("title: Breville Kettle https://shop.example.com/p/breville\n[2] AXButton \"Add to cart\""));
    expect(product.finishes(call("click", { element_index: 2 }))).toBe(false);
    expect(product.finishes(call("browser_click", { text: "Buy now" }))).toBe(true);
  });

  it("the harness refuses a marked call until the conversation's purchase is confirmed, for ten minutes", () => {
    const now = { t: 0 };
    const passes = new ComputerPurchasePasses(() => now.t);
    const marked = new URLSearchParams({ [PURCHASE_QUERY]: "1" });
    expect(passes.hold("t1", new URLSearchParams())).toBeNull();
    expect(passes.hold("t1", marked)).toEqual({ held: true, helpOpen: false, blockedReason: COMPUTER_PURCHASE_REFUSAL });
    passes.grant("t1");
    expect(passes.hold("t1", marked)).toBeNull();
    expect(passes.hold("t2", marked)).not.toBeNull();
    now.t = 11 * 60_000;
    expect(passes.hold("t1", marked)).not.toBeNull();
  });
});
