// POST /api/cloud/x-index (a workspace's search) and POST /api/cloud/desktop/services/x-index (a signed-in app's token).
// Off, both 404, unless DUSK_X_INDEX_TREG_KEY holds dusk's treg key.
import type { IncomingMessage, ServerResponse } from "node:http";

import { X_INDEX_PATH } from "../../../../server/x-providers/x-index.ts";
import type { AccountRef } from "../billing/types.ts";
import { createSealer, parseSealKey } from "../clouds/seal.ts";
import type { StoredCloud } from "../clouds/types.ts";
import { createXIndexService, tregXIndexSearch, type XIndexService } from "./service.ts";

const ISSUE_PATH = "/api/cloud/desktop/services/x-index";

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  if (Number(req.headers["content-length"]) > limit) { req.resume(); return null; }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const body = Buffer.from(chunk);
    bytes += body.length;
    if (bytes > limit) { req.resume(); return null; }
    chunks.push(body);
  }
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export function createXIndexRoutes(service: XIndexService | null, fromBearer: (req: IncomingMessage) => AccountRef | null) {
  return {
    async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
      if (req.method !== "POST" || (url.pathname !== X_INDEX_PATH && url.pathname !== ISSUE_PATH)) return false;
      if (!service) { send(res, 404, { error: "not_found" }); return true; }
      try {
        if (url.pathname === ISSUE_PATH) {
          const account = /^Bearer omc_[A-Za-z0-9_-]{43}$/.test(req.headers.authorization ?? "") ? fromBearer(req) : null;
          if (!account) { send(res, 401, { error: "invalid_token" }); return true; }
          send(res, 200, { ...service.issue(account.id), cloudContractVersion: 1 });
          return true;
        }
        const body = await readBody(req, 4096);
        if (body === null) { send(res, 413, { error: "too_large" }); return true; }
        const answer = await service.search(req.headers, body);
        res.writeHead(answer.status, { ...Object.fromEntries(answer.headers), "cache-control": "no-store" });
        res.end(Buffer.from(await answer.arrayBuffer()));
      } catch {
        send(res, 503, { error: "unavailable", message: "The X index is unavailable. Try again later." });
      }
      return true;
    },
  };
}

export function xIndexRoutesFromEnv(options: { dataDir: string; publicUrl: string; clouds: { get(id: string): StoredCloud | null }; fromBearer: (req: IncomingMessage) => AccountRef | null; now?: () => number; fetch?: typeof fetch; env?: NodeJS.ProcessEnv }) {
  const env = options.env ?? process.env, key = env.DUSK_X_INDEX_TREG_KEY?.trim();
  if (!key) return createXIndexRoutes(null, options.fromBearer);
  const sealer = createSealer(env.DUSK_CLOUD_SEAL_KEY ? parseSealKey(env.DUSK_CLOUD_SEAL_KEY) : null);
  const daily = Number(env.DUSK_X_INDEX_DAILY) > 0 ? Math.floor(Number(env.DUSK_X_INDEX_DAILY)) : undefined;
  return createXIndexRoutes(createXIndexService({
    dataDir: options.dataDir, clouds: options.clouds, unseal: sealer.unseal, publicUrl: options.publicUrl,
    search: tregXIndexSearch(key, options.fetch), ...(daily ? { daily } : {}), ...(options.now ? { now: options.now } : {}),
  }), options.fromBearer);
}
