// The person's own X sign-in route against a fixture page: no browser and no X account is used.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSessionProvider, graphqlOp, X_ACCOUNT_CARD, X_ACCOUNT_TELL, XAccountStore, type XSessionBrowser } from "./session.ts";
import { XSkip, type XCall } from "./types.ts";

const SEARCH = readFileSync(join(import.meta.dirname, "fixtures", "session-search-timeline.json"), "utf8");
const call: XCall = { botId: "bot-1", threadId: "t-1", credential: null };
const TARGET = { key: "bot:bot-1", session: "bot-bot-1" };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(options: { page?: (url: string) => { url: string; responses: Array<{ name: string; status: number; body: string }> }; use?: "on" | "off"; answer?: "allow" | "deny" | "timeout" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "x-session-"));
  dirs.push(dir);
  const store = new XAccountStore(dir);
  if (options.use) store.update(TARGET.key, (record) => ({ ...record, use: options.use }));
  let at = Date.UTC(2026, 10, 21, 12);
  const time = { now: () => at, advance: (ms: number) => { at += ms; } };
  const page = options.page ?? ((url: string) => ({ url, responses: [{ name: "SearchTimeline", status: 200, body: SEARCH }] }));
  const read = vi.fn(async (_target: unknown, request: { url: string }) => page(request.url));
  const browser: XSessionBrowser = { target: async () => TARGET, read };
  const sleep = vi.fn(async (ms: number) => { time.advance(ms); });
  const askPerson = vi.fn(async () => options.answer ?? "allow");
  const provider = createSessionProvider({ browser, store, askPerson, now: time.now, random: () => 0, sleep });
  return { dir, store, read, sleep, askPerson, provider, time };
}

describe("X sign-in route", () => {
  it("is not used until the person said yes", async () => {
    const { provider, read } = setup();
    await expect(provider.search!({ query: "a", sort: "latest", limit: 5 }, call)).rejects.toMatchObject({ reason: "not_set_up" });
    expect(read).not.toHaveBeenCalled();
    expect(await provider.usable(call)).toBeNull();
  });

  it("reads what x.com's search page fetched: newest first, no ads, both row shapes", async () => {
    const { provider, read } = setup({ use: "on" });
    const answer = await provider.search!({ query: "openai science", sort: "latest", limit: 10 }, call);
    expect(read.mock.calls[0]![1]).toMatchObject({ url: "https://x.com/search?q=openai%20science&src=typed_query&f=live", ops: ["SearchTimeline"] });
    expect(answer.posts.map((post) => post.id)).toEqual(["2123900000000000001", "2123899406550528422", "2123862344422088794", "2123856316187975756"]);
    expect(answer.posts.find((post) => post.text === "an ad")).toBeUndefined();
    expect(answer.posts[0]).toMatchObject({ author: "@maus", isReply: true, likes: 3, views: 40, createdAt: "2026-11-20T23:00:00.000Z" });
    expect(answer.posts[1]).toMatchObject({ author: "@OpenAI", likes: 1423 });
    expect(answer.newestId).toBe("2123900000000000001");
  });

  it("asks X for posts since the last one and keeps only newer ones", async () => {
    const { provider, read } = setup({ use: "on" });
    const answer = await provider.search!({ query: "a", sort: "latest", limit: 10, sinceId: "2123862344422088794" }, call);
    expect(decodeURIComponent(String(read.mock.calls[0]![1].url))).toContain("a since_id:2123862344422088794");
    expect(answer.posts.map((post) => post.id)).toEqual(["2123900000000000001", "2123899406550528422"]);
  });

  it("reads a watch at most every 15 minutes, telling a sooner one that nothing was read", async () => {
    const { provider, read, time } = setup({ use: "on" });
    await provider.search!({ query: "a", sort: "latest", limit: 10, sinceId: "1" }, call);
    await expect(provider.search!({ query: "a", sort: "latest", limit: 10, sinceId: "1" }, call)).rejects.toMatchObject({ reason: "paced" });
    time.advance(15 * 60_000);
    await provider.search!({ query: "a", sort: "latest", limit: 10, sinceId: "1" }, call);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("goes at a person's pace: a burst of three, then one every 15-30 s", async () => {
    const { provider, sleep } = setup({ use: "on" });
    for (let i = 0; i < 4; i++) await provider.search!({ query: `q${i}`, sort: "latest", limit: 5 }, call);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep.mock.calls[0]![0]).toBe(15_000);
  });

  it("stops at 150 reads a day", async () => {
    const { provider, store, read } = setup({ use: "on" });
    store.update(TARGET.key, (record) => ({ ...record, day: "2026-11-21", count: 150 }));
    await expect(provider.search!({ query: "a", sort: "latest", limit: 5 }, call)).rejects.toMatchObject({ reason: "daily_cap" });
    expect(read).not.toHaveBeenCalled();
  });

  it("stops for a day on a check or a limit, telling the person once, and keeps that over a restart", async () => {
    const { provider, dir, read, time } = setup({ use: "on", page: () => ({ url: "https://x.com/account/access", responses: [] }) });
    const first = await provider.search!({ query: "a", sort: "latest", limit: 5 }, call).catch((error: XSkip) => error);
    expect(first).toMatchObject({ reason: "cooling_down", tell: X_ACCOUNT_TELL.cooldown });
    const again = await provider.search!({ query: "b", sort: "latest", limit: 5 }, call).catch((error: XSkip) => error);
    expect(again).toMatchObject({ reason: "cooling_down" });
    expect((again as XSkip).tell).toBeUndefined();
    expect(read).toHaveBeenCalledOnce();
    expect(new XAccountStore(dir).get(TARGET.key).cooldownUntil).toBe(time.now() + 24 * 60 * 60_000);
  });

  it("takes X's rate limit answer or a limit code as a check too", async () => {
    const limited = setup({ use: "on", page: (url) => ({ url, responses: [{ name: "SearchTimeline", status: 429, body: "" }] }) });
    await expect(limited.provider.search!({ query: "a", sort: "latest", limit: 5 }, call)).rejects.toMatchObject({ reason: "cooling_down" });
    const coded = setup({ use: "on", page: (url) => ({ url, responses: [{ name: "SearchTimeline", status: 200, body: JSON.stringify({ errors: [{ code: 88, message: "Rate limit exceeded" }] }) }] }) });
    await expect(coded.provider.search!({ query: "a", sort: "latest", limit: 5 }, call)).rejects.toMatchObject({ reason: "cooling_down" });
  });

  it("skips (and says once) when the person is signed out of x.com", async () => {
    const { provider } = setup({ use: "on", page: () => ({ url: "https://x.com/i/flow/login?redirect_after_login=%2Fsearch", responses: [] }) });
    await expect(provider.search!({ query: "a", sort: "latest", limit: 5 }, call)).rejects.toMatchObject({ reason: "signed_out", tell: X_ACCOUNT_TELL.signedOut });
    const again = await provider.search!({ query: "b", sort: "latest", limit: 5 }, call).catch((error: XSkip) => error);
    expect((again as XSkip).tell).toBeUndefined();
  });

  it("fails, never answers empty, when the page fetched nothing readable", async () => {
    const { provider } = setup({ use: "on", page: (url) => ({ url, responses: [] }) });
    await expect(provider.search!({ query: "a", sort: "latest", limit: 5 }, call)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("asks once on a card and remembers the answer for that browser profile", async () => {
    const yes = setup({ answer: "allow" });
    expect(await yes.provider.askable(call)).toEqual(TARGET);
    expect(await yes.provider.ask(call)).toBe(true);
    expect(yes.askPerson).toHaveBeenCalledWith({ botId: "bot-1", threadId: "t-1", ...X_ACCOUNT_CARD, options: [...X_ACCOUNT_CARD.options] });
    expect(X_ACCOUNT_CARD.subtitle).toMatch(/X may limit accounts that automate/);
    expect(await yes.provider.askable(call)).toBeNull();
    expect(await new XAccountStore(yes.dir).get(TARGET.key).use).toBe("on");
    const no = setup({ answer: "deny" });
    expect(await no.provider.ask(call)).toBe(false);
    expect(no.store.get(TARGET.key).use).toBe("off");
    expect(await no.provider.askable(call)).toBeNull();
  });

  it("asks an unanswered card again only after a week", async () => {
    const { provider, time } = setup({ answer: "timeout" });
    expect(await provider.ask(call)).toBe(false);
    expect(await provider.askable(call)).toBeNull();
    time.advance(7 * 24 * 60 * 60_000);
    expect(await provider.askable(call)).toEqual(TARGET);
  });

  it("names only the GraphQL requests it reads", () => {
    expect(graphqlOp("https://x.com/i/api/graphql/abc123/SearchTimeline?variables=%7B%7D", ["SearchTimeline"])).toBe("SearchTimeline");
    expect(graphqlOp("https://x.com/i/api/graphql/abc123/HomeTimeline?variables=%7B%7D", ["SearchTimeline"])).toBeNull();
    expect(graphqlOp("https://x.com/i/api/1.1/jot/client_event.json", ["SearchTimeline"])).toBeNull();
  });
});
