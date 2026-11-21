import { describe, expect, it, vi } from "vitest";

import { X_MESSAGES, XResearchError, type XPost, type XPostList } from "../x-research.ts";
import { XRouter } from "./router.ts";
import type { XSessionProvider } from "./session.ts";
import { XSkip, type XCall, type XProvider, type XProviderId } from "./types.ts";

const call: XCall = { botId: "bot-1", threadId: "t-1", credential: null };
const post = (id: string): XPost => ({ id, url: `https://x.com/a/status/${id}`, author: "@a", text: id });
const list = (...ids: string[]): XPostList => ({ newestId: ids[0], more: false, posts: ids.map(post) });
const down = () => new XResearchError("unavailable", X_MESSAGES.unavailable);

function provider(id: XProviderId, parts: Partial<XProvider> = {}): XProvider {
  return { id, emptyIsAnswer: false, ...parts };
}

function clock(start = 1_000_000) {
  let at = start;
  return { now: () => at, advance: (ms: number) => { at += ms; } };
}

describe("x_search router", () => {
  it("fails over in order: a failing route, then the next", async () => {
    const treg = vi.fn(async () => { throw down(); });
    const web = vi.fn(async () => ({ ...list("5"), freshness: "days" as const, newestId: undefined }));
    const router = new XRouter({ providers: [provider("treg", { search: treg }), provider("websearch", { search: web })] });
    const answer = await router.client({ ...call, credential: { token: "k", api: "https://t", included: false } }).search({ query: "q", sort: "latest", limit: 5 });
    expect(treg).toHaveBeenCalledOnce();
    expect(answer.posts.map((p) => p.id)).toEqual(["5"]);
  });

  it("never answers an empty list when every route failed: one sentence with the search on X", async () => {
    const router = new XRouter({ providers: [provider("treg", { search: async () => { throw down(); } }), provider("websearch", { search: async () => { throw down(); } })] });
    const failed = router.client(call).search({ query: "claude code", sort: "latest", limit: 5, sinceId: "10" });
    await expect(failed).rejects.toMatchObject({ code: "unavailable", message: X_MESSAGES.allDown("https://x.com/search?q=claude%20code&f=live") });
  });

  it("looks past an empty list from a route that can't vouch for it, and keeps it only if nothing better comes", async () => {
    const treg = vi.fn(async () => list());
    const web = vi.fn(async () => ({ more: false, freshness: "days" as const, posts: [post("7")] }));
    const router = new XRouter({ providers: [provider("treg", { search: treg }), provider("websearch", { search: web })] });
    expect((await router.client(call).search({ query: "a", sort: "latest", limit: 5 })).posts).toHaveLength(1);
    const empty = new XRouter({ providers: [provider("treg", { search: async () => list() }), provider("websearch", { search: async () => { throw down(); } })] });
    expect(await empty.client(call).search({ query: "b", sort: "latest", limit: 5 })).toMatchObject({ posts: [] });
  });

  it("takes an empty list as the answer for a watch, so it reads as nothing new", async () => {
    const treg = vi.fn(async () => list());
    const web = vi.fn();
    const router = new XRouter({ providers: [provider("treg", { search: treg }), provider("websearch", { search: web })] });
    expect(await router.client(call).search({ query: "a", sort: "latest", limit: 5, sinceId: "3" })).toMatchObject({ posts: [] });
    expect(web).not.toHaveBeenCalled();
  });

  it("passes a route that cannot take the ask without counting it", async () => {
    const syndication = vi.fn(async () => { throw new XSkip("not_for_this"); });
    const xpage = vi.fn(async () => ({ post: post("9") }));
    const router = new XRouter({ providers: [provider("syndication", { post: syndication }), provider("xpage", { post: xpage })] });
    expect((await router.client(call).post({ id: "9", replies: false })).post.id).toBe("9");
    expect(router.health().find((row) => row.id === "syndication")).toMatchObject({ recent: 0, failed: 0 });
  });

  it("lets the next route try a query one route refused, says the refusal only when none answers, and not found only when no route found it", async () => {
    const next = vi.fn(async () => ({ handle: "@a", url: "https://x.com/a" }));
    const bad = new XRouter({ providers: [provider("xpage", { profile: async () => { throw new XResearchError("bad_input", "bad"); } }), provider("treg", { profile: next })] });
    expect(await bad.client(call).profile("a")).toMatchObject({ handle: "@a" });
    const refused = new XRouter({ providers: [provider("xpage", { profile: async () => { throw new XResearchError("bad_input", "bad"); } }), provider("treg", { profile: async () => { throw down(); } })] });
    await expect(refused.client(call).profile("b")).rejects.toMatchObject({ code: "bad_input" });
    const missing = new XRouter({ providers: [provider("syndication", { post: async () => { throw new XResearchError("not_found", X_MESSAGES.postNotFound); } }), provider("xpage", { post: async () => { throw down(); } })] });
    await expect(missing.client(call).post({ id: "1", replies: false })).rejects.toMatchObject({ code: "not_found" });
  });

  it("surfaces a treg refusal the person can fix over the all-down sentence", async () => {
    const router = new XRouter({ providers: [provider("treg", { search: async () => { throw new XResearchError("no_credit", "Top up."); } }), provider("websearch", { search: async () => { throw down(); } })] });
    await expect(router.client(call).search({ query: "a", sort: "latest", limit: 5 })).rejects.toMatchObject({ code: "no_credit", message: "Top up." });
  });

  it("opens a route's breaker after five failures in a row, then tries it once after five minutes", async () => {
    const time = clock();
    const syndication = vi.fn(async (): Promise<{ post: XPost }> => { throw down(); });
    const xpage = vi.fn(async (input: { id: string }) => ({ post: post(input.id) }));
    const router = new XRouter({ providers: [provider("syndication", { post: syndication }), provider("xpage", { post: xpage })], now: time.now });
    for (let i = 0; i < 5; i++) await router.client(call).post({ id: String(100 + i), replies: false });
    expect(syndication).toHaveBeenCalledTimes(5);
    await router.client(call).post({ id: "200", replies: false });
    expect(syndication).toHaveBeenCalledTimes(5);
    expect(router.health().find((row) => row.id === "syndication")).toMatchObject({ state: "open", streak: 5 });
    time.advance(5 * 60_000 + 1);
    expect(router.health().find((row) => row.id === "syndication")?.state).toBe("half-open");
    syndication.mockImplementationOnce(async () => ({ post: post("201") }));
    await router.client(call).post({ id: "201", replies: false });
    expect(syndication).toHaveBeenCalledTimes(6);
    expect(router.health().find((row) => row.id === "syndication")?.state).toBe("closed");
  });

  it("a failed half-open try opens the breaker again", async () => {
    const time = clock();
    const syndication = vi.fn(async (): Promise<{ post: XPost }> => { throw down(); });
    const router = new XRouter({ providers: [provider("syndication", { post: syndication }), provider("xpage", { post: async (input) => ({ post: post(input.id) }) })], now: time.now });
    for (let i = 0; i < 5; i++) await router.client(call).post({ id: String(i + 1), replies: false });
    time.advance(5 * 60_000 + 1);
    await router.client(call).post({ id: "50", replies: false });
    expect(router.health().find((row) => row.id === "syndication")?.state).toBe("open");
  });

  it("opens on half of the last twenty failing even without a streak", async () => {
    const time = clock();
    let n = 0;
    const flaky = vi.fn(async (input: { id: string }) => { if (n++ % 2 === 0) throw down(); return { post: post(input.id) }; });
    const router = new XRouter({ providers: [provider("syndication", { post: flaky }), provider("xpage", { post: async (input) => ({ post: post(input.id) }) })], now: time.now });
    for (let i = 0; i < 11; i++) await router.client(call).post({ id: String(i + 1), replies: false });
    expect(router.health().find((row) => row.id === "syndication")).toMatchObject({ state: "open", streak: 1 });
  });

  it("gives up on a route that hangs, as a failure", async () => {
    const hang = vi.fn(() => new Promise<{ post: XPost }>(() => {}));
    const router = new XRouter({ providers: [provider("syndication", { post: hang }), provider("xpage", { post: async () => ({ post: post("1") }) })], timeoutMs: { syndication: 20 } });
    expect((await router.client(call).post({ id: "1", replies: false })).post.id).toBe("1");
    expect(router.health().find((row) => row.id === "syndication")).toMatchObject({ failed: 1 });
  });

  it("keeps answers briefly, shares one read between identical asks, and never keeps an error", async () => {
    const time = clock();
    let resolve!: (value: XPostList) => void;
    const treg = vi.fn(() => new Promise<XPostList>((done) => { resolve = done; }));
    const router = new XRouter({ providers: [provider("treg", { search: treg })], now: time.now });
    const ask = () => router.client(call).search({ query: "q", sort: "latest", limit: 5 });
    const [a, b] = [ask(), ask()];
    await vi.waitFor(() => expect(treg).toHaveBeenCalledOnce());
    resolve(list("3"));
    expect(await a).toEqual(await b);
    await ask();
    expect(treg).toHaveBeenCalledOnce();
    time.advance(61_000);
    treg.mockImplementationOnce(async () => { throw down(); });
    await expect(ask()).rejects.toBeInstanceOf(XResearchError);
    treg.mockImplementationOnce(async () => list("4"));
    expect((await ask()).newestId).toBe("4");
    expect(treg).toHaveBeenCalledTimes(3);
  });

  it("keeps sinceId exact across a route switch: posts and newestId are whatever the answering route read", async () => {
    const session = sessionStub({ usable: true, search: async () => { throw down(); } });
    const treg = vi.fn(async () => list("12", "11"));
    const router = new XRouter({ providers: [provider("treg", { search: treg })], session });
    const answer = await router.client(call).search({ query: "q", sort: "latest", limit: 5, sinceId: "10" });
    expect(answer).toMatchObject({ newestId: "12", posts: [{ id: "12" }, { id: "11" }] });
  });

  it("tells a watch asked too soon that nothing was read, without caching it", async () => {
    const session = sessionStub({ usable: true, search: async () => { throw new XSkip("paced"); } });
    const router = new XRouter({ providers: [], session });
    expect(await router.client(call).search({ query: "q", sort: "latest", limit: 5, sinceId: "10" })).toEqual({ more: false, note: X_MESSAGES.paced, posts: [] });
  });

  it("carries a sentence the person should hear once as the answer's note", async () => {
    const session = sessionStub({ usable: true, search: async () => { throw new XSkip("cooling_down", "X asked for a check."); } });
    const router = new XRouter({ providers: [provider("treg", { search: async () => list("2") })], session });
    expect(await router.client(call).search({ query: "q", sort: "latest", limit: 5 })).toMatchObject({ note: "X asked for a check.", posts: [{ id: "2" }] });
  });

  it("asks once about the person's X account when search had no live answer, then searches with it", async () => {
    let allowed = false;
    const session = sessionStub({ usable: () => allowed, askable: true, ask: async () => { allowed = true; return true; }, search: async () => list("99") });
    const router = new XRouter({ providers: [provider("websearch", { search: async () => ({ more: false, freshness: "days", posts: [post("1")] }) })], session });
    expect((await router.client(call).search({ query: "q", sort: "latest", limit: 5 })).posts[0]!.id).toBe("99");
    expect(session.ask).toHaveBeenCalledOnce();
  });

  it("keeps the older posts when the person says not now, and never asks for or answers a watch from them", async () => {
    const session = sessionStub({ askable: true, ask: async () => false });
    // a route that wrongly answers a watch from the web index is not believed
    const router = new XRouter({ providers: [provider("websearch", { search: async () => ({ more: false, freshness: "days", posts: [post("1")] }) })], session });
    expect(await router.client(call).search({ query: "q", sort: "latest", limit: 5 })).toMatchObject({ freshness: "days" });
    await expect(router.client(call).search({ query: "q", sort: "latest", limit: 5, sinceId: "1" })).rejects.toMatchObject({ code: "unavailable" });
    expect(session.ask).toHaveBeenCalledOnce();
  });
});

function sessionStub(options: { usable?: boolean | (() => boolean); askable?: boolean; ask?: () => Promise<boolean>; search?: XProvider["search"] }): XSessionProvider & { ask: ReturnType<typeof vi.fn> } {
  const usable = typeof options.usable === "function" ? options.usable : () => options.usable === true;
  const target = { key: "bot:bot-1", session: "s" };
  const stub = {
    id: "session" as const,
    emptyIsAnswer: true,
    personal: true,
    usable: async () => (usable() ? target : null),
    askable: async () => (options.askable ? target : null),
    ask: vi.fn(options.ask ?? (async () => false)),
    search: async (input: Parameters<NonNullable<XProvider["search"]>>[0], c: XCall) => {
      if (!usable()) throw new XSkip("not_set_up");
      return options.search ? options.search(input, c) : list();
    },
  };
  return stub as unknown as XSessionProvider & { ask: ReturnType<typeof vi.fn> };
}
