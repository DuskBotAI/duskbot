// The keyless X index (server/x-providers/x-index.ts is the workspace's side): any signed-in dusk account's workspace may
// ask for X post links from a web index, a capped number a day, on dusk's own treg key. A Cloud home proves its account
// with the bootstrap-secret signature; a desktop with its sign-in's own index token, issued here to its signed-in app.
// Only post links on x.com and twitter.com go back; the query is never stored or logged.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { join } from "node:path";

import { X_INDEX_PATH, xIndexHomeSignature } from "../../../../server/x-providers/x-index.ts";
import { createJsonStore } from "../billing/json-store.ts";
import type { StoredCloud } from "../clouds/types.ts";

export const X_INDEX_DAILY = 100;
const QUERY_MAX = 300;
const STATUS_LINK = /^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d{8,25}(?:[/?#].*)?$/;

interface State { tokens: Array<{ hash: string; accountId: string; at: number }>; day: string; counts: Record<string, number> }
type HeadersInput = IncomingHttpHeaders | Headers;
const header = (headers: HeadersInput, key: string): string => headers instanceof Headers ? headers.get(key) ?? "" : typeof headers[key] === "string" ? headers[key] : "";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const failure = (status: number, error: string, message: string) => Response.json({ error, message }, { status });
const invalid = () => failure(401, "invalid_token", "This X index credential is not valid.");
const valid = (value: unknown): value is State => {
  const state = value as State | null;
  return Boolean(state) && Array.isArray(state!.tokens) && state!.tokens.every(row => row && /^[a-f0-9]{64}$/.test(row.hash) && typeof row.accountId === "string" && Number.isSafeInteger(row.at))
    && typeof state!.day === "string" && Boolean(state!.counts) && typeof state!.counts === "object";
};

export interface XIndexResult { url: string; title?: string; snippet?: string }

export function createXIndexService(options: {
  dataDir: string;
  clouds: { get(id: string): StoredCloud | null };
  unseal(value: string): string;
  /** Runs one web search limited to x.com; throws when the index can't be reached. */
  search(query: string): Promise<XIndexResult[]>;
  publicUrl: string;
  daily?: number;
  now?: () => number;
  random?: (size: number) => Buffer;
}) {
  const now = options.now ?? Date.now, random = options.random ?? randomBytes, daily = options.daily ?? X_INDEX_DAILY;
  const store = createJsonStore<State>(join(options.dataDir, "x-index.json"), () => ({ tokens: [], day: "", counts: {} }), valid);
  const nonces = new Map<string, number>();

  /** The account a request speaks for, or null. */
  function accountOf(headers: HeadersInput, rawBody: string): string | null {
    const bearer = /^Bearer (dusk_xi_[A-Za-z0-9_-]{43})$/.exec(header(headers, "authorization"))?.[1];
    if (bearer) return store.state.tokens.find(row => row.hash === digest(bearer))?.accountId ?? null;
    const machine = header(headers, "x-dusk-cloud-machine"), timestamp = header(headers, "x-dusk-cloud-timestamp"), nonce = header(headers, "x-dusk-cloud-nonce"), signature = header(headers, "x-dusk-cloud-signature");
    const cloud = options.clouds.get(machine), time = now();
    for (const [key, expiry] of nonces) if (expiry <= time) nonces.delete(key);
    if (!cloud || ["destroyed", "destroying", "suspended", "checkout"].includes(cloud.status) || cloud.ended || cloud.suspended !== null
      || !/^\d{1,12}$/.test(timestamp) || Math.abs(Number(timestamp) * 1000 - time) > 300_000 || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || nonces.has(`${machine}:${nonce}`) || nonces.size >= 10_000) return null;
    try {
      const expected = Buffer.from(`v1=${xIndexHomeSignature(options.unseal(cloud.bootstrapSecret), machine, timestamp, nonce, rawBody)}`), actual = Buffer.from(signature);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    } catch { return null; }
    nonces.set(`${machine}:${nonce}`, time + 600_000);
    return cloud.accountId;
  }

  /** Counts one search against the account's day; false once the day's are used up. */
  function spend(accountId: string): boolean {
    const today = new Date(now()).toISOString().slice(0, 10);
    if (store.state.day !== today) { store.state.day = today; store.state.counts = {}; }
    const used = store.state.counts[accountId] ?? 0;
    if (used >= daily) return false;
    store.state.counts[accountId] = used + 1;
    store.commit();
    return true;
  }

  return {
    /** A signed-in desktop's own token: a new one replaces the account's last. */
    issue(accountId: string): { url: string; token: string } {
      const token = `dusk_xi_${random(32).toString("base64url")}`;
      store.state.tokens = [...store.state.tokens.filter(row => row.accountId !== accountId), { hash: digest(token), accountId, at: now() }];
      store.commit();
      return { url: `${options.publicUrl.replace(/\/+$/, "")}${X_INDEX_PATH}`, token };
    },
    async search(headers: HeadersInput, rawBody: Buffer): Promise<Response> {
      const text = rawBody.toString("utf8"), accountId = accountOf(headers, text);
      if (!accountId) return invalid();
      let query: unknown;
      try { query = (JSON.parse(text) as { query?: unknown }).query; } catch { query = null; }
      if (typeof query !== "string" || !query.trim() || query.length > QUERY_MAX) return failure(400, "invalid_request", "Send the query, at most 300 characters.");
      if (!spend(accountId)) return failure(429, "daily_limit", "This account's X index searches for today are used up.");
      let rows: XIndexResult[];
      try { rows = await options.search(query.trim()); }
      catch { return failure(503, "unavailable", "The X index is unavailable. Try again later."); }
      const results = rows.filter(row => typeof row?.url === "string" && STATUS_LINK.test(row.url)).slice(0, 20)
        .map(row => ({ url: row.url, ...(typeof row.title === "string" ? { title: row.title.slice(0, 300) } : {}), ...(typeof row.snippet === "string" ? { snippet: row.snippet.slice(0, 500) } : {}) }));
      return Response.json({ results, remaining: daily - (store.state.counts[accountId] ?? 0) });
    },
  };
}

export type XIndexService = ReturnType<typeof createXIndexService>;

/** TinyFish's web search through treg (listed free), limited to x.com. Security: the key goes only to treg. */
export function tregXIndexSearch(key: string, fetcher: typeof fetch = fetch, base = "https://treg.to"): (query: string) => Promise<XIndexResult[]> {
  return async (query) => {
    const params = new URLSearchParams({ query, domain_type: "web", include_domains: "x.com" });
    const response = await fetcher(`${base}/call/tinyfish.web.search?${params}`, { headers: { "x-treg-token": key, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`treg answered ${response.status}`);
    const body = await response.json() as { results?: unknown; output?: { results?: unknown } };
    const rows = Array.isArray(body.results) ? body.results : Array.isArray(body.output?.results) ? body.output.results : [];
    return rows as XIndexResult[];
  };
}
