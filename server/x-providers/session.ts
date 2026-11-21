// x_search through the person's own x.com sign-in in their bot's browser, only once they said yes on a card in chat.
// The real x.com page is loaded in a background tab and the server keeps what X's own page fetched (SearchTimeline,
// UserTweets, TweetDetail, UserByScreenName), so X's own code signs every request. At a person's pace: a burst of 3,
// then one read every 15-30 s, at most 150 a day, a watch at most every 15 minutes; any check X puts up (a challenge,
// a rate limit) stops it for 24 h and the person hears so once. Security: the sign-in never leaves their browser
// profile; the server reads only the answers to these four kinds of request.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { at, isRow, postList, withReplies, X_MESSAGES, XResearchError, type XPostList, type XPostWithReplies, type XProfile } from "../x-research.ts";
import { findTimeline, timelinePosts, toProfile } from "./graphql.ts";
import { XSkip, type PostInput, type SearchInput, type UserPostsInput, type XCall, type XProvider } from "./types.ts";

export const X_ACCOUNT_FILE = "x-account.json";
const BURST = 3;
const GAP_MS: readonly [number, number] = [15_000, 30_000];
const MAX_WAIT_MS = 25_000;
const DAILY_CAP = 150;
const WATCH_GAP_MS = 15 * 60_000;
const COOLDOWN_MS = 24 * 60 * 60_000;
/** An unanswered card is asked again after this long; a "Not now" stands. */
const ASK_AGAIN_MS = 7 * 24 * 60 * 60_000;
const READ_TIMEOUT_MS = 25_000;
const MAX_WATCHES = 200;

export const X_ACCOUNT_CARD = {
  title: "Search X with your X account?",
  subtitle: "Live X search can use your x.com sign-in in my browser, a few reads a minute at most. X may limit accounts that automate.",
  options: ["Use my X account", "Not now"],
} as const;
export const X_ACCOUNT_TELL = {
  cooldown: "X asked your account for a check, so I stopped searching X with it for a day. Open x.com in my browser if you want to clear it sooner.",
  signedOut: "To get live X results, sign in to x.com in my browser.",
} as const;

/** The bot's browser this person signs in to X with: dusk bot's own Chrome engine, a kept profile. */
export interface XSessionTarget { key: string; session: string }

export interface XSessionBrowser {
  /** Null when the bot has no such browser here (no browser, a temporary one, or the agent-browser engine). */
  target(botId: string, threadId?: string): Promise<XSessionTarget | null>;
  read(target: XSessionTarget, request: { url: string; ops: readonly string[]; timeoutMs: number }): Promise<{ url: string; responses: Array<{ name: string; status: number; body: string }> }>;
}

export type XAskAnswer = "allow" | "deny" | "timeout" | "replied";

interface ProfileRecord {
  use?: "on" | "off";
  askedAt?: number;
  cooldownUntil?: number;
  toldCooldown?: number;
  toldSignedOut?: number;
  day?: string;
  count?: number;
  watches?: Record<string, number>;
}

/** Per browser profile (where the person's X sign-in lives): their answer, the day's count, a cooldown, the watches'
 * last reads. Kept in the data folder so a restart keeps a cooldown and the day's cap. */
export class XAccountStore {
  readonly #path: string | null;
  #records: Record<string, ProfileRecord>;

  constructor(dataDir: string | null) {
    this.#path = dataDir ? join(dataDir, X_ACCOUNT_FILE) : null;
    this.#records = {};
    if (!this.#path) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.#path, "utf8"));
      if (isRow(parsed) && isRow(parsed.profiles)) this.#records = parsed.profiles as Record<string, ProfileRecord>;
    } catch {
      // first run, or an unreadable file: start empty
    }
  }

  get(key: string): ProfileRecord {
    return this.#records[key] ?? {};
  }

  update(key: string, change: (record: ProfileRecord) => ProfileRecord): ProfileRecord {
    const next = change({ ...this.get(key) });
    this.#records[key] = next;
    if (this.#path) writeFileAtomic(this.#path, `${JSON.stringify({ v: 1, profiles: this.#records })}\n`);
    return next;
  }
}

export interface XSessionOptions {
  browser: XSessionBrowser;
  store: XAccountStore;
  /** Posts the card in the conversation and waits for the person's answer. */
  askPerson?: (input: { botId: string; threadId: string; title: string; subtitle: string; options: string[] }) => Promise<XAskAnswer>;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** x.com, or a stand-in in tests. */
  origin?: string;
}

const GRAPHQL = /\/i\/api\/graphql\/[^/?]+\/([A-Za-z]+)(?:\?|$)/;
const SIGNED_OUT = /^\/(?:login|i\/flow\/(?:login|signup)|i\/jf\/|logout)/;
const CHALLENGE = /^\/(?:account\/access|i\/flow\/|account\/locked)|captcha|arkose/i;
/** X's error codes for a limited, locked or challenged account. */
const LIMIT_CODES = new Set([88, 326, 64, 141, 239]);

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface XSessionProvider extends XProvider {
  /** The profile this call would read with, when the person said yes and the bot has such a browser. */
  usable(call: XCall): Promise<XSessionTarget | null>;
  /** The profile to ask about, when nobody has answered for it yet (or the card went unanswered long ago). */
  askable(call: XCall): Promise<XSessionTarget | null>;
  /** Asks once on a card; true when the person said yes. */
  ask(call: XCall): Promise<boolean>;
}

export function createSessionProvider(options: XSessionOptions): XSessionProvider {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const buckets = new Map<string, { tokens: number; refillAt: number }>();
  const queues = new Map<string, Promise<unknown>>();
  const asking = new Map<string, Promise<boolean>>();
  const store = options.store;
  const origin = options.origin ?? "https://x.com";

  const usable = async (call: XCall): Promise<XSessionTarget | null> => {
    const target = await options.browser.target(call.botId, call.threadId);
    return target && store.get(target.key).use === "on" ? target : null;
  };

  /** One read at a time per profile, each after its turn in the bucket. */
  function paced<T>(target: XSessionTarget, work: () => Promise<T>): Promise<T> {
    const previous = queues.get(target.key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      const record = store.get(target.key);
      if ((record.cooldownUntil ?? 0) > now()) throw new XSkip("cooling_down");
      const today = dayOf(now());
      if (record.day === today && (record.count ?? 0) >= DAILY_CAP) throw new XSkip("daily_cap");
      const gap = () => GAP_MS[0] + random() * (GAP_MS[1] - GAP_MS[0]);
      const bucket = buckets.get(target.key) ?? { tokens: BURST, refillAt: now() };
      while (bucket.tokens < BURST && now() >= bucket.refillAt) {
        bucket.tokens += 1;
        bucket.refillAt += gap();
      }
      if (bucket.tokens >= 1) {
        if (bucket.tokens === BURST) bucket.refillAt = now() + gap();
        bucket.tokens -= 1;
      } else {
        const wait = bucket.refillAt - now();
        if (wait > MAX_WAIT_MS) throw new XSkip("busy");
        await sleep(wait);
        bucket.refillAt += gap();
      }
      buckets.set(target.key, bucket);
      store.update(target.key, (current) => ({ ...current, day: today, count: current.day === today ? (current.count ?? 0) + 1 : 1 }));
      return work();
    });
    queues.set(target.key, run.catch(() => undefined));
    return run;
  }

  /** Loads the page and returns the named answers' data; signed out, a check or a limit end the read. */
  async function read(target: XSessionTarget, url: string, op: string): Promise<unknown> {
    let page: Awaited<ReturnType<XSessionBrowser["read"]>>;
    try {
      page = await options.browser.read(target, { url, ops: [op], timeoutMs: READ_TIMEOUT_MS });
    } catch {
      throw new XResearchError("unavailable", X_MESSAGES.unavailable);
    }
    let path = "";
    try {
      const parsed = new URL(page.url);
      path = `${parsed.pathname}${parsed.search}`;
    } catch {
      // about:blank, or a page that never loaded
    }
    if (SIGNED_OUT.test(path)) {
      const record = store.get(target.key);
      const tell = record.toldSignedOut ? undefined : X_ACCOUNT_TELL.signedOut;
      if (tell) store.update(target.key, (current) => ({ ...current, toldSignedOut: now() }));
      throw new XSkip("signed_out", tell);
    }
    const answers = page.responses.filter((response) => response.name === op);
    const limited = answers.some((response) => response.status === 429) || CHALLENGE.test(path) || answers.some((response) => limitCode(response.body));
    if (limited) {
      const tell = store.get(target.key).toldCooldown && store.get(target.key).toldCooldown! > now() - COOLDOWN_MS ? undefined : X_ACCOUNT_TELL.cooldown;
      store.update(target.key, (current) => ({ ...current, cooldownUntil: now() + COOLDOWN_MS, ...(tell ? { toldCooldown: now() } : {}) }));
      throw new XSkip("cooling_down", tell);
    }
    const ok = answers.find((response) => response.status === 200);
    if (!ok) throw new XResearchError("unavailable", X_MESSAGES.unavailable);
    let body: unknown;
    try {
      body = JSON.parse(ok.body);
    } catch {
      throw new XResearchError("unavailable", X_MESSAGES.unavailable);
    }
    const data = at(body, "data");
    if (!isRow(data)) throw new XResearchError("unavailable", X_MESSAGES.unavailable);
    if (store.get(target.key).toldSignedOut) store.update(target.key, (current) => ({ ...current, toldSignedOut: undefined }));
    return data;
  }

  /** A watch (an ask with sinceId) reads at most once per 15 minutes; asked sooner, nothing is read. */
  function watchDue(where: XSessionTarget, kind: string, sinceId: string | undefined): void {
    if (sinceId === undefined) return;
    const last = store.get(where.key).watches?.[kind];
    if (last !== undefined && now() - last < WATCH_GAP_MS) throw new XSkip("paced");
  }

  function watchRead(where: XSessionTarget, kind: string, sinceId: string | undefined): void {
    if (sinceId === undefined) return;
    store.update(where.key, (current) => {
      const watches = Object.entries({ ...current.watches, [kind]: now() }).filter(([, at]) => now() - at < WATCH_GAP_MS * 4).slice(-MAX_WATCHES);
      return { ...current, watches: Object.fromEntries(watches) };
    });
  }

  const target = async (call: XCall) => {
    const found = await usable(call);
    if (!found) throw new XSkip("not_set_up");
    return found;
  };

  return {
    id: "session",
    emptyIsAnswer: true,
    personal: true,
    usable,
    async askable(call) {
      if (!options.askPerson || !call.threadId) return null;
      const found = await options.browser.target(call.botId, call.threadId);
      if (!found) return null;
      const record = store.get(found.key);
      if (record.use !== undefined) return null;
      return record.askedAt !== undefined && now() - record.askedAt < ASK_AGAIN_MS ? null : found;
    },
    async ask(call) {
      if (!options.askPerson || !call.threadId) return false;
      const found = await options.browser.target(call.botId, call.threadId);
      if (!found) return false;
      const open = asking.get(found.key);
      if (open) return open;
      store.update(found.key, (current) => ({ ...current, askedAt: now() }));
      const answer = options.askPerson({ botId: call.botId, threadId: call.threadId, ...X_ACCOUNT_CARD, options: [...X_ACCOUNT_CARD.options] }).then((said) => {
        if (said === "allow" || said === "deny") store.update(found.key, (current) => ({ ...current, use: said === "allow" ? "on" : "off" }));
        return said === "allow";
      }, () => false).finally(() => asking.delete(found.key));
      asking.set(found.key, answer);
      return answer;
    },
    async search(input: SearchInput, call: XCall): Promise<XPostList> {
      const where = await target(call);
      const watch = `search:${input.sort}:${input.query.toLowerCase()}`;
      watchDue(where, watch, input.sinceId);
      const query = input.sinceId === undefined ? input.query : `${input.query} since_id:${input.sinceId}`;
      const data = await paced(where, () => read(where, `${origin}/search?q=${encodeURIComponent(query)}&src=typed_query&f=${input.sort === "top" ? "top" : "live"}`, "SearchTimeline"));
      watchRead(where, watch, input.sinceId);
      const posts = timelinePosts(findTimeline(data));
      if (input.sort === "latest") posts.sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
      return postList(posts, { limit: input.limit, sinceId: input.sinceId, more: posts.length >= input.limit });
    },
    async userPosts(input: UserPostsInput, call: XCall): Promise<XPostList> {
      const where = await target(call);
      const watch = `user:${input.handle.toLowerCase()}:${input.includeReplies}`;
      watchDue(where, watch, input.sinceId);
      const op = input.includeReplies ? "UserTweetsAndReplies" : "UserTweets";
      const data = await paced(where, () => read(where, `${origin}/${input.handle}${input.includeReplies ? "/with_replies" : ""}`, op));
      watchRead(where, watch, input.sinceId);
      const posts = timelinePosts(findTimeline(data), input.handle)
        .filter((post) => input.includeReplies || post.isReply !== true)
        .sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
      const reached = input.sinceId !== undefined && posts.some((post) => BigInt(post.id) <= BigInt(input.sinceId!));
      return postList(posts, { limit: input.limit, sinceId: input.sinceId, more: posts.length > 0 && !reached });
    },
    async post(input: PostInput, call: XCall): Promise<XPostWithReplies> {
      const where = await target(call);
      const data = await paced(where, () => read(where, `${origin}/${input.handle ?? "i"}/status/${input.id}`, "TweetDetail"));
      const posts = timelinePosts(findTimeline(data));
      const post = posts.find((one) => one.id === input.id);
      if (!post) throw new XResearchError("not_found", X_MESSAGES.postNotFound);
      if (!input.replies) return { post };
      return withReplies(post, posts.filter((one) => one.id !== input.id && BigInt(one.id) > BigInt(input.id)), true);
    },
    async profile(handle: string, call: XCall): Promise<XProfile> {
      const where = await target(call);
      const data = await paced(where, () => read(where, `${origin}/${handle}`, "UserByScreenName"));
      const found = toProfile(at(data, "user", "result"));
      if (!found) throw new XResearchError("not_found", X_MESSAGES.accountNotFound(handle));
      return found;
    },
  };
}

function limitCode(body: string): boolean {
  if (!body.includes("errors")) return false;
  try {
    const errors = at(JSON.parse(body), "errors");
    return Array.isArray(errors) && errors.some((error) => LIMIT_CODES.has(Number(at(error, "code"))));
  } catch {
    return false;
  }
}

/** The GraphQL operation a request URL names, when it is one of `ops`. */
export function graphqlOp(url: string, ops: readonly string[]): string | null {
  const name = GRAPHQL.exec(url)?.[1];
  return name && ops.includes(name) ? name : null;
}
