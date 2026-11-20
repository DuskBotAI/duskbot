// The person's side of webhook automations. Deliveries land on a separate webhook-only loopback listener, so a relay never
// exposes the rest of the control surface. Only the list is a client route; the rest, the address included, needs admin.
import { webhookVisible } from "../bot-visibility.ts";
import type { RequestAuth } from "../request-auth.ts";
import { webhookCredential } from "../webhook-ingress.ts";
import type { WebhookManager } from "../webhooks.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

export interface WebhookRouteDeps {
  webhooks: WebhookManager;
  ingress: () => { available: boolean; baseUrl: string; error?: string };
  visible: (auth: RequestAuth) => { everything: boolean; bot(id: string): boolean; group(id: string): boolean };
  /** The desktop app says where the internet reaches this computer's addresses (its Remote access route), or that
   *  nothing does. Absent off the desktop. */
  publicOrigin?: (origin: string | null) => void;
  /** A bot's mail address and its routes, or null before it has one. */
  mail?: (botId: string) => unknown;
}

/** A complete https origin, nothing more: it becomes the start of every address the app and bots hand out. */
export function publicHookOrigin(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 300) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && url.origin === value.replace(/\/+$/, "") ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

export function createWebhookRoutes({ webhooks, ingress, visible, publicOrigin, mail }: WebhookRouteDeps): RouteHandler {
  const withCredential = (webhook: { endpointId: string }, secret: string) => {
    const status = ingress();
    return { ingress: status, credential: webhookCredential(status.baseUrl, webhook.endpointId, secret) };
  };
  return async ({ req, res, path, method, auth, json, readBody }: RouteContext) => {
    if (path === "/api/webhooks" && method === "GET") {
      const seen = visible(auth);
      const shownHooks = webhooks.list().filter((webhook) => webhookVisible(webhook, seen));
      const shownIds = new Set(shownHooks.map((webhook) => webhook.id));
      return json(res, 200, { webhooks: shownHooks, attempts: webhooks.listAttempts().filter((attempt) => seen.everything || shownIds.has(attempt.webhookId)), ingress: ingress() });
    }
    const mailOf = method === "GET" && mail ? /^\/api\/webhooks\/mail\/([\w-]{1,128})$/.exec(path) : null;
    if (mailOf) {
      if (!visible(auth).bot(mailOf[1]!)) return json(res, 404, { error: "no such bot" });
      return json(res, 200, { mail: mail!(mailOf[1]!) });
    }
    if (path === "/api/webhooks/public-origin" && method === "PUT") {
      if (!publicOrigin || auth.kind !== "loopback" || auth.companionDevice) return json(res, 403, { error: "Only the desktop app sets this." });
      const body = await readBody(req) as { origin?: unknown } | null;
      const origin = publicHookOrigin(body?.origin);
      if (origin === undefined) return json(res, 400, { error: "origin must be an https origin or null" });
      publicOrigin(origin);
      return json(res, 200, { ingress: ingress() });
    }
    if (path === "/api/webhooks" && method === "POST") {
      const created = webhooks.create(await readBody(req));
      return json(res, 201, { webhook: created.webhook, ...withCredential(created.webhook, created.secret) });
    }
    const match = path.match(/^\/api\/webhooks\/([\w-]+)(?:\/(rotate|test|address))?$/);
    if (!match) return PASS;
    const id = match[1]!;
    if (match[2] === "test" && method === "POST") {
      const result = webhooks.test(id, await readBody(req));
      return result ? json(res, 202, result) : json(res, 404, { error: "no such webhook" });
    }
    if (match[2] === "rotate" && method === "POST") {
      const rotated = webhooks.rotateSecret(id);
      return rotated ? json(res, 200, { webhook: rotated.webhook, ...withCredential(rotated.webhook, rotated.secret) }) : json(res, 404, { error: "no such webhook" });
    }
    // The address as it is now, which the owning bot may already have given an app: reading it never replaces it.
    if (match[2] === "address" && method === "GET") {
      const current = webhooks.currentSecret(id, false);
      if (!current || !webhookVisible(current.webhook, visible(auth))) return json(res, 404, { error: "no such webhook" });
      if (!current.secret) return json(res, 404, { error: "this address was made before addresses were kept", kept: false });
      return json(res, 200, { webhook: current.webhook, ...withCredential(current.webhook, current.secret) });
    }
    if (!match[2] && method === "PATCH") {
      const webhook = webhooks.update(id, await readBody(req));
      return webhook ? json(res, 200, { webhook }) : json(res, 404, { error: "no such webhook" });
    }
    if (!match[2] && method === "DELETE") {
      return webhooks.remove(id) ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such webhook" });
    }
    return PASS;
  };
}
