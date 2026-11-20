import { validAutoTopUp, validTopUp, validWeekly, type Allowance } from "../allowance.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { ForecastRoutine, Spend } from "../spend.ts";
import { validCap } from "../spend.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface SpendRouteDeps {
  spend: Spend;
  botName(id: string): string | undefined;
  /** A routine this viewer may see, or undefined. */
  routine(auth: RequestAuth, id: string): (ForecastRoutine & { name: string }) | undefined;
  mayChangeCaps(auth: RequestAuth): boolean;
  allowance?: Allowance;
  /** Other ids a routine's runs are booked under, such as its address's. */
  bookedAs?(routineId: string): string[];
}

const FORECAST = /^\/api\/routines\/([\w-]{1,200})\/forecast$/;

export function createSpendRoutes(deps: SpendRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (method === "GET" && path === "/api/usage/battery") {
      res.setHeader("cache-control", "no-store");
      return json(res, 200, deps.spend.battery({ bot: deps.botName, routine: (id) => deps.routine(auth, id) }));
    }
    if (method === "GET" && path === "/api/usage/daily") {
      res.setHeader("cache-control", "no-store");
      const query = new URL(req.url ?? path, "http://local").searchParams;
      return json(res, 200, deps.spend.daily({ days: query.get("days") ?? 14, offsetMinutes: query.get("tz") ?? 0, bot: deps.botName }));
    }
    if (method === "PUT" && path === "/api/usage/caps") {
      if (!deps.mayChangeCaps(auth)) return json(res, 403, { error: "forbidden" });
      let body: unknown;
      try { body = await readBody(req, 4_096); } catch { return json(res, 400, { error: "expected a small JSON body" }); }
      const cap = validCap(body);
      if (!cap) return json(res, 400, { error: "kind (bot or routine), id and usd (a positive amount, or null) are required" });
      if (cap.kind === "routine" && !deps.routine(auth, cap.id)) return json(res, 404, { error: "no such routine" });
      if (cap.kind === "bot" && deps.botName(cap.id) === undefined) return json(res, 404, { error: "no such bot" });
      deps.spend.setCap(cap);
      return json(res, 200, deps.spend.caps());
    }
    if (deps.allowance && path.startsWith("/api/usage/allowance")) return allowanceRoute(deps.allowance, deps.mayChangeCaps(auth), { req, res, path, method, json, readBody });
    const forecast = method === "GET" ? FORECAST.exec(path) : null;
    if (forecast) {
      const routine = deps.routine(auth, forecast[1]!);
      if (!routine) return json(res, 404, { error: "no such routine" });
      res.setHeader("cache-control", "no-store");
      return json(res, 200, deps.spend.forecast(routine, deps.bookedAs?.(routine.id)));
    }
    return PASS;
  };
}

type Io = Pick<Parameters<RouteHandler>[0], "req" | "res" | "path" | "method" | "json" | "readBody">;

/** The account's weekly allowance: read and changed by the owner or an admin only (it names every bot's spend). */
async function allowanceRoute(allowance: Allowance, owner: boolean, { req, res, path, method, json, readBody }: Io) {
  if (!owner) return json(res, 403, { error: "forbidden" });
  res.setHeader("cache-control", "no-store");
  if (method === "GET" && path === "/api/usage/allowance") return json(res, 200, allowance.report());
  if (method === "GET" && path === "/api/usage/allowance/notice") return json(res, 200, { notice: allowance.notice() });
  const routes: Record<string, (body: unknown) => string | null> = {
    "PUT /api/usage/allowance": (body) => { const weekly = validWeekly(body); if (!weekly) return "usd (a positive amount, or null) is required"; allowance.setWeekly(weekly.usd); return null; },
    "POST /api/usage/allowance/top-up": (body) => { const usd = validTopUp(body); if (usd === null) return "usd (a positive amount up to 10000) is required"; allowance.addForWeek(usd); return null; },
    "POST /api/usage/allowance/saver": (body) => { const on = (body as { on?: unknown } | null)?.on; if (typeof on !== "boolean") return "on (true or false) is required"; allowance.setSaver(on); return null; },
    "PUT /api/usage/allowance/auto": (body) => { const auto = validAutoTopUp(body); if (!auto) return "on, and when on a stepUsd no larger than monthlyCeilingUsd, are required"; allowance.setAutoTopUp(auto); return null; },
    "POST /api/usage/allowance/dismiss": () => { allowance.dismiss(); return null; },
    "POST /api/usage/allowance/notice/seen": () => { allowance.noticeSeen(); return null; },
  };
  const route = routes[`${method} ${path}`];
  if (!route) return json(res, 404, { error: "not found" });
  let body: unknown;
  try { body = await readBody(req, 4_096); } catch { return json(res, 400, { error: "expected a small JSON body" }); }
  const error = route(body);
  return error ? json(res, 400, { error }) : json(res, 200, allowance.report());
}
