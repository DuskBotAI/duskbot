import { describe, expect, it } from "vitest";

import { editedEmailArguments, emailReviewOf, normalizeEmailEdits } from "./email-review.ts";
import { liveCardKind, liveDecisionRefusal } from "./live-approval.ts";
import { isOutboundTool } from "./outbound.ts";
import { finishesPurchase, isPurchaseTool, maskPaymentMethod, parsePurchaseSummary } from "./purchase.ts";
import { parseProductsCard } from "./products.ts";

describe("app tools that buy", () => {
  it.each([
    "SHOPIFY_CREATE_ORDER", "STRIPE_CREATE_PAYMENT_INTENT", "PAYPAL_CREATE_PAYMENT", "AMAZON_PLACE_ORDER", "CALENDLY_BOOK_MEETING_SLOT",
    "STRIPE_CREATE_SUBSCRIPTION", "WISE_CREATE_TRANSFER", "mcp__composio__SQUARE_CREATE_PAYMENT",
  ])("%s waits on Confirm purchase and counts as outbound", (slug) => {
    expect(isPurchaseTool(slug)).toBe(true);
    expect(isOutboundTool(slug)).toBe(true);
  });

  it.each(["SHOPIFY_GET_ORDER", "SHOPIFY_LIST_ORDERS", "STRIPE_REFUND_PAYMENT", "SHOPIFY_UPDATE_ORDER", "STRIPE_CANCEL_SUBSCRIPTION", "GMAIL_SEND_EMAIL", "TODOIST_REORDER_TASKS"])("%s does not", (slug) => {
    expect(isPurchaseTool(slug)).toBe(false);
  });
});

describe("a purchase's last step on a page", () => {
  it.each([
    ["Place your order", "https://www.amazon.com/gp/buy/spc/handlers/display.html"],
    ["Buy now", "https://shop.example/product/1"],
    ["Pay $45.00", "https://shop.example/checkout/payment"],
    ["Complete purchase", "https://shop.example/cart"],
    ["Book now", "https://hotel.example/rooms"],
    ["Subscribe", "https://news.example/subscribe/checkout"],
    ["Realizar pedido", "https://tienda.example/checkout"],
    ["Jetzt kaufen", "https://laden.example/kasse"],
    ["注文を確定する", "https://shop.example.jp/checkout"],
  ])("%s on %s", (name, page) => {
    expect(finishesPurchase(name, page)).toBe(true);
  });

  it.each([
    ["Add to cart", "https://shop.example/product/1"],
    ["Proceed to checkout", "https://shop.example/cart"],
    ["Continue to payment", "https://shop.example/checkout/shipping"],
    ["Subscribe", "https://youtube.example/channel"],
    ["Pay bills", "https://bank.example/home"],
    ["Purchase history", "https://shop.example/account"],
    ["Payment methods", "https://shop.example/checkout"],
    ["Search", "https://shop.example/checkout"],
  ])("not %s on %s", (name, page) => {
    expect(finishesPurchase(name, page)).toBe(false);
  });
});

describe("the order summary", () => {
  it("keeps what the card shows and masks a full card number", () => {
    const parsed = parsePurchaseSummary({
      merchant: "Acme", items: [{ name: "Kettle", quantity: 2, price: "$20.00" }], total: "$45.00", shipping: "$5.00",
      payment_method: "Visa 4111 1111 1111 4242", address: "1 Main St", delivery: "Fri, Nov 21", url: "javascript:alert(1)",
    });
    expect(parsed).toEqual({ ok: true, value: {
      merchant: "Acme", items: [{ name: "Kettle", quantity: 2, price: "$20.00" }], total: "$45.00", shipping: "$5.00",
      paymentMethod: "Visa •••• 4242", address: "1 Main St", delivery: "Fri, Nov 21",
    } });
    expect(maskPaymentMethod("Mastercard ending 5555")).toBe("Mastercard ending 5555");
  });

  it("refuses a summary without what the person needs to decide", () => {
    expect(parsePurchaseSummary({ merchant: "Acme", items: [{ name: "Kettle", quantity: 1 }] })).toMatchObject({ ok: false, error: expect.stringMatching(/total/) });
    expect(parsePurchaseSummary({ merchant: "Acme", items: [], total: "$1" })).toMatchObject({ ok: false, error: expect.stringMatching(/items/) });
    expect(parsePurchaseSummary({ merchant: "Acme", items: [{ name: "Kettle", quantity: 0 }], total: "$1" })).toMatchObject({ ok: false });
  });
});

describe("the email review", () => {
  it("reads Gmail and Outlook sends, and nothing it cannot show whole", () => {
    expect(emailReviewOf([{ slug: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "a@x.com", extra_recipients: ["b@x.com"], cc: ["c@x.com"], subject: "Hi", body: "Hello" } }]))
      .toEqual({ app: "Gmail", to: ["a@x.com", "b@x.com"], cc: ["c@x.com"], subject: "Hi", body: "Hello" });
    expect(emailReviewOf([{ slug: "OUTLOOK_SEND_EMAIL", arguments: { to_email: "a@x.com", subject: "Hi", body: "Hello" } }]))
      .toEqual({ app: "Outlook", to: ["a@x.com"], subject: "Hi", body: "Hello" });
    expect(emailReviewOf([{ slug: "GMAIL_REPLY_TO_THREAD", arguments: { thread_id: "t", message_body: "Thanks!", recipient_email: "a@x.com" } }]))
      .toMatchObject({ app: "Gmail", reply: true, body: "Thanks!" });
    expect(emailReviewOf([{ slug: "GMAIL_SEND_DRAFT", arguments: { draft_id: "d1" } }])).toBeNull();
    expect(emailReviewOf([{ slug: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "a@x.com", body: "" } }])).toBeNull();
  });

  it("writes edits where each app reads them, and refuses an address that is not one", () => {
    expect(normalizeEmailEdits({ to: "a@x.com; nope" })).toBeNull();
    expect(normalizeEmailEdits({ body: "  " })).toBeNull();
    const outlook = { slug: "OUTLOOK_SEND_EMAIL", arguments: { to_email: "a@x.com", subject: "Hi", body: "Hello" } };
    expect(editedEmailArguments(outlook, { to: ["b@x.com", "c@x.com"], subject: "Hey" })).toEqual({ to_email: "b@x.com, c@x.com", subject: "Hey", body: "Hello" });
    const gmail = { slug: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "a@x.com", extra_recipients: ["b@x.com"], body: "Hello" } };
    expect(editedEmailArguments(gmail, { to: ["c@x.com"] })).toEqual({ recipient_email: "c@x.com", body: "Hello" });
  });
});

describe("a voice call never confirms a purchase", () => {
  it("reads every purchase card as one to review on screen", () => {
    const card = { title: "Confirm purchase", subtitle: "", options: [], requestId: "r1", tool: "confirm_purchase" };
    expect(liveCardKind({ ...card, purchase: { merchant: "Acme", items: [{ name: "Kettle", quantity: 1 }], total: "$1" } })).toBe("review");
    expect(liveCardKind({ ...card, tool: "SHOPIFY_CREATE_ORDER", outboundRequest: { tool: "SHOPIFY_CREATE_ORDER", app: "Shopify", purchase: true } })).toBe("review");
    expect(liveDecisionRefusal({ ...card, tool: "STRIPE_CREATE_PAYMENT_INTENT" })).toMatch(/on screen/);
    expect(liveCardKind({ ...card, tool: "GMAIL_SEND_EMAIL" })).toBe("approval");
  });
});

describe("product cards", () => {
  it("keeps https links and photos only", () => {
    expect(parseProductsCard({ products: [{ name: "Mug", url: "https://shop.example/mug", image: "http://shop.example/mug.jpg", price: "$9" }] }))
      .toEqual({ ok: true, value: { items: [{ name: "Mug", url: "https://shop.example/mug", price: "$9" }] } });
    expect(parseProductsCard({ products: [{ name: "Mug", url: "javascript:alert(1)" }] })).toMatchObject({ ok: false });
    expect(parseProductsCard({ products: [] })).toMatchObject({ ok: false });
  });
});
