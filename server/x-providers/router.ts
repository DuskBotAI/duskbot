// x_search's routes in order, per ask. Each route has a breaker per kind of ask: five failures in a row, or half of the
// last twenty within five minutes, open it for five minutes, then one real ask tries it again. Answers are kept
// briefly and identical asks in flight share one read. An empty list from a route that cannot vouch for it is looked
// past; when every route fails the answer is an error, never an empty list, so a watch keeps its sinceId and catches
// up next time.
import { trail } from "../trail.ts";
import { openOnX, X_MESSAGES, XResearchError, type XPostList, type XPostWithReplies, type XProfile, type XResearchClient, type XResearchErrorCode } from "../x-research.ts";
import type { XSessionProvider } from "./session.ts";
import { XSkip, type PostInput, type SearchInput, type UserPostsInput, type XAction, type XCall, type XProvider, type XProviderId } from "./types.ts";

/** The routes tried for each ask, first to last. treg is last among the live routes; the web index, days behind, only
 * after it, so a person who pays for live results gets them. */
export const X_CHAINS: Readonly<Record<string, readonly XProviderId[]>> = {
  search: ["session", "treg", "websearch"],
  userPosts: ["session", "xpage", "treg"],
  post: ["syndication", "xpage", "oembed", "session", "treg"],
  postReplies: ["session", "xpage", "treg"],
  profile: ["xpage", "session", "treg"],
};

const TIMEOUT_MS: Readonly<Record<XProviderId, number>> = { session: 60_000, treg: 36_000, websearch: 20_000, syndication: 10_000, xpage: 12_000, oembed: 10_000 };
const BREAKER = { streak: 5, window: 20, minCalls: 10, rate: 0.5, windowMs: 5 * 60_000, openMs: 5 * 60_000 };
const CACHE_ENTRIES = 500;
/** Failures that say a route is unwell; others (a bad query, a missing post, a key to fix) are the ask's. */
const UNWELL: ReadonlySet<XResearchErrorCode> = new Set(["unavailable", "rate_limited", "in_progress"]);
/** The person's to fix, and worth saying over "X isn't answering" when nothing else answered. */
const ACTIONABLE: ReadonlySet<XResearchErrorCode> = new Set(["bad_key", "no_credit", "off"]);

type Answer = XPostList | XPostWithReplies | XProfile;

interface Breaker { results: Array<{ at: number; ok: boolean }>; streak: number; openUntil: number; trying: boolean }

export interface XRouterOptions {
  providers: readonly XProvider[];
  session?: XSessionProvider;
  now?: () => number;
  timeoutMs?: Partial<Record<XProviderId, number>>;
}

export interface XProviderHealth { id: XProviderId; action: XAction; state: "closed" | "open" | "half-open"; streak: number; recent: number; failed: number }

export function cacheMs(action: XAction, input: { sort?: string; replies?: boolean }, answer: Answer): number {
  if (isList(answer) && answer.freshness) return 10 * 60_000;
  if (action === "search") return input.sort === "top" ? 10 * 60_000 : 60_000;
  if (action === "userPosts") return 60_000;
  if (action === "post" && input.replies) return 2 * 60_000;
  return 15 * 60_000;
}

function isList(answer: Answer): answer is XPostList {
  return Array.isArray((answer as XPostList).posts);
}

function isEmpty(answer: Answer): boolean {
  return isList(answer) && answer.posts.length === 0;
}

export class XRouter {
  readonly #providers = new Map<XProviderId, XProvider>();
  readonly #session: XSessionProvider | undefined;
  readonly #now: () => number;
  readonly #timeouts: Record<XProviderId, number>;
  readonly #breakers = new Map<string, Breaker>();
  readonly #cache = new Map<string, { until: number; answer: Answer }>();
  readonly #flying = new Map<string, Promise<Answer>>();

  constructor(options: XRouterOptions) {
    for (const provider of options.providers) this.#providers.set(provider.id, provider);
    if (options.session) this.#providers.set("session", options.session);
    this.#session = options.session;
    this.#now = options.now ?? Date.now;
    this.#timeouts = { ...TIMEOUT_MS, ...options.timeoutMs };
  }

  /** The X client one tool call uses. */
  client(call: XCall): XResearchClient {
    return {
      search: (input) => this.#ask("search", input, call, openOnX(input), (provider, c) => provider.search?.(input, c)) as Promise<XPostList>,
      userPosts: (input) => this.#ask("userPosts", input, call, openOnX({ handle: input.handle }), (provider, c) => provider.userPosts?.(input, c)) as Promise<XPostList>,
      post: (input) => this.#ask("post", input, call, openOnX(input), (provider, c) => provider.post?.(input, c)) as Promise<XPostWithReplies>,
      profile: (handle) => this.#ask("profile", { handle }, call, openOnX({ handle }), (provider, c) => provider.profile?.(handle, c)) as Promise<XProfile>,
    };
  }

  health(): XProviderHealth[] {
    return [...this.#breakers.entries()].map(([key, breaker]) => {
      const [id, action] = key.split(":") as [XProviderId, XAction];
      const recent = this.#recent(breaker);
      return { id, action, state: this.#state(breaker), streak: breaker.streak, recent: recent.length, failed: recent.filter((result) => !result.ok).length };
    });
  }

  async #ask(action: XAction, input: SearchInput | UserPostsInput | PostInput | { handle: string }, call: XCall, link: string, run: (provider: XProvider, call: XCall) => Promise<Answer> | undefined): Promise<Answer> {
    const live = (await this.#session?.usable(call)) ?? null;
    const paidBy = call.credential ? `${call.credential.included ? "plan" : "own"}:${call.credential.api}` : "";
    const key = `${action}\n${JSON.stringify(input)}\n${live?.key ?? ""}\n${paidBy}`;
    const kept = this.#cache.get(key);
    if (kept && kept.until > this.#now()) return kept.answer;
    const flying = this.#flying.get(key);
    if (flying) return flying;
    const work = this.#walk(action, input, call, link, run).then((answer) => {
      this.#cache.delete(key);
      if (!(isList(answer) && answer.note === X_MESSAGES.paced)) this.#cache.set(key, { until: this.#now() + cacheMs(action, input as { sort?: string; replies?: boolean }, answer), answer });
      for (const [oldest] of this.#cache) {
        if (this.#cache.size <= CACHE_ENTRIES) break;
        this.#cache.delete(oldest);
      }
      return answer;
    }).finally(() => this.#flying.delete(key));
    this.#flying.set(key, work);
    return work;
  }

  async #walk(action: XAction, input: object, call: XCall, link: string, run: (provider: XProvider, call: XCall) => Promise<Answer> | undefined): Promise<Answer> {
    const first = await this.#chain(action, input, call, link, run);
    if ("answer" in first && !(isList(first.answer) && first.answer.freshness)) return first.answer;
    // No live answer for a search or an account's posts: ask the person once whether their own X sign-in may be used.
    const ad = (action === "search" || action === "userPosts") && (input as { sinceId?: string }).sinceId === undefined;
    if (ad && this.#session && (await this.#session.askable(call)) && (await this.#session.ask(call))) {
      const again = await this.#chain(action, input, call, link, run);
      if ("answer" in again) return again.answer;
    }
    if ("answer" in first) return first.answer;
    throw first.error;
  }

  async #chain(action: XAction, input: object, call: XCall, link: string, run: (provider: XProvider, call: XCall) => Promise<Answer> | undefined): Promise<{ answer: Answer } | { error: XResearchError }> {
    const chain = X_CHAINS[action === "post" && (input as { replies?: boolean }).replies ? "postReplies" : action]!;
    let emptyAnswer: Answer | null = null;
    let notFound: XResearchError | null = null;
    let refused: XResearchError | null = null;
    let actionable: XResearchError | null = null;
    let paced = false;
    let tell: string | undefined;
    for (const id of chain) {
      const provider = this.#providers.get(id);
      if (!provider) continue;
      const breakerKey = `${id}:${action}`;
      const breaker = this.#breaker(breakerKey);
      if (!this.#admit(breaker)) continue;
      const started = this.#now();
      let answer: Answer | undefined;
      try {
        answer = await this.#within(id, Promise.resolve().then(() => run(provider, call)));
      } catch (error) {
        breaker.trying = false;
        if (error instanceof XSkip) {
          if (error.reason === "paced") paced = true;
          tell ??= error.tell;
          continue;
        }
        const failure = error instanceof XResearchError ? error : new XResearchError("unavailable", X_MESSAGES.unavailable);
        this.#outcome(breaker, id, action, UNWELL.has(failure.code) ? "err" : "ok", started, failure.code);
        // One route refusing the query (its own operators, its own rules) leaves the others to try it.
        if (failure.code === "bad_input") refused ??= failure;
        else if (failure.code === "not_found") notFound ??= failure;
        else if (ACTIONABLE.has(failure.code) || (failure.code === "rate_limited" && id === "treg" && failure.message !== X_MESSAGES.rateLimited)) actionable ??= failure;
        continue;
      }
      breaker.trying = false;
      if (answer === undefined) continue;
      // A watch needs everything since its post; an index days behind cannot promise that.
      if (isList(answer) && answer.freshness && (input as { sinceId?: string }).sinceId !== undefined) continue;
      const withNote = tell && isList(answer) && !answer.note ? { ...answer, note: tell } : answer;
      // An empty list is an answer when the ask was for what is new since a post, or when the route speaks for X.
      if (isEmpty(answer) && !provider.emptyIsAnswer && (input as { sinceId?: string }).sinceId === undefined) {
        this.#outcome(breaker, id, action, "empty", started);
        emptyAnswer ??= withNote;
        continue;
      }
      this.#outcome(breaker, id, action, "ok", started);
      return { answer: withNote };
    }
    if (emptyAnswer) return { answer: emptyAnswer };
    if (notFound) return { error: notFound };
    if (refused) return { error: refused };
    if (actionable) return { error: actionable };
    if (paced) return { answer: { more: false, note: X_MESSAGES.paced, posts: [] } };
    return { error: new XResearchError("unavailable", X_MESSAGES.allDown(link)) };
  }

  #within<T>(id: XProviderId, work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new XResearchError("unavailable", X_MESSAGES.unavailable)), this.#timeouts[id]);
      timer.unref?.();
    });
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
  }

  #breaker(key: string): Breaker {
    let breaker = this.#breakers.get(key);
    if (!breaker) this.#breakers.set(key, breaker = { results: [], streak: 0, openUntil: 0, trying: false });
    return breaker;
  }

  #state(breaker: Breaker): "closed" | "open" | "half-open" {
    if (breaker.openUntil === 0) return "closed";
    return this.#now() < breaker.openUntil ? "open" : "half-open";
  }

  /** Closed lets every ask through; open none; half-open one at a time. */
  #admit(breaker: Breaker): boolean {
    const state = this.#state(breaker);
    if (state === "closed") return true;
    if (state === "open" || breaker.trying) return false;
    breaker.trying = true;
    return true;
  }

  #recent(breaker: Breaker) {
    const since = this.#now() - BREAKER.windowMs;
    return breaker.results.filter((result) => result.at >= since).slice(-BREAKER.window);
  }

  #outcome(breaker: Breaker, id: XProviderId, action: XAction, outcome: "ok" | "err" | "empty", started: number, code?: string): void {
    const ms = this.#now() - started;
    trail("x.provider", { provider: id, action, outcome, ms, ...(code ? { code } : {}) });
    if (outcome === "empty") return;
    const ok = outcome === "ok";
    breaker.results.push({ at: this.#now(), ok });
    if (breaker.results.length > BREAKER.window * 2) breaker.results.splice(0, breaker.results.length - BREAKER.window);
    breaker.streak = ok ? 0 : breaker.streak + 1;
    const wasOpen = breaker.openUntil !== 0;
    if (ok) {
      if (wasOpen) trail("x.provider.breaker", { provider: id, action, state: "closed" });
      breaker.openUntil = 0;
      return;
    }
    const recent = this.#recent(breaker);
    const failed = recent.filter((result) => !result.ok).length;
    if (wasOpen || breaker.streak >= BREAKER.streak || (recent.length >= BREAKER.minCalls && failed / recent.length >= BREAKER.rate)) {
      breaker.openUntil = this.#now() + BREAKER.openMs;
      trail("x.provider.breaker", { provider: id, action, state: "open", streak: breaker.streak, failed, recent: recent.length });
    }
  }
}
