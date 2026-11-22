// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { Message } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), useStore: () => ({ dispatch: fixture.dispatch, state: { bots: [] } }) }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
import { PendingApprovalActions, PendingApprovalPanel, pendingApprovals } from "./PendingApproval";
import { ApprovalCard } from "./ApprovalCard";
import { ProductsMessage } from "./ReviewCards";

const purchase = { merchant: "Acme Kitchen", items: [{ name: "Electric kettle", quantity: 2, price: "$40.00" }], total: "$85.00", shipping: "$5.00", paymentMethod: "Visa •••• 4242", address: "1 Main St, Springfield", delivery: "Fri, Nov 21" };
const email = { app: "Gmail", to: ["sam@example.com"], subject: "Friday", body: "See you at 5." };
const card = (extra: Partial<NonNullable<Message["card"]>>): Message => ({
  id: "m1", at: 1, role: "bot", kind: "options",
  card: { title: "Confirm purchase", subtitle: "", options: [], requestId: "r1", tool: "confirm_purchase", outboundRequest: { tool: "confirm_purchase", app: null, purchase: true }, ...extra },
});

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  fixture.dispatch.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function pendingView(message: Message) {
  const pending = pendingApprovals([message])[0]!;
  act(() => root.render(createElement("div", null,
    createElement(PendingApprovalPanel, { pending, count: 1, index: 0, botName: "Pepper",
      actions: createElement(PendingApprovalActions, { part: "primary", pending, threadId: "t1", onCancelTurn: vi.fn() }) }))));
  const button = (name: string) => [...container.querySelectorAll("button")].find((node) => node.textContent === name);
  return { button };
}

describe("the purchase card", () => {
  it("shows the whole order and goes ahead only on Confirm purchase", () => {
    const { button } = pendingView(card({ purchase }));
    const text = container.textContent ?? "";
    for (const part of ["Confirm purchase", "Acme Kitchen", "2 ×", "Electric kettle", "$40.00", "Shipping", "$5.00", "Total", "$85.00", "Visa •••• 4242", "1 Main St, Springfield", "Fri, Nov 21"]) expect(text).toContain(part);
    expect(button("Always allow")).toBeUndefined();
    act(() => button("Cancel")!.click());
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ type: "decideRequest", requestId: "r1", behavior: "deny" }));
    act(() => button("Confirm purchase")!.click());
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: "allow", edits: undefined }));
  });

  it("scrolls a long order inside the card, so the card never grows past a phone's screen and its buttons stay put", () => {
    const items = Array.from({ length: 30 }, (_, index) => ({ name: `Item ${index}`, quantity: 1, price: "$1.00" }));
    pendingView(card({ purchase: { ...purchase, items } }));
    const list = container.querySelector("[data-purchase-items]")!;
    expect(list.querySelectorAll("li")).toHaveLength(30);
    expect(list.className).toMatch(/\bmax-h-40\b/);
    expect(list.className).toMatch(/\boverflow-y-auto\b/);
  });

  it("stays in the chat as the record once answered", () => {
    act(() => root.render(createElement(ApprovalCard, { message: card({ purchase: { ...purchase, recorded: true }, answered: "allow" }) })));
    expect(container.textContent).toContain("Order at Acme Kitchen");
    expect(container.textContent).toContain("Bought without asking first, as you said");
  });
});

describe("the email card", () => {
  const message = card({ title: "Send this email?", tool: "GMAIL_SEND_EMAIL", email, outboundRequest: { tool: "GMAIL_SEND_EMAIL", app: "Gmail" } });

  it("shows recipients, subject and the whole text, and sends it as written", () => {
    const { button } = pendingView(message);
    for (const part of ["Send this email?", "sam@example.com", "Friday", "See you at 5."]) expect(container.textContent).toContain(part);
    act(() => button("Send email")!.click());
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: "allow", edits: undefined }));
  });

  it("sends the person's edits, and will not send an address that is not one", () => {
    const { button } = pendingView(message);
    act(() => button("Edit")!.click());
    const body = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Email text"]')!;
    const to = container.querySelector<HTMLInputElement>('input[aria-label="To"]')!;
    const type = (field: HTMLInputElement | HTMLTextAreaElement, value: string) => act(() => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    type(to, "nobody");
    expect(button("Send email")!.disabled).toBe(true);
    type(to, "sam@example.com, kim@example.com");
    type(body, "See you at 6.");
    act(() => button("Send email")!.click());
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: "allow", edits: { to: ["sam@example.com", "kim@example.com"], subject: "Friday", body: "See you at 6." } }));
  });
});

describe("the message card", () => {
  const slack = { app: "Slack", to: "#launch", text: "Shipping at 5", attachments: 2 };
  const message = card({ title: "Send this message?", tool: "SLACK_SEND_MESSAGE", messageReview: slack, outboundRequest: { tool: "SLACK_SEND_MESSAGE", app: "Slack" } });
  const type = (field: HTMLTextAreaElement, value: string) => act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });

  it("shows where it goes and the whole text, never the raw call, and sends the person's edit", () => {
    const { button } = pendingView(message);
    for (const part of ["Send this message?", "To", "#launch", "Shipping at 5", "2 attachments"]) expect(container.textContent).toContain(part);
    expect(container.textContent).not.toContain("{");
    expect(button("Always allow")).toBeUndefined();
    act(() => button("Edit")!.click());
    const text = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message text"]')!;
    type(text, "  ");
    expect(button("Send")!.disabled).toBe(true);
    type(text, "Shipping at 6");
    act(() => button("Send")!.click());
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: "allow", edits: { text: "Shipping at 6" } }));
  });

  it("asks Post this? for a public post, and Don't send refuses it", () => {
    const { button } = pendingView(card({ title: "Post this?", tool: "TWITTER_CREATION_OF_A_POST", messageReview: { app: "X", to: "", text: "We launched.", post: true }, outboundRequest: { tool: "TWITTER_CREATION_OF_A_POST", app: "X" } }));
    for (const part of ["Post this?", "On", "X", "We launched."]) expect(container.textContent).toContain(part);
    expect(button("Post")).toBeDefined();
    act(() => button("Don't send")!.click());
    expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: "deny" }));
  });

  it("offers no Edit for app-formatted text", () => {
    const { button } = pendingView(card({ title: "Send this message?", messageReview: { app: "Microsoft Teams", to: "19:abc", text: "Hi team", fixed: true }, outboundRequest: { tool: "MICROSOFT_TEAMS_TEAMS_POST_CHAT_MESSAGE", app: "Microsoft Teams" } }));
    expect(button("Edit")).toBeUndefined();
    expect(button("Send")).toBeDefined();
  });

  it("stays in the chat as the record once answered", () => {
    act(() => root.render(createElement(ApprovalCard, { message: card({ title: "Send this message?", messageReview: slack, answered: "deny" }) })));
    expect(container.querySelector("[data-review-record]")?.getAttribute("data-review-record")).toBe("message");
    for (const part of ["Message via Slack", "#launch", "Shipping at 5", "Not sent"]) expect(container.textContent).toContain(part);
  });
});

describe("product cards", () => {
  it("lists each product with its price and link, and loads photos only when asked", () => {
    const message = { id: "p1", at: 1, role: "bot", kind: "widget", text: "", products: { title: "Kettles", items: [
      { name: "Steel kettle", price: "$39", url: "https://shop.example/a", image: "https://shop.example/a.jpg", merchant: "Acme" },
      { name: "Glass kettle", price: "$45", url: "https://shop.example/b" },
    ] } } as Message;
    act(() => root.render(createElement(ProductsMessage, { message })));
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.textContent).toContain("Steel kettle$39Acme");
    expect(container.querySelectorAll("img")).toHaveLength(0);
    act(() => [...container.querySelectorAll("button")].find((node) => node.textContent === "Show photos")!.click());
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://shop.example/a.jpg");
    expect(container.querySelector('a[href="https://shop.example/b"]')).not.toBeNull();
  });
});
