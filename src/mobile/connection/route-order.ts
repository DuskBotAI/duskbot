import type { MobileTransport } from "../../../shared/mobile-link";

/** a computer's companion on the phone's own network answers well within this */
export const DIRECT_TRY_MS = 2_500;
/** past this, the companion routes left are skipped and the relay is tried */
export const DIRECT_BUDGET_MS = 6_000;
/** a server's https address ahead of its relay gets this long, so the relay still fits in a link attempt's deadline */
export const HTTPS_BEFORE_RELAY_MS = 5_000;

const relayed = (routes: readonly MobileTransport[]) => routes.some((route) => route.kind === "relay");

/** Android's web view cannot read a live stream from a computer's plain-http companion out of its https page (mixed
 * content), so there the relay carries the phone and the companion is the fallback. */
const relayFirst = (os: string | undefined, routes: readonly MobileTransport[]) => os === "android" && relayed(routes);

/** The order a phone tries a workspace's routes: where a relay is there too, a computer's wi-fi and tailnet addresses go
 * first, so the relay carries the phone only while no direct route answers (on Android the relay goes first). Otherwise
 * the order stays as given. */
export function routeOrder(routes: readonly MobileTransport[], os?: string): MobileTransport[] {
  if (!relayed(routes)) return [...routes];
  const direct = routes.filter((route) => route.kind === "companion"), rest = routes.filter((route) => route.kind !== "companion");
  return relayFirst(os, routes) ? [...rest, ...direct] : [...direct, ...rest];
}

/** how long one route gets: a companion or https address ahead of a relay only briefly, everything else `fullMs` */
export function routeTimeout(route: MobileTransport, routes: readonly MobileTransport[], fullMs: number, os?: string): number {
  if (route.kind === "https" && relayed(routes)) return Math.min(HTTPS_BEFORE_RELAY_MS, fullMs);
  return route.kind === "companion" && relayed(routes) && !relayFirst(os, routes) ? DIRECT_TRY_MS : fullMs;
}

/** a companion route is still worth trying: the walk has not spent its direct budget yet, or no relay waits behind it */
export function directStillWorthIt(route: MobileTransport, routes: readonly MobileTransport[], startedAt: number, now = Date.now(), os?: string): boolean {
  return route.kind !== "companion" || !relayed(routes) || relayFirst(os, routes) || now - startedAt < DIRECT_BUDGET_MS;
}

export const COMPANION_HEAD_START_MS = 300;
export const HTTPS_HEAD_START_MS = 1_000;
export const RELAY_HEAD_START_MS = 3_000;
/** a companion raced beside the others can wait for a slow Wi-Fi this long without holding anything up */
export const RACED_COMPANION_TRY_MS = 8_000;

/** how long a route has the walk to itself before the next one is tried beside it; on Android the relay keeps a lead */
export function routeHeadStart(route: MobileTransport, routes: readonly MobileTransport[], os?: string): number {
  if (route.kind === "companion") return COMPANION_HEAD_START_MS;
  return route.kind === "relay" && relayFirst(os, routes) ? RELAY_HEAD_START_MS : HTTPS_HEAD_START_MS;
}

/** `final`: this route's answer settles the walk with no route, whatever the others would say */
export type RouteOutcome<T> = { kind: "ok"; value: T } | { kind: "failed" } | { kind: "final" };

/** Tries routes in order, each one starting once the one before it failed or had its head start, and settles on the
 * first that works: the rest are aborted, and `discard` gets any that worked too late. With none working (or one
 * `final`) it gives what each route said, in the routes' order. */
export function raceRoutes<R, T>(routes: readonly R[], options: {
  headStart: (route: R) => number;
  attempt: (route: R, signal: AbortSignal) => Promise<RouteOutcome<T>>;
  discard?: (value: T) => void;
  signal: AbortSignal;
}): Promise<{ won: T } | { outcomes: Array<RouteOutcome<T>> }> {
  const outcomes: Array<RouteOutcome<T>> = [];
  const stop = new AbortController();
  const signal = AbortSignal.any([options.signal, stop.signal]);
  return new Promise((resolve, reject) => {
    let started = 0, settled = 0, done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      done = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", aborted);
      stop.abort();
    };
    function aborted() { finish(); reject(options.signal.reason); }
    const startNext = () => {
      clearTimeout(timer);
      if (done || started >= routes.length) return;
      const index = started++;
      const route = routes[index];
      if (started < routes.length) timer = setTimeout(startNext, options.headStart(route));
      void options.attempt(route, signal).catch((): RouteOutcome<T> => ({ kind: "failed" })).then((outcome) => {
        outcomes[index] = outcome;
        settled += 1;
        if (done) { if (outcome.kind === "ok") options.discard?.(outcome.value); return; }
        if (outcome.kind === "ok") { finish(); resolve({ won: outcome.value }); return; }
        if (outcome.kind === "final" || settled === routes.length) { finish(); resolve({ outcomes }); return; }
        if (index === started - 1) startNext();
      });
    };
    if (options.signal.aborted) { aborted(); return; }
    options.signal.addEventListener("abort", aborted, { once: true });
    if (!routes.length) { finish(); resolve({ outcomes }); return; }
    startNext();
  });
}
