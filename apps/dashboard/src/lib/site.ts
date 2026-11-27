declare const __DUSK_SITE_URL__: string | undefined;

/** where the marketing site lives: DUSK_SITE_URL at build, so a preview app can point at a preview site */
export const SITE_URL = (typeof __DUSK_SITE_URL__ === "string" && __DUSK_SITE_URL__ ? __DUSK_SITE_URL__ : "https://dusk.bot").replace(/\/+$/, "");
export const SITE_NAME = SITE_URL.replace(/^https?:\/\//, "");
export const siteUrl = (path = "/") => `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;

export type PlanIntent = { plan: "starter" | "pro" | "team"; interval: "month" | "year" | null };

const PLANS: Record<string, PlanIntent["plan"]> = { plus: "starter", starter: "starter", pro: "pro", dedicated: "team", team: "team" };
const PERIODS: Record<string, "month" | "year"> = { m: "month", month: "month", monthly: "month", y: "year", year: "year", yearly: "year" };

/** the plan a site link asked for (?plan=plus|pro|dedicated, or the older ?bundle=, optional &period=month|year); anything else is
 * no plan at all */
export function planIntent(query: URLSearchParams): PlanIntent | null {
  const plan = PLANS[(query.get("plan") ?? query.get("bundle") ?? "").toLowerCase()];
  return plan ? { plan, interval: PERIODS[(query.get("period") ?? "").toLowerCase()] ?? null } : null;
}

export const planQuery = (intent: PlanIntent | null) => (intent ? `plan=${intent.plan === "starter" ? "plus" : intent.plan === "team" ? "dedicated" : "pro"}${intent.interval ? `&period=${intent.interval}` : ""}` : "");
