// Products a bot found, shown as cards in the chat (show_products).

export interface ProductResult {
  name: string;
  /** The product page, https only. */
  url: string;
  /** As the shop shows it, currency included. */
  price?: string;
  /** An https photo address. Security: clients load it only after the person asks to see photos. */
  image?: string;
  merchant?: string;
  note?: string;
}

export interface ProductsCard {
  title?: string;
  items: ProductResult[];
}

/** On a bot's line: products it found (show_products), drawn as cards; the line's `text` lists them for everything else. */
export interface ProductsField {
  products?: ProductsCard;
}

const MAX_PRODUCTS = 12;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().replace(/\s+/gu, " ").slice(0, max) : undefined;

function https(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_048) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function parseProductsCard(input: unknown): { ok: true; value: ProductsCard } | { ok: false; error: string } {
  if (!isRecord(input) || !Array.isArray(input.products) || input.products.length === 0) {
    return { ok: false, error: "products: give at least one product, each {name, url, price?, image?, merchant?, note?}." };
  }
  if (input.products.length > MAX_PRODUCTS) return { ok: false, error: `products: at most ${MAX_PRODUCTS}; show the best ones.` };
  const items: ProductResult[] = [];
  for (const [index, raw] of input.products.entries()) {
    const name = isRecord(raw) ? text(raw.name, 200) : undefined;
    const url = isRecord(raw) ? https(raw.url) : undefined;
    if (!isRecord(raw) || !name || !url) return { ok: false, error: `products[${index}]: needs a name and an https product page url.` };
    const price = text(raw.price, 60);
    const image = https(raw.image);
    const merchant = text(raw.merchant, 80);
    const note = text(raw.note, 160);
    items.push({ name, url, ...(price ? { price } : {}), ...(image ? { image } : {}), ...(merchant ? { merchant } : {}), ...(note ? { note } : {}) });
  }
  const title = text(input.title, 120);
  return { ok: true, value: { ...(title ? { title } : {}), items } };
}

/** The products as plain text, for previews, notifications and clients that draw no cards. */
export function productsText(card: ProductsCard): string {
  const lines = card.items.map((item) => `${item.name}${item.price ? `, ${item.price}` : ""}${item.merchant ? ` at ${item.merchant}` : ""}: ${item.url}`);
  return [card.title, ...lines].filter(Boolean).join("\n");
}
