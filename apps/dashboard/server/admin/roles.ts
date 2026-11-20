import type { AdminRole } from "../auth/store.ts";

export type PanelRole = "owner" | AdminRole;

/** security invariant: the only admin requests a growth admin may make. reads of aggregate analytics and revenue, never cloud cost or
 *  cloud figures; every other route, and every change, is refused with 403, so a new route stays owner-only until it is added here */
export const GROWTH_ROUTES: readonly RegExp[] = [
  /^\/me$/, /^\/overview$/, /^\/web$/, /^\/web\/[a-z_]{1,30}$/, /^\/funnel$/, /^\/realtime$/, /^\/retention$/, /^\/waitlist$/, /^\/revenue$/, /^\/subscribers$/, /^\/subscribers\/[A-Za-z0-9_-]{1,80}$/,
];
export const growthMay = (method: string, route: string) => method === "GET" && GROWTH_ROUTES.some(pattern => pattern.test(route));

/** query parameters a growth admin's read ignores: a waitlist search would tell whether an address is on it */
export function growthUrl(route: string, url: URL) {
  if (route !== "/waitlist") return url;
  const clean = new URL(url);
  clean.searchParams.delete("q");
  clean.searchParams.delete("offset");
  return clean;
}

const EMAIL = /[^\s@<>"',;:()]+@[^\s@<>"',;:()]+\.[^\s@<>"',;:()]+/;
const PERSON_FIELDS = ["name", "city", "avatarUrl", "avatar", "region", "phone"] as const;

/** security invariant: what a growth admin receives carries no address, name or precise place of a person. the per-person lists
 *  go; any object that names an email is a person and loses its identifying fields; any address left in free text is masked */
export function forGrowth(route: string, data: unknown): unknown {
  let shaped = data;
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (route === "/waitlist") shaped = { ...record, entries: [], total: typeof record.count === "number" ? record.count : 0, offset: 0 };
    else if (route === "/revenue") shaped = { ...record, customers: [], upcoming: [], risk: [] };
    else if (route === "/overview") {
      const { clouds: _clouds, totals, ...rest } = record as { clouds?: unknown; totals?: Record<string, unknown> };
      const { clouds: _count, ...kept } = totals ?? {};
      shaped = { ...rest, ...(totals ? { totals: kept } : {}) };
    }
  }
  // a live visitor's `name` is the event it sent, not the person's
  return scrub(shaped, route === "/realtime" ? PERSON_FIELDS.filter(key => key !== "name") : PERSON_FIELDS);
}

function scrub(value: unknown, fields: readonly string[]): unknown {
  if (typeof value === "string") return EMAIL.test(value) ? value.replace(new RegExp(EMAIL.source, "g"), "hidden") : value;
  if (Array.isArray(value)) return value.map(item => scrub(item, fields));
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>, person = "email" in source || "actorEmail" in source || "owner" in source && typeof source.owner === "string";
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (key === "email" || key === "actorEmail" || key === "ip") { out[key] = null; continue; }
    if (person && key === "owner" && typeof item === "string") { out[key] = null; continue; }
    if (person && fields.includes(key)) { if (item !== undefined) out[key] = null; continue; }
    if (person && (key === "lat" || key === "lon") && typeof item === "number") { out[key] = Math.round(item); continue; }
    out[key] = scrub(item, fields);
  }
  return out;
}
