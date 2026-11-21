// A small loopback website for the computer and developer scenarios: a support form that rejects a badly written phone
// number once, a three-page catalog with a cart, a page with a CSV report to download, a JSON API and a tiny Python
// project with a failing test. Every conversation gets its own path prefix, and what it really did there (form posts,
// cart, downloads) is kept as ground truth for the judge.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface SiteLog {
  requests: number;
  submissions: Array<{ ok: boolean; fields: Record<string, string>; error?: string; ticket?: string; shown?: string }>;
  cart: Record<string, number>;
  cartViews: number;
  downloads: string[];
}

export const PRODUCTS = [
  { sku: "L-101", name: "Arc desk lamp", price: 2499, stock: 4 },
  { sku: "M-201", name: "Blue ceramic mug", price: 349, stock: 0 },
  { sku: "N-301", name: "Dot grid notebook", price: 199, stock: 25 },
  { sku: "L-102", name: "Mini clip lamp", price: 899, stock: 0 },
  { sku: "P-401", name: "Brass pen", price: 1299, stock: 7 },
  { sku: "M-202", name: "White ceramic mug", price: 299, stock: 12 },
  { sku: "L-103", name: "Folding desk lamp", price: 1149, stock: 9 },
  { sku: "S-501", name: "Monitor stand", price: 1899, stock: 3 },
  { sku: "N-302", name: "Lined notebook", price: 179, stock: 0 },
  { sku: "L-104", name: "Wooden desk lamp", price: 1049, stock: 2 },
  { sku: "C-601", name: "Cable organiser", price: 249, stock: 30 },
  { sku: "M-203", name: "Travel mug", price: 649, stock: 6 },
];

/** West has the most revenue (₹82,926) of ₹2,29,006 in all; Arc desk lamp sells the most (₹49,980). */
export const SALES_CSV = `date,region,product,units,unit_price
2026-03-02,North,Arc desk lamp,6,2499
2026-03-04,West,Monitor stand,20,1899
2026-03-07,South,Brass pen,15,1299
2026-03-09,East,Dot grid notebook,120,199
2026-03-12,West,Arc desk lamp,14,2499
2026-03-15,North,Travel mug,40,649
2026-03-18,South,Folding desk lamp,18,1149
2026-03-21,East,White ceramic mug,60,299
2026-03-24,West,Cable organiser,40,249
2026-03-27,North,Brass pen,10,1299
2026-03-30,South,Dot grid notebook,51,199
`;

/** A Python project whose test fails: median() forgets to sort and takes the wrong middle for an even count. */
export const PY_STATS = `def mean(values):
    return sum(values) / len(values)


def median(values):
    n = len(values)
    mid = n // 2
    if n % 2 == 1:
        return values[mid]
    return (values[mid] + values[mid + 1]) / 2
`;
export const PY_TEST = `from stats import mean, median


def test_mean():
    assert mean([1, 2, 3, 4]) == 2.5


def test_median_odd():
    assert median([5, 1, 3]) == 3


def test_median_even():
    assert median([4, 1, 3, 2]) == 2.5
`;

const esc = (v: string) => v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font-family:sans-serif;max-width:720px;margin:24px auto}label{display:block;margin:10px 0}.error{color:#b00}</style></head><body><nav><a href="./">Home</a> · <a href="contact">Support</a> · <a href="catalog">Shop</a> · <a href="cart">Cart</a> · <a href="reports">Reports</a></nav><h1>${esc(title)}</h1>${body}</body></html>`;
}

function contactForm(values: Record<string, string>, error?: string): string {
  const v = (k: string) => esc(values[k] ?? "");
  const opt = (o: string) => `<option${values.topic === o ? " selected" : ""}>${o}</option>`;
  return page("Contact support", `${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}<form method="post" action="contact">
<label>Full name <input name="name" value="${v("name")}" required></label>
<label>Email <input name="email" type="email" value="${v("email")}" required></label>
<label>Phone (10 digits, no spaces) <input name="phone" value="${v("phone")}" required></label>
<label>Order number <input name="order" value="${v("order")}"></label>
<label>Topic <select name="topic"><option value="">Choose…</option>${["Billing", "Delivery", "Damaged item", "Other"].map(opt).join("")}</select></label>
<label>Message <textarea name="message" rows="4">${v("message")}</textarea></label>
<label><input type="checkbox" name="urgent" value="yes"${values.urgent ? " checked" : ""}> This is urgent</label>
<button type="submit">Send request</button></form>`);
}

function catalog(pageNo: number): string {
  const per = 4;
  const items = PRODUCTS.slice((pageNo - 1) * per, pageNo * per);
  const pages = Math.ceil(PRODUCTS.length / per);
  const rows = items.map((p) => `<li data-sku="${p.sku}"><b>${esc(p.name)}</b> — ${rupees(p.price)} — ${p.stock ? `${p.stock} in stock` : "Out of stock"}
<form method="post" action="cart/add" style="display:inline"><input type="hidden" name="sku" value="${p.sku}"><label style="display:inline">Qty <input name="qty" type="number" value="1" min="1" style="width:3em"></label> <button${p.stock ? "" : " disabled"}>Add to cart</button></form></li>`).join("\n");
  const nav = Array.from({ length: pages }, (_, i) => i + 1 === pageNo ? `<b>${i + 1}</b>` : `<a href="catalog?page=${i + 1}">${i + 1}</a>`).join(" ");
  return page(`Shop — page ${pageNo} of ${pages}`, `<ul>${rows}</ul><p>Pages: ${nav}</p>`);
}

function cartPage(log: SiteLog): string {
  const lines = Object.entries(log.cart).map(([sku, qty]) => ({ p: PRODUCTS.find((one) => one.sku === sku)!, qty }));
  const total = lines.reduce((sum, line) => sum + line.p.price * line.qty, 0);
  return page("Your cart", lines.length
    ? `<ul>${lines.map(({ p, qty }) => `<li>${esc(p.name)} × ${qty} = ${rupees(p.price * qty)}</li>`).join("")}</ul><p id="total">Total: ${rupees(total)}</p><form method="post" action="cart/clear"><button>Empty cart</button></form><p><button disabled title="Checkout opens on the payment page">Go to payment</button></p>`
    : "<p>Your cart is empty.</p>");
}

async function form(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
}

export async function startSite() {
  const logs = new Map<string, SiteLog>();
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://site");
    const match = /^\/s\/([\w-]+)\/(.*)$/.exec(url.pathname);
    const log = match ? logs.get(match[1]!) : undefined;
    if (!match || !log) { res.writeHead(404); res.end("not found"); return; }
    log.requests++;
    const path = match[2]!;
    const html = (body: string, status = 200) => { res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(body); };
    const back = (to: string) => { res.writeHead(303, { location: to }); res.end(); };
    if (path === "" ) return html(page("Deskwise", `<p>Desk gear, shipped from Pune.</p><ul><li><a href="contact">Contact support</a></li><li><a href="catalog">Shop</a></li><li><a href="reports">Reports</a></li></ul>`));
    if (path === "contact" && req.method === "POST") {
      const fields = await form(req);
      const digits = fields.phone ?? "";
      let error: string | undefined;
      if (!fields.name?.trim() || !fields.email?.includes("@")) error = "Please fill in your name and a valid email.";
      else if (!/^\d{10}$/.test(digits)) error = "Phone must be exactly 10 digits with no spaces or country code.";
      else if (!fields.topic) error = "Please choose a topic.";
      if (error) { log.submissions.push({ ok: false, fields, error }); return html(contactForm(fields, error), 422); }
      const ticket = `DW-${4100 + log.submissions.filter((s) => s.ok).length * 7 + 3}`;
      const shown = `Thanks ${fields.name}. Your ticket number is ${ticket}. We reply within one working day.`;
      log.submissions.push({ ok: true, fields, ticket, shown });
      return html(page("Request received", `<p id="done">${esc(shown).replace(ticket, `<b>${ticket}</b>`)}</p>`));
    }
    if (path === "contact") return html(contactForm({}));
    if (path === "catalog") return html(catalog(Math.min(3, Math.max(1, Number(url.searchParams.get("page")) || 1))));
    if (path === "cart/add" && req.method === "POST") {
      const fields = await form(req);
      const product = PRODUCTS.find((p) => p.sku === fields.sku);
      const qty = Math.max(1, Math.floor(Number(fields.qty) || 1));
      if (!product || !product.stock) return html(page("Not added", "<p class=\"error\">That item is out of stock.</p>"), 409);
      if ((log.cart[product.sku] ?? 0) + qty > product.stock) return html(page("Not added", `<p class="error">Only ${product.stock} left of ${esc(product.name)}.</p>`), 409);
      log.cart[product.sku] = (log.cart[product.sku] ?? 0) + qty;
      return back("../cart");
    }
    if (path === "cart/clear" && req.method === "POST") { log.cart = {}; return back("../cart"); }
    if (path === "cart") { log.cartViews++; return html(cartPage(log)); }
    if (path === "reports") return html(page("Reports", `<ul><li><a href="reports/sales-2026-02.csv">February 2026 sales (CSV)</a></li><li><a href="reports/sales-2026-03.csv" download>March 2026 sales (CSV)</a></li></ul>`));
    if (path === "reports/sales-2026-03.csv" || path === "reports/sales-2026-02.csv") {
      log.downloads.push(path);
      const body = path.endsWith("03.csv") ? SALES_CSV : "date,region,product,units,unit_price\n2026-02-10,North,Brass pen,3,1299\n";
      res.writeHead(200, { "content-type": "text/csv", "content-disposition": `attachment; filename="${path.split("/").at(-1)}"` });
      res.end(body);
      return;
    }
    if (path === "api/products.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ products: PRODUCTS.map(({ sku, name, price, stock }) => ({ sku, name, price_inr: price, in_stock: stock > 0 })) }));
      return;
    }
    if (path === "code/stats.py" || path === "code/test_stats.py") {
      log.downloads.push(path);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(path.endsWith("test_stats.py") ? PY_TEST : PY_STATS);
      return;
    }
    res.writeHead(404); res.end("not found");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    open(id: string): string {
      logs.set(id, { requests: 0, submissions: [], cart: {}, cartViews: 0, downloads: [] });
      return `http://127.0.0.1:${port}/s/${id}/`;
    },
    log: (id: string) => logs.get(id),
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
