// The mail edge (README.md): Cloudflare Email Routing hands every message for *@in.dusk.bot to email(); a bot's home
// registers where its mailbox's mail goes with PUT /v1/mailboxes/<handle>. The edge keeps the destination, its bearer
// secret and a hash of the key that owns the handle; it never keeps a message.
//
// Security invariant: the edge only ever posts to an address that proved it is a dusk bot mail door holding that
// secret (the check below), so registering cannot turn it into a mail-to-HTTP relay against someone else's server.

export const MAX_RAW_BYTES = 200 * 1024;
const HANDLE = /^[a-z0-9][a-z0-9-]{4,40}$/;
const DOOR_PATH = /^\/hooks\/mail\/mb_[A-Za-z0-9_-]{8,64}$/;
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const CHECK_TIMEOUT_MS = 30_000;
const DELIVER_TIMEOUT_MS = 90_000;

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const hex = (buffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

async function sha256(text) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
}

function sameText(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** A dusk bot mail door on a public https host: nothing else may become a destination. */
export function doorUrl(value) {
  if (typeof value !== "string" || value.length > 400) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !DOOR_PATH.test(url.pathname)) return null;
    if (/^\[|^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || !url.hostname.includes(".")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** The door answers HMAC(secret, nonce) only when it holds that secret for that mailbox. */
async function doorAnswers(url, secret, fetcher) {
  const nonce = crypto.randomUUID();
  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "x-dusk-mail-check": nonce, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return sameText(body?.check, await hmac(secret, nonce));
  } catch {
    return false;
  }
}

export async function handleFetch(request, env, fetcher = fetch) {
  const url = new URL(request.url);
  if (url.pathname === "/health") return json(200, { app: "dusk-inbound-mail", ready: true });
  const match = /^\/v1\/mailboxes\/([^/]+)$/.exec(url.pathname);
  if (!match) return json(404, { error: "not found" });
  const handle = decodeURIComponent(match[1]).toLowerCase();
  if (!HANDLE.test(handle)) return json(400, { error: "invalid handle" });
  if (env.REGISTER_LIMITER) {
    const { success } = await env.REGISTER_LIMITER.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" });
    if (!success) return json(429, { error: "too many changes; try again in a minute" });
  }
  const held = await env.MAILBOXES.get(handle, "json");
  if (request.method === "DELETE") {
    const key = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]?.trim() ?? "";
    if (held && !sameText(held.keyHash, await sha256(key))) return json(403, { error: "not yours" });
    if (held) await env.MAILBOXES.delete(handle);
    return json(200, { deleted: Boolean(held) });
  }
  if (request.method !== "PUT") return json(405, { error: "PUT or DELETE" });
  let body;
  try { body = await request.json(); } catch { return json(400, { error: "expected JSON" }); }
  const destination = doorUrl(body?.url);
  if (!destination || !TOKEN.test(String(body?.secret ?? "")) || !TOKEN.test(String(body?.key ?? ""))) return json(400, { error: "url, secret and key are required" });
  const keyHash = await sha256(body.key);
  if (held && !sameText(held.keyHash, keyHash)) return json(409, { error: "that address is taken" });
  if (!(await doorAnswers(destination, body.secret, fetcher))) return json(422, { error: "the mail door did not answer its check" });
  await env.MAILBOXES.put(handle, JSON.stringify({ url: destination, secret: body.secret, keyHash, at: Date.now() }));
  return json(200, { address: `${handle}@${env.MAIL_DOMAIN}` });
}

async function readCapped(stream, max) {
  const reader = stream.getReader();
  const chunks = [];
  let size = 0, truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > max) {
      chunks.push(value.subarray(0, max - size));
      size = max;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
  return { bytes: out, truncated };
}

function base64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** <handle>[+<alias>]@domain to its handle; null for any other domain. */
export function handleOf(to, domain) {
  const lower = String(to ?? "").trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at < 1 || lower.slice(at + 1) !== String(domain).toLowerCase()) return null;
  return lower.slice(0, at).split("+")[0];
}

/** Mail for a handle nobody registered bounces; a door that refuses the sender is not told back, so nothing answers
 *  spam; a home that cannot be reached bounces with a reason the sender can act on. */
export async function handleEmail(message, env, fetcher = fetch) {
  const handle = handleOf(message.to, env.MAIL_DOMAIN);
  const mailbox = handle && HANDLE.test(handle) ? await env.MAILBOXES.get(handle, "json") : null;
  if (!mailbox) return message.setReject("No such mailbox");
  const { bytes } = await readCapped(message.raw, MAX_RAW_BYTES);
  let response;
  try {
    response = await fetcher(mailbox.url, {
      method: "POST",
      headers: { authorization: `Bearer ${mailbox.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ from: message.from, to: message.to, raw: base64(bytes) }),
      signal: AbortSignal.timeout(DELIVER_TIMEOUT_MS),
    });
  } catch {
    return message.setReject("The bot could not be reached; try again later");
  }
  if (response.status === 401) return message.setReject("No such mailbox");
  if (response.status === 429) return message.setReject("The bot is busy; try again later");
  if (response.status >= 500) return message.setReject("The bot could not be reached; try again later");
}

export default {
  fetch: (request, env) => handleFetch(request, env),
  email: (message, env) => handleEmail(message, env),
};
