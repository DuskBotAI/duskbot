// Fake business apps for the workflow eval: one stdio MCP server per app (`node apps-mcp.mjs <app>`), all reading and
// writing one JSON state file (BIZ_STATE) seeded per case, so the harness can see what a workflow really did (drafts,
// sends, sheet rows, events) without any real account. Standard library only; newline-delimited JSON-RPC as MCP stdio.
import { readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";

const app = process.argv[2];
const statePath = process.env.BIZ_STATE;
if (!app || !statePath) { process.stderr.write("usage: BIZ_STATE=<file> node apps-mcp.mjs <app>\n"); process.exit(2); }

const load = () => JSON.parse(readFileSync(statePath, "utf8"));
const save = (state) => { const tmp = `${statePath}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(state, null, 2)); renameSync(tmp, statePath); };
const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
const log = (state, action, detail) => { (state.log ??= []).push({ at: now(), app, action, ...detail }); };
const str = { type: "string" };
const read = { readOnlyHint: true };
const write = { readOnlyHint: false, destructiveHint: false };

function matchMail(m, q) {
  if (!q) return true;
  const terms = q.match(/(\w+:"[^"]*"|"[^"]*"|\S+)/g) ?? [];
  return terms.every((raw) => {
    const t = raw.replaceAll('"', "").toLowerCase();
    if (t.startsWith("from:")) return m.from.toLowerCase().includes(t.slice(5));
    if (t.startsWith("to:")) return (m.to ?? "").toLowerCase().includes(t.slice(3));
    if (t.startsWith("label:")) return (m.labels ?? []).some((l) => l.toLowerCase() === t.slice(6));
    if (t === "is:unread") return !m.read;
    if (t === "is:read") return !!m.read;
    if (t === "has:attachment") return (m.attachments ?? []).length > 0;
    if (t.startsWith("after:")) return Date.parse(m.date) >= Date.parse(t.slice(6).replaceAll("/", "-"));
    if (t.startsWith("before:")) return Date.parse(m.date) < Date.parse(t.slice(7).replaceAll("/", "-"));
    if (t.startsWith("newer_than:")) { const n = parseInt(t.slice(11)); const unit = t.at(-1); const ms = unit === "h" ? 3.6e6 : 8.64e7; return Date.now() - Date.parse(m.date) <= n * ms; }
    if (t.startsWith("subject:")) return m.subject.toLowerCase().includes(t.slice(8));
    return `${m.from} ${m.subject} ${m.body} ${(m.labels ?? []).join(" ")}`.toLowerCase().includes(t);
  });
}
/** A file attached to a draft or a send: its name and size, read from disk as Gmail would upload it. */
const attach = (paths) => (paths ?? []).map((path) => { const st = statSync(path); if (!st.isFile()) throw new Error(`${path} is not a file`); return { name: basename(path), bytes: st.size, head: readFileSync(path).subarray(0, 5).toString("latin1") }; });
// as Gmail does, a send carries its thread id, and a reply joins the thread of the message it answers
const threadOf = (s, messageId) => { if (!messageId) return undefined; const m = [...(s.mail ?? []), ...(s.sent ?? [])].find((one) => one.id === messageId); return m ? m.threadId ?? m.id : undefined; };
const brief = (m) => ({ id: m.id, threadId: m.threadId ?? m.id, from: m.from, to: m.to, subject: m.subject, date: m.date, unread: !m.read, labels: m.labels ?? [], snippet: m.body.slice(0, 140), attachments: (m.attachments ?? []).map((a) => a.name) });

const APPS = {
  gmail: {
    gmail_get_profile: { d: "The connected account: its address and the addresses it can send as.", a: read, s: {},
      run: () => ({ email: "maya@loomware.co", send_as: ["maya@loomware.co", "support@loomware.co", "deals@loomware.co", "hello@loomware.co", "ar@loomware.co", "jobs@loomware.co"] }) },
    gmail_search: { d: "Search the connected Gmail inbox (support@, deals@ and the owner's mail land here). Gmail query syntax: from:, to:, subject:, label:, is:unread, has:attachment, after:YYYY/MM/DD, newer_than:2d, plain words. Newest first.", a: read,
      s: { query: str, max_results: { type: "integer" } },
      run: (s, x) => s.mail.filter((m) => matchMail(m, x.query)).sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, x.max_results ?? 25).map(brief) },
    gmail_read: { d: "Read one email in full, with its attachments' text.", a: read, s: { message_id: str }, req: ["message_id"],
      run: (s, x) => { const m = s.mail.find((m) => m.id === x.message_id); if (!m) throw new Error("no such message"); return { ...brief(m), body: m.body, attachments: m.attachments ?? [] }; } },
    gmail_create_draft: { d: "Create a draft (optionally a reply in a thread). It is not sent. attachments: paths of local files to attach.", a: write, s: { to: str, subject: str, body: str, reply_to_message_id: str, attachments: { type: "array", items: str } }, req: ["to", "subject", "body"],
      run: (s, x) => { const d = { id: id("draft"), ...x, attachments: attach(x.attachments), at: now() }; (s.drafts ??= []).push(d); log(s, "draft", { to: x.to, subject: x.subject }); return { draft_id: d.id, status: "draft saved" }; } },
    gmail_send: { d: "Send an email now from the connected account (optionally as a reply in a thread). attachments: paths of local files to attach.", a: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, s: { to: str, subject: str, body: str, reply_to_message_id: str, cc: str, attachments: { type: "array", items: str } }, req: ["to", "subject", "body"],
      run: (s, x) => { const e = { id: id("sent"), ...x, attachments: attach(x.attachments), at: now() }; e.threadId = threadOf(s, x.reply_to_message_id) ?? e.id; (s.sent ??= []).push(e); log(s, "send", { to: x.to, subject: x.subject }); return { message_id: e.id, thread_id: e.threadId, status: "sent" }; } },
    gmail_send_draft: { d: "Send a draft that was created earlier.", a: { readOnlyHint: false, openWorldHint: true }, s: { draft_id: str }, req: ["draft_id"],
      run: (s, x) => { const i = (s.drafts ?? []).findIndex((d) => d.id === x.draft_id); if (i < 0) throw new Error("no such draft"); const [d] = s.drafts.splice(i, 1); const e = { ...d, id: id("sent"), at: now() }; e.threadId = threadOf(s, d.reply_to_message_id) ?? e.id; (s.sent ??= []).push(e); log(s, "send", { to: d.to, subject: d.subject }); return { message_id: e.id, thread_id: e.threadId, status: "sent" }; } },
    gmail_list_drafts: { d: "List drafts waiting to be sent.", a: read, s: {}, run: (s) => (s.drafts ?? []).map(({ id, to, subject, at }) => ({ id, to, subject, at })) },
    gmail_list_sent: { d: "List sent mail, newest first.", a: read, s: { query: str }, run: (s, x) => (s.sent ?? []).filter((e) => !x.query || JSON.stringify(e).toLowerCase().includes(x.query.toLowerCase())).slice(-50).reverse().map(({ id, threadId, to, subject, at, reply_to_message_id }) => ({ id, threadId: threadId ?? id, to, subject, at, reply_to_message_id })) },
    gmail_modify: { d: "Add or remove labels on a message; mark it read or unread.", a: write, s: { message_id: str, add_labels: { type: "array", items: str }, remove_labels: { type: "array", items: str }, mark_read: { type: "boolean" } }, req: ["message_id"],
      run: (s, x) => { const m = s.mail.find((m) => m.id === x.message_id); if (!m) throw new Error("no such message"); m.labels = [...new Set([...(m.labels ?? []).filter((l) => !(x.remove_labels ?? []).includes(l)), ...(x.add_labels ?? [])])]; if (x.mark_read !== undefined) m.read = x.mark_read; log(s, "modify", { message_id: m.id }); return { ok: true, labels: m.labels }; } },
  },
  google_sheets: {
    sheets_list: { d: "List the spreadsheets in the connected Google Drive.", a: read, s: {}, run: (s) => Object.values(s.sheets ?? {}).map(({ id, title, headers, rows }) => ({ spreadsheet_id: id, title, headers, row_count: rows.length })) },
    sheets_create: { d: "Create a new spreadsheet with a header row.", a: write, s: { title: str, headers: { type: "array", items: str } }, req: ["title", "headers"],
      run: (s, x) => { const sh = { id: id("sheet"), title: x.title, headers: x.headers, rows: [], url: "" }; sh.url = `https://docs.google.com/spreadsheets/d/${sh.id}`; (s.sheets ??= {})[sh.id] = sh; log(s, "sheet_create", { title: x.title }); return { spreadsheet_id: sh.id, url: sh.url }; } },
    sheets_read: { d: "Read a spreadsheet's header and rows (row numbers start at 1 under the header).", a: read, s: { spreadsheet_id: str }, req: ["spreadsheet_id"],
      run: (s, x) => { const sh = s.sheets?.[x.spreadsheet_id]; if (!sh) throw new Error("no such spreadsheet"); return { title: sh.title, headers: sh.headers, rows: sh.rows.map((r, i) => ({ row: i + 1, values: r })) }; } },
    sheets_append_rows: { d: "Append rows (each an array of cell values in header order).", a: write, s: { spreadsheet_id: str, rows: { type: "array", items: { type: "array", items: {} } } }, req: ["spreadsheet_id", "rows"],
      run: (s, x) => { const sh = s.sheets?.[x.spreadsheet_id]; if (!sh) throw new Error("no such spreadsheet"); sh.rows.push(...x.rows.map((r) => r.map(String))); log(s, "sheet_append", { title: sh.title, n: x.rows.length }); return { appended: x.rows.length, row_count: sh.rows.length }; } },
    sheets_set_headers: { d: "Replace the header row (add, rename or reorder columns); existing rows keep their cells in place.", a: write, s: { spreadsheet_id: str, headers: { type: "array", items: str } }, req: ["spreadsheet_id", "headers"],
      run: (s, x) => { const sh = s.sheets?.[x.spreadsheet_id]; if (!sh) throw new Error("no such spreadsheet"); sh.headers = x.headers.map(String); log(s, "sheet_headers", { title: sh.title }); return { ok: true, headers: sh.headers }; } },
    sheets_update_row: { d: "Replace one row's values (row number from sheets_read).", a: write, s: { spreadsheet_id: str, row: { type: "integer" }, values: { type: "array", items: {} } }, req: ["spreadsheet_id", "row", "values"],
      run: (s, x) => { const sh = s.sheets?.[x.spreadsheet_id]; if (!sh?.rows[x.row - 1]) throw new Error("no such row"); sh.rows[x.row - 1] = x.values.map(String); log(s, "sheet_update", { title: sh.title, row: x.row }); return { ok: true }; } },
  },
  google_calendar: {
    calendar_list_events: { d: "List events between two ISO times.", a: read, s: { time_min: str, time_max: str }, req: ["time_min", "time_max"],
      run: (s, x) => (s.events ?? []).filter((e) => e.start >= x.time_min && e.start < x.time_max) },
    calendar_free_slots: { d: "Free slots of at least duration_minutes between two ISO times, inside working hours (9-17 in the owner's time zone).", a: read, s: { time_min: str, time_max: str, duration_minutes: { type: "integer" } }, req: ["time_min", "time_max"],
      run: (s, x) => { const out = []; const dur = (x.duration_minutes ?? 30) * 60_000; for (let t = Date.parse(x.time_min); t < Date.parse(x.time_max) && out.length < 20; t += 30 * 60_000) { const d = new Date(t); const h = d.getHours(); if (h < 9 || h >= 17 || d.getDay() === 0 || d.getDay() === 6) continue; const end = t + dur; if ((s.events ?? []).some((e) => Date.parse(e.start) < end && Date.parse(e.end) > t)) continue; out.push({ start: new Date(t).toISOString(), end: new Date(end).toISOString() }); } return out; } },
    calendar_update_event: { d: "Move or change an event (attendees get the update).", a: { readOnlyHint: false, openWorldHint: true }, s: { event_id: str, title: str, start: str, end: str, attendees: { type: "array", items: str }, description: str }, req: ["event_id"],
      run: (s, x) => { const e = (s.events ?? []).find((e) => e.id === x.event_id); if (!e) throw new Error("no such event"); Object.assign(e, Object.fromEntries(Object.entries(x).filter(([k, v]) => k !== "event_id" && v !== undefined))); log(s, "event_update", { title: e.title }); return { ok: true }; } },
    calendar_delete_event: { d: "Cancel an event (attendees are told).", a: { readOnlyHint: false, destructiveHint: true }, s: { event_id: str }, req: ["event_id"],
      run: (s, x) => { const i = (s.events ?? []).findIndex((e) => e.id === x.event_id); if (i < 0) throw new Error("no such event"); const [e] = s.events.splice(i, 1); log(s, "event_delete", { title: e.title }); return { ok: true }; } },
    calendar_create_event: { d: "Create an event and invite attendees (they get an email invite).", a: { readOnlyHint: false, openWorldHint: true }, s: { title: str, start: str, end: str, attendees: { type: "array", items: str }, description: str }, req: ["title", "start", "end"],
      run: (s, x) => { const e = { id: id("evt"), ...x }; (s.events ??= []).push(e); log(s, "event_create", { title: x.title, attendees: x.attendees }); return { event_id: e.id, status: "created, invites sent" }; } },
  },
  stripe: {
    stripe_summary: { d: "Revenue summary between two dates (YYYY-MM-DD): gross, refunds, net, new customers, MRR, churned subscriptions.", a: read, s: { since: str, until: str }, req: ["since", "until"],
      run: (s, x) => { const c = (s.charges ?? []).filter((c) => c.date >= x.since && c.date <= x.until); const gross = c.reduce((t, c) => t + c.amount, 0); const refunds = c.filter((c) => c.refunded).reduce((t, c) => t + c.amount, 0); return { currency: "usd", gross, refunds, net: gross - refunds, charges: c.length, new_customers: new Set(c.filter((c) => c.new_customer).map((c) => c.customer)).size, mrr: s.mrr ?? 0, churned_subscriptions: (s.subscriptions ?? []).filter((u) => u.status === "canceled" && u.canceled_at >= x.since && u.canceled_at <= x.until).length }; } },
    stripe_list_charges: { d: "List charges between two dates (YYYY-MM-DD).", a: read, s: { since: str, until: str }, req: ["since", "until"], run: (s, x) => (s.charges ?? []).filter((c) => c.date >= x.since && c.date <= x.until) },
    stripe_list_invoices: { d: "List invoices by status: open, overdue, paid.", a: read, s: { status: str }, run: (s, x) => (s.invoices ?? []).filter((i) => !x.status || i.status === x.status) },
    stripe_list_subscriptions: { d: "List subscriptions by status (active, canceled), with cancel reason when given.", a: read, s: { status: str }, run: (s, x) => (s.subscriptions ?? []).filter((u) => !x.status || u.status === x.status) },
  },
  meta_ads: {
    ads_insights: { d: "Meta (Facebook/Instagram) ads results per campaign between two dates (YYYY-MM-DD): spend, impressions, clicks, purchases, revenue, ROAS.", a: read, s: { since: str, until: str }, req: ["since", "until"],
      run: (s, x) => (s.ads ?? []).map((c) => ({ ...c, since: x.since, until: x.until })) },
  },
  apollo: {
    people_search: { d: "Search Apollo's B2B database for people: job titles, industry, location, company size range (e.g. 11-50), limit up to 100.", a: read,
      s: { titles: { type: "array", items: str }, industry: str, location: str, company_size: str, limit: { type: "integer" } },
      run: (s, x) => { const n = Math.min(x.limit ?? 25, 100); const first = ["Ana", "Ben", "Chloe", "Dev", "Elif", "Farid", "Grace", "Hugo", "Ines", "Jon", "Kemi", "Liam", "Mira", "Nikhil", "Owen", "Priya", "Quinn", "Rosa", "Sam", "Tara"]; const last = ["Park", "Okafor", "Silva", "Mehta", "Novak", "Lund", "Reyes", "Chen", "Haddad", "Brooks"]; const out = []; for (let i = 0; i < n; i++) { const co = `${["Northwind", "Brightpath", "Copperleaf", "Lumen", "Tidewater", "Ironbark", "Bluefin", "Kestrel", "Sable", "Quarry"][i % 10]} ${["Labs", "Logistics", "Health", "Studio", "Systems"][Math.floor(i / 10) % 5]}`; out.push({ person_id: `p${i + 1}`, name: `${first[i % 20]} ${last[(i * 7) % 10]}`, title: (x.titles ?? ["Head of Operations"])[i % (x.titles?.length || 1)], company: co, industry: x.industry ?? "SaaS", location: x.location ?? "United States", company_size: x.company_size ?? "11-50" }); } return out; } },
    people_enrich: { d: "Enrich one person: verified work email, LinkedIn, company website, headcount, a recent company news item.", a: read, s: { person_id: str }, req: ["person_id"],
      run: (s, x) => { const n = parseInt(String(x.person_id).replace(/\D/g, "")) || 1; const co = ["northwind", "brightpath", "copperleaf", "lumen", "tidewater", "ironbark", "bluefin", "kestrel", "sable", "quarry"][(n - 1) % 10] + ["labs", "logistics", "health", "studio", "systems"][Math.floor((n - 1) / 10) % 5]; return { person_id: x.person_id, email: `${["ana", "ben", "chloe", "dev", "elif", "farid", "grace", "hugo", "ines", "jon", "kemi", "liam", "mira", "nikhil", "owen", "priya", "quinn", "rosa", "sam", "tara"][(n - 1) % 20]}@${co}.co`, email_status: n % 9 === 0 ? "unverified" : "verified", verified_by: "Apollo SMTP check, last 30 days", linkedin: `https://www.linkedin.com/in/${co}-ops-${n}`, website: `https://${co}.co`, headcount: 10 + (n * 13) % 190, recent_news: ["raised a seed round", "opened a second warehouse", "hired a new COO", "launched a customer portal", "expanded to Canada"][n % 5] }; } },
  },
};

const tools = APPS[app];
if (!tools) { process.stderr.write(`unknown app ${app}\n`); process.exit(2); }

const reply = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  const { method, params } = msg;
  if (method === "initialize") return reply({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: app, version: "1.0.0" } } });
  if (method === "ping") return reply({ jsonrpc: "2.0", id: msg.id, result: {} });
  if (method === "tools/list") {
    return reply({ jsonrpc: "2.0", id: msg.id, result: { tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.d, annotations: t.a, inputSchema: { type: "object", properties: t.s, ...(t.req ? { required: t.req } : {}) } })) } });
  }
  if (method === "tools/call") {
    const tool = tools[params?.name];
    if (!tool) return reply({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown tool ${params?.name}` } });
    try {
      const state = load();
      const out = tool.run(state, params.arguments ?? {});
      (state.calls ??= []).push({ at: now(), app, tool: params.name });
      save(state);
      return reply({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(out, null, 1) }] } });
    } catch (error) {
      return reply({ jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: String(error.message ?? error) }] } });
    }
  }
  reply({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${method}` } });
});
