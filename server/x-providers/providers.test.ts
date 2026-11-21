// The free routes against answers recorded from X on 2026-11-21 (fixtures/); no network.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { ResearchClient } from "../research.ts";
import { XResearchError } from "../x-research.ts";
import { createOembedProvider, readEmbed } from "./oembed.ts";
import { createSyndicationProvider, syndicationToken } from "./syndication.ts";
import { XSkip, type XCall } from "./types.ts";
import { createWebSearchProvider, statusLinks, webQuery } from "./websearch.ts";
import { createXPageProvider, embeddedAnswers } from "./xpage.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
const POST_ID = "2123899406550528422";
const call: XCall = { botId: "bot-1", credential: null };
const credential = { token: "t", api: "https://treg.example.test", included: false };

/** Answers by URL prefix; anything else is a 404. */
function fakeFetch(routes: Array<[string, number, string]>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const hit = routes.find(([prefix]) => url.startsWith(prefix));
    return new Response(hit ? hit[2] : "", { status: hit ? hit[1] : 404 });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("syndication", () => {
  it("derives the embed token the way X's embed script does", () => {
    expect(syndicationToken("20")).toBe(((20 / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, ""));
    expect(syndicationToken(POST_ID)).toMatch(/^[a-z0-9]+$/);
  });

  it("reads a post with its counts, author and quoted post", async () => {
    const fetcher = fakeFetch([["https://cdn.syndication.twimg.com/tweet-result", 200, fixture("syndication-openai.json")]]);
    const { post } = await createSyndicationProvider({ fetcher }).post!({ id: POST_ID, replies: false }, call);
    expect(post).toMatchObject({ id: POST_ID, author: "@OpenAI", authorName: "OpenAI", url: `https://x.com/OpenAI/status/${POST_ID}`, createdAt: "2026-11-20T22:00:53.000Z", likes: 1425, replies: 97 });
    expect(post.text).toContain("neurodegenerative");
    expect(post.quoted?.url).toBe("https://x.com/OpenAI/status/2112899854569762936");
    expect(String(fetcher.mock.calls[0]![0])).toContain(`token=${syndicationToken(POST_ID)}`);
  });

  it("says not found for a missing post or a tombstone, and fails on an outage", async () => {
    const missing = createSyndicationProvider({ fetcher: fakeFetch([]) });
    await expect(missing.post!({ id: "1", replies: false }, call)).rejects.toMatchObject({ code: "not_found" });
    const tomb = createSyndicationProvider({ fetcher: fakeFetch([["https://cdn", 200, JSON.stringify({ __typename: "TweetTombstone" })]]) });
    await expect(tomb.post!({ id: "1", replies: false }, call)).rejects.toMatchObject({ code: "not_found" });
    const down = createSyndicationProvider({ fetcher: fakeFetch([["https://cdn", 503, "busy"]]) });
    await expect(down.post!({ id: "1", replies: false }, call)).rejects.toMatchObject({ code: "unavailable" });
    const limited = createSyndicationProvider({ fetcher: fakeFetch([["https://cdn", 429, ""]]) });
    await expect(limited.post!({ id: "1", replies: false }, call)).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("leaves replies to routes that can read them", async () => {
    await expect(createSyndicationProvider({ fetcher: fakeFetch([]) }).post!({ id: "1", replies: true }, call)).rejects.toBeInstanceOf(XSkip);
  });
});

describe("oEmbed", () => {
  it("reads the author, text and day from the embed", async () => {
    const fetcher = fakeFetch([["https://publish.x.com/oembed", 200, fixture("oembed-openai.json")]]);
    const { post } = await createOembedProvider({ fetcher }).post!({ id: POST_ID, replies: false }, call);
    expect(post).toMatchObject({ id: POST_ID, author: "@OpenAI", authorName: "OpenAI", url: `https://x.com/OpenAI/status/${POST_ID}` });
    expect(post.text).toMatch(/^How AI is helping scientists/);
    expect(post.text).toContain("@perturbai_tx");
    expect(post.createdAt?.slice(0, 10)).toBe("2026-11-20");
    expect(post.likes).toBeUndefined();
  });

  it("decodes entities and finds the date link", () => {
    expect(readEmbed('<blockquote><p lang="en">a &amp; b&#39;s &mdash; <a href="x">#c</a></p>&mdash; Maus (@maus) <a href="https://x.com/maus/status/1">March 3, 2026</a></blockquote>'))
      .toEqual({ text: "a & b's — #c", day: "2026-03-03T00:00:00.000Z" });
  });

  it("says not found on a 404", async () => {
    await expect(createOembedProvider({ fetcher: fakeFetch([]) }).post!({ id: "1", replies: false }, call)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("x.com signed-out pages", () => {
  const pages = (path: string, status: number, html: string) => createXPageProvider({ fetcher: fakeFetch([[`https://x.com/${path}`, status, html]]) });

  it("finds the embedded answers", () => {
    expect(embeddedAnswers(fixture("xpage-profile-openai.html")).length).toBe(3);
  });

  it("reads an account", async () => {
    const profile = await pages("OpenAI", 200, fixture("xpage-profile-openai.html")).profile!("OpenAI", call);
    expect(profile).toMatchObject({ handle: "@OpenAI", name: "OpenAI", followers: 5556052, following: 4, posts: 2264, verified: true, website: "https://openai.com", url: "https://x.com/OpenAI" });
    expect(profile.createdAt).toBe(new Date(1449442268930).toISOString());
    expect(profile.bio).toContain("artificial general intelligence");
  });

  it("reads an account's latest posts newest first, saying there are more", async () => {
    const list = await pages("OpenAI", 200, fixture("xpage-profile-openai.html")).userPosts!({ handle: "OpenAI", limit: 20, includeReplies: false }, call);
    expect(list.posts.map((post) => post.id)).toEqual(["2123899406550528422", "2123862344422088794", "2123856316187975756", "2123191365983248653", "2123165872261075233"]);
    expect(list).toMatchObject({ newestId: "2123899406550528422", more: true });
    expect(list.posts[0]).toMatchObject({ author: "@OpenAI", likes: 1423, replies: 97, reposts: 123, quotes: 34, createdAt: "2026-11-20T22:00:53.000Z" });
  });

  it("answers a watch only when the page reaches back to the post it last saw", async () => {
    const provider = pages("OpenAI", 200, fixture("xpage-profile-openai.html"));
    const caughtUp = await provider.userPosts!({ handle: "OpenAI", limit: 20, includeReplies: false, sinceId: "2123856316187975756" }, call);
    expect(caughtUp).toMatchObject({ newestId: "2123899406550528422", more: false });
    expect(caughtUp.posts).toHaveLength(2);
    // every post newer than the last seen one: the gap may hold more, so another route must read it
    await expect(provider.userPosts!({ handle: "OpenAI", limit: 20, includeReplies: false, sinceId: "2000000000000000000" }, call)).rejects.toBeInstanceOf(XSkip);
    const nothingNew = await provider.userPosts!({ handle: "OpenAI", limit: 20, includeReplies: false, sinceId: "2123899406550528422" }, call);
    expect(nothingNew).toMatchObject({ more: false, posts: [] });
  });

  it("leaves replies-included timelines to routes that read them", async () => {
    await expect(pages("OpenAI", 200, fixture("xpage-profile-openai.html")).userPosts!({ handle: "OpenAI", limit: 5, includeReplies: true }, call)).rejects.toBeInstanceOf(XSkip);
  });

  it("reads a post and its first replies", async () => {
    const provider = pages(`OpenAI/status/${POST_ID}`, 200, fixture("xpage-post-openai.html"));
    const read = await provider.post!({ id: POST_ID, handle: "OpenAI", replies: true }, call);
    expect(read.post).toMatchObject({ id: POST_ID, author: "@OpenAI", likes: expect.any(Number) });
    expect(read.replies!.length).toBeGreaterThan(0);
    expect(read.replies!.every((reply) => reply.id !== POST_ID && BigInt(reply.id) > BigInt(POST_ID))).toBe(true);
    expect(read.moreReplies).toBe(true);
  });

  it("says a missing account is not found, and an unreadable page is an outage", async () => {
    await expect(pages("nobody_zz", 404, fixture("xpage-missing-user.html")).profile!("nobody_zz", call)).rejects.toMatchObject({ code: "not_found" });
    await expect(pages("OpenAI", 200, "<html>a new page shape</html>").profile!("OpenAI", call)).rejects.toMatchObject({ code: "unavailable" });
    await expect(pages("OpenAI", 302, "").profile!("OpenAI", call)).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("web search fallback", () => {
  const synd = fixture("syndication-openai.json");

  it("turns an X query into what a web index can take", () => {
    expect(webQuery('from:OpenAI "gpt 6" since:2026-11-01 min_faves:10 -filter:replies lang:en')).toEqual({ text: '"gpt 6"', handle: "OpenAI" });
    expect(webQuery("claude code OR codex")).toEqual({ text: "claude code OR codex" });
  });

  it("finds status links once each, skipping X's own pages", () => {
    expect(statusLinks(fixture("brave-from-openai.html")).map((link) => link.id)).toEqual(["2123899406550528422", "2123862344422088794", "2100000000000000001"]);
  });

  it("searches the free index through treg when a credential is held, and reads each post", async () => {
    const research = { call: vi.fn(async () => ({ result: JSON.parse(fixture("tinyfish-claude-code.json")) })) } as unknown as ResearchClient;
    const fetcher = fakeFetch([["https://cdn.syndication.twimg.com", 200, synd]]);
    const provider = createWebSearchProvider({ fetcher, research: () => research });
    const list = await provider.search!({ query: "claude code", sort: "latest", limit: 10 }, { ...call, credential });
    expect(research.call).toHaveBeenCalledWith({ id: "tinyfish.web.search", params: { query: "claude code", domain_type: "web", include_domains: "x.com" } });
    expect(list.freshness).toBe("days");
    expect(list.note).toMatch(/Older posts only/);
    expect(list.newestId).toBeUndefined();
    expect(list.posts.length).toBeGreaterThan(0);
  });

  it("uses Brave's page without a credential, keeps from: to that account, and calls a captcha a rate limit", async () => {
    const fetcher = fakeFetch([["https://search.brave.com", 200, fixture("brave-from-openai.html")], ["https://cdn.syndication.twimg.com", 200, synd]]);
    const list = await createWebSearchProvider({ fetcher }).search!({ query: "from:OpenAI science", sort: "top", limit: 10 }, call);
    expect(list.posts.every((post) => post.author === "@OpenAI")).toBe(true);
    const walled = createWebSearchProvider({ fetcher: fakeFetch([["https://search.brave.com", 200, "<html>Please solve this CAPTCHA</html>"]]) });
    await expect(walled.search!({ query: "x", sort: "top", limit: 5 }, call)).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("uses dusk's keyless index for a signed-in account with no key of its own, before Brave", async () => {
    const fetcher = fakeFetch([["https://account.test/api/cloud/x-index", 200, JSON.stringify({ results: [{ url: "https://x.com/OpenAI/status/2123899406550528422" }] })], ["https://cdn.syndication.twimg.com", 200, synd]]);
    const provider = createWebSearchProvider({ fetcher, index: () => ({ kind: "desktop", url: "https://account.test/api/cloud/x-index", token: `dusk_xi_${"a".repeat(43)}` }) });
    const list = await provider.search!({ query: "openai", sort: "latest", limit: 5 }, call);
    expect(list).toMatchObject({ freshness: "days", posts: [{ id: POST_ID }] });
    expect(fetcher.mock.calls.map(([url]) => String(url)).some((url) => url.includes("brave"))).toBe(false);
    const [, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(init.headers).toMatchObject({ authorization: `Bearer dusk_xi_${"a".repeat(43)}` });
  });

  it("falls to Brave when the index's day is used up", async () => {
    const fetcher = fakeFetch([["https://account.test/api/cloud/x-index", 429, "{}"], ["https://search.brave.com", 200, fixture("brave-from-openai.html")], ["https://cdn.syndication.twimg.com", 200, synd]]);
    const provider = createWebSearchProvider({ fetcher, index: () => ({ kind: "desktop", url: "https://account.test/api/cloud/x-index", token: `dusk_xi_${"a".repeat(43)}` }) });
    expect((await provider.search!({ query: "openai", sort: "latest", limit: 5 }, call)).posts.length).toBeGreaterThan(0);
  });

  it("is never used for a watch", async () => {
    await expect(createWebSearchProvider({ fetcher: fakeFetch([]) }).search!({ query: "x", sort: "latest", limit: 5, sinceId: "5" }, call)).rejects.toBeInstanceOf(XSkip);
  });

  it("fails rather than answering empty when the index can't be reached", async () => {
    await expect(createWebSearchProvider({ fetcher: fakeFetch([["https://search.brave.com", 503, ""]]) }).search!({ query: "x", sort: "latest", limit: 5 }, call))
      .rejects.toBeInstanceOf(XResearchError);
  });
});
