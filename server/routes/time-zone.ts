// GET/PUT /api/time-zone: the zone this server tells time in (server/time-zone.ts). Both need admin scope (request-auth's
// default), so only the owner's own devices change it. A Cloud home adopts its owner's zone, and so does a self-hosted
// server that opts in (adoptsOwnerTimeZone). On a desktop, or a server with TZ set, the clock is already the person's,
// and PUT is refused.
import { adoptSavedTimeZone, currentTimeZone, knownTimeZone, useTimeZone } from "../time-zone.ts";
import { PASS, type RouteHandler } from "./table.ts";

/** Whether this server takes its owner's zone from their app. A Cloud home always does. A self-hosted server does when
 * DUSK_ADOPT_TIME_ZONE=1 and TZ is unset, so a TZ the host sets wins. A desktop never does. Read it before
 * adoptSavedTimeZone, which writes TZ. */
export function adoptsOwnerTimeZone({ cloudHome, desktop, env }: { cloudHome: boolean; desktop: boolean; env: NodeJS.ProcessEnv }): boolean {
  if (cloudHome) return true;
  return !desktop && env.DUSK_ADOPT_TIME_ZONE === "1" && !env.TZ;
}

export interface TimeZoneRouteDeps {
  /** True when the owner's app sets this server's zone (see adoptsOwnerTimeZone). */
  adopts: boolean;
  dataDir: string;
  /** After the zone changed: routines move their local times and clients are told. */
  changed(zone: string): void;
}

/** When it adopts, it also adopts the zone saved last time; index.ts builds it before routines start. */
export function createTimeZoneRoutes(deps: TimeZoneRouteDeps): RouteHandler {
  if (deps.adopts) adoptSavedTimeZone(deps.dataDir);
  return async ({ req, res, path, method, json, readBody }) => {
    if (path !== "/api/time-zone") return PASS;
    if (method === "GET") return json(res, 200, { timeZone: currentTimeZone(), adopts: deps.adopts });
    if (method !== "PUT") return PASS;
    if (!deps.adopts) return json(res, 409, { error: "This computer tells time in its own time zone." });
    const zone = knownTimeZone((await readBody(req, 4096) as { timeZone?: unknown } | null)?.timeZone);
    if (!zone) return json(res, 400, { error: "timeZone must be an IANA time zone name, like Europe/London." });
    const changed = useTimeZone(deps.dataDir, zone);
    if (changed) deps.changed(zone);
    return json(res, 200, { timeZone: zone, changed });
  };
}
