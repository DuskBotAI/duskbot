import type { MobileTransport } from "../../../shared/mobile-link";

/** a computer's companion on the phone's own network answers well within this */
export const DIRECT_TRY_MS = 2_500;
/** past this, the companion routes left are skipped and the relay is tried */
export const DIRECT_BUDGET_MS = 6_000;

const relayed = (routes: readonly MobileTransport[]) => routes.some((route) => route.kind === "relay");

/** The order a phone tries a workspace's routes: where a relay is there too, a computer's wi-fi and tailnet addresses go
 * first, so the relay carries the phone only while no direct route answers. Otherwise the order stays as given. */
export function routeOrder(routes: readonly MobileTransport[]): MobileTransport[] {
  if (!relayed(routes)) return [...routes];
  return [...routes.filter((route) => route.kind === "companion"), ...routes.filter((route) => route.kind !== "companion")];
}

/** how long one route gets: a companion ahead of a relay only briefly, everything else `fullMs` */
export function routeTimeout(route: MobileTransport, routes: readonly MobileTransport[], fullMs: number): number {
  return route.kind === "companion" && relayed(routes) ? DIRECT_TRY_MS : fullMs;
}

/** a companion route is still worth trying: the walk has not spent its direct budget yet, or no relay waits behind it */
export function directStillWorthIt(route: MobileTransport, routes: readonly MobileTransport[], startedAt: number, now = Date.now()): boolean {
  return route.kind !== "companion" || !relayed(routes) || now - startedAt < DIRECT_BUDGET_MS;
}
