// The shopping tools of the agents catalog: the "Confirm purchase" card a bot posts before it buys, and product results
// shown as cards.
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

export const CONFIRM_PURCHASE_PATH = "/api/internal/purchase/confirm";
const PRODUCTS_ROUTE = "/api/internal/options-card";

export const PURCHASE_TOOL_NAMES: ReadonlySet<string> = new Set(["confirm_purchase", "show_products"]);

const str = { type: "string" };

export const PURCHASE_TOOL_DEFINITIONS = [
  {
    name: "confirm_purchase",
    description:
      "Required before a purchase's final step (Place order, Buy now, Pay, Book, Subscribe, sending money): shows the person the order summary from the checkout page and waits for their tap; the browser refuses that step until they confirm. Money as the page shows it; payment masked to its last four. Confirmed: take the step once. Cancelled: do not buy. Only if the person said to buy without asking, set without_asking with their exact words as quote; the card is then a record. Not for a free calendar invite.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: {
          type: "object",
          additionalProperties: false,
          properties: {
            merchant: str,
            items: { type: "array", items: { type: "object", additionalProperties: false, properties: { name: str, quantity: { type: "integer" }, price: str }, required: ["name", "quantity"] } },
            total: { type: "string", description: "Shipping and tax included." },
            shipping: str,
            payment_method: str,
            address: str,
            delivery: str,
            url: str,
            kind: { type: "string", enum: ["order", "booking", "subscription", "payment"] },
          },
          required: ["merchant", "items", "total"],
        },
        without_asking: { type: "boolean" },
        quote: str,
      },
      required: ["summary"],
    },
  },
  {
    name: "show_products",
    description:
      "Show shopping results as cards in the chat: photo, name, price, link. Real products from pages you read, https links and image addresses. Then say in a sentence which you would pick.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: str,
        products: {
          type: "array",
          maxItems: 12,
          items: { type: "object", additionalProperties: false, properties: { name: str, price: str, url: str, image: str, merchant: str, note: str }, required: ["name", "url"] },
        },
      },
      required: ["products"],
    },
  },
];

export async function callPurchaseTool(name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  if (name === "show_products") {
    const { ok, body } = await context.client.apiResponse(PRODUCTS_ROUTE, {
      method: "POST",
      body: JSON.stringify({ tool: "show_products", ...(args.title !== undefined ? { title: args.title } : {}), products: args.products }),
    });
    return ok
      ? { text: `Shown as product cards (message ${String(body.messageId ?? "")}). Do not list them again in text; add a sentence on which you would pick.` }
      : { text: String(body.error ?? "Could not show those products."), isError: true };
  }
  const { ok, body } = await context.client.apiResponse(CONFIRM_PURCHASE_PATH, {
    method: "POST",
    body: JSON.stringify({ summary: args.summary, without_asking: args.without_asking === true, ...(typeof args.quote === "string" ? { quote: args.quote } : {}) }),
  });
  return ok ? { text: String(body.text ?? "Confirmed.") } : { text: String(body.error ?? "The purchase was not confirmed. Do not buy."), isError: true };
}
