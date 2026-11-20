import { serverVersion } from "../environment.ts";
import { SERVER_ROOT } from "../proxy-paths.ts";
import { createUpdateChecker, installKind, tracksOfficialLatest, type UpdateCheck } from "../update-check.ts";
import { createComposeUpdates, type ComposeUpdates } from "../compose-updates.ts";
import { isProxied, type RequestAuth } from "../request-auth.ts";
import { json, readBody } from "../harness/http.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WorkspaceBackupMaintenance } from "../workspace-backup-maintenance.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface UpdateCheckRouteDeps {
  check(): Promise<UpdateCheck>;
  compose?: ComposeUpdates;
  owner?: (auth: RequestAuth) => boolean;
}

export function createUpdateCheckRoutes(deps: UpdateCheckRouteDeps): RouteHandler {
  return async ({ req, res, path, method, json, auth, readBody }) => {
    if (path === "/api/updates/compose" && method === "GET") {
      if (!deps.compose || !deps.owner?.(auth)) return json(res, 403, { error: "Sign in as the server owner." });
      res.setHeader("cache-control", "no-store");
      return json(res, 200, { current: serverVersion(), compose: await deps.compose.status() });
    }
    if (path === "/api/updates/apply" || path === "/api/updates/automatic") {
      if (method !== "POST") return json(res, 405, { error: "Use POST." });
      if (!deps.owner?.(auth)) return json(res, 403, { error: "Sign in as the server owner." });
      if (!deps.compose) return json(res, 409, { error: "This installation is updated by its operator." });
      const body = await readBody(req, 256);
      if (path.endsWith("/automatic") && typeof body?.enabled !== "boolean") return json(res, 400, { error: "Choose whether to enable automatic updates." });
      try {
        const status = await deps.compose.request(path.endsWith("/apply") ? "apply" : body.enabled ? "enable" : "disable");
        return json(res, 202, status);
      } catch (error) {
        return json(res, 409, { error: error instanceof Error ? error.message : "Check the host updater service." });
      }
    }
    if (path !== "/api/updates/check" || method !== "GET") return PASS;
    try {
      const check = await deps.check();
      res.setHeader("cache-control", "no-store");
      return json(res, 200, deps.compose && deps.owner?.(auth) ? { ...check, compose: await deps.compose.status() } : check);
    } catch (error) {
      return json(res, 502, { error: `Could not check for updates: ${error instanceof Error ? error.message : String(error)}` });
    }
  };
}

export function serverUpdatesFor(where: { desktopManaged: boolean; managed: boolean }, owner: (auth: RequestAuth) => boolean,
  eligible: () => boolean, busy: () => string[], maintenance: WorkspaceBackupMaintenance) {
  const image = process.env.DUSK_COMPOSE_IMAGE;
  const install = installKind({ ...where, serverRoot: SERVER_ROOT });
  const check = createUpdateChecker({ current: serverVersion(), composeImage: image, releaseImage: process.env.DUSK_RELEASE_IMAGE, install });
  const idle = () => busy().length === 0;
  const compose = install === "docker" && tracksOfficialLatest(image)
    ? createComposeUpdates({ check, eligible, idle, reserve: () => maintenance.reserveUpdate(idle) }) : undefined;
  if (compose) setInterval(() => { void compose.tick().catch(error => console.warn("Compose update check:", error.message)); }, 5 * 60_000).unref();

  async function hostRoute(req: IncomingMessage, res: ServerResponse, path: string) {
    if (path !== "/api/updates/compose/host") return false;
    if (!compose || req.method !== "POST" || req.socket.remoteAddress !== "127.0.0.1" || isProxied(req) || req.headers.origin) {
      json(res, 403, { error: "Only the local Compose updater can redeem a request." });
    } else {
      const body = await readBody(req, 512);
      const answer = compose.redeem(body?.step, body?.token);
      json(res, answer ? 200 : 403, answer ?? { error: "Update request expired or refused." });
    }
    return true;
  }
  return { check, routes: createUpdateCheckRoutes({ check, owner, compose }), hostRoute };
}
