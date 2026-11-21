// The keyless X index: for a person with no treg key, plan relay or X sign-in, dusk's account service searches a web
// index (TinyFish through treg, on dusk's own key) for X posts, a capped number of times a day per account. Only the
// credential differs by surface, as for pages:
//   a Cloud home signs its request with the bootstrap secret it already shares with the account service;
//   a desktop's main process fetches its sign-in's own index token and hands it over on the private parent port.
// Neither is ever written to config, sent to a client, or given to an engine.
import { createHash, createHmac, randomBytes } from "node:crypto";

import { isRow, X_MESSAGES, XResearchError } from "../x-research.ts";
import { unavailable } from "./http.ts";

export const X_INDEX_PATH = "/api/cloud/x-index";
export const X_INDEX_TOKEN = /^dusk_xi_[A-Za-z0-9_-]{43}$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type XIndexAccess =
  | { kind: "desktop"; url: string; token: string }
  | { kind: "home"; url: string; machineId: string; secret: string };

/** Must match the account service's check (apps/dashboard/server/x-index/service.ts). */
export function xIndexHomeSignature(secret: string, machineId: string, timestamp: string, nonce: string, body: string): string {
  const bodyHash = createHash("sha256").update(body).digest("base64url");
  return createHmac("sha256", secret).update(`dusk-x-index-v1\n${machineId}\n${timestamp}\n${nonce}\n${bodyHash}`).digest("base64url");
}

export function xIndexAuthHeaders(access: XIndexAccess, body: string, now = Date.now()): Record<string, string> {
  if (access.kind === "desktop") return { authorization: `Bearer ${access.token}` };
  const timestamp = String(Math.floor(now / 1000)), nonce = randomBytes(18).toString("base64url");
  return {
    "x-dusk-cloud-machine": access.machineId,
    "x-dusk-cloud-timestamp": timestamp,
    "x-dusk-cloud-nonce": nonce,
    "x-dusk-cloud-signature": `v1=${xIndexHomeSignature(access.secret, access.machineId, timestamp, nonce, body)}`,
  };
}

let desktopIndex: { url: string; token: string } | null = null;

/** Security: the index token goes only to the account service over https, or to a loopback stand-in in tests. */
function serviceUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname))) && url.pathname === X_INDEX_PATH ? url.href : null;
  } catch {
    return null;
  }
}

/** `{ type: "duskbot:included-x-index", access: { url, token } | null }` from the desktop's main process. True when it
 * was one (then applied), false for any other message; a malformed one throws and changes nothing. */
export function applyIncludedXIndexMessage(message: unknown): boolean {
  if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "duskbot:included-x-index") return false;
  const access = (message as { access?: unknown }).access;
  if (access === null) {
    desktopIndex = null;
    return true;
  }
  const { url, token } = (access && typeof access === "object" ? access : {}) as { url?: unknown; token?: unknown };
  const target = serviceUrl(url);
  if (typeof token !== "string" || !X_INDEX_TOKEN.test(token) || !target) throw new Error("invalid X index access");
  desktopIndex = { url: target, token };
  return true;
}

/** A Cloud home's own credential, else a signed-in desktop's; null when this server is signed in to no dusk account. */
export function xIndexAccess(home: { adminOrigin: string; machineId: string; bootstrapSecret: string } | null): XIndexAccess | null {
  if (home) return { kind: "home", url: `${home.adminOrigin}${X_INDEX_PATH}`, machineId: home.machineId, secret: home.bootstrapSecret };
  return desktopIndex ? { kind: "desktop", ...desktopIndex } : null;
}

/** The index's answer as text a status-link reader can scan. A day's searches used up is a rate limit, not an outage. */
export async function searchXIndex(access: XIndexAccess, query: string, options: { fetcher?: typeof fetch; timeoutMs?: number; now?: () => number } = {}): Promise<string> {
  const body = JSON.stringify({ query });
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(access.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...xIndexAuthHeaders(access, body, options.now?.()) },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
  } catch {
    throw unavailable();
  }
  const text = await response.text().catch(() => "");
  if (response.status === 429) throw new XResearchError("rate_limited", X_MESSAGES.rateLimited);
  if (!response.ok) throw unavailable();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw unavailable();
  }
  if (!isRow(parsed) || !Array.isArray(parsed.results)) throw unavailable();
  return JSON.stringify(parsed.results);
}

