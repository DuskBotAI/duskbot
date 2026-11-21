// Search without a live X route: a web search limited to x.com finds post links, and each post is read through X's
// embed backend. Search indexes lag X by days and see only part of it, so the answer is labelled `freshness: "days"`
// and is never used for a watch (an ask with sinceId). The index, first that answers: TinyFish through treg on the
// person's own research credential (listed free, so no paid provider is walked to); dusk's keyless X index for any
// signed-in dusk account (x-index.ts); Brave's public results page, which often answers a server with a captcha.
import type { ResearchClient } from "../research.ts";
import type { ServiceCredential } from "../included-services.ts";
import { postList, X_MESSAGES, XResearchError, type XPostList } from "../x-research.ts";
import { httpGet, rateLimited, unavailable, type HttpOptions } from "./http.ts";
import { syndicationPosts } from "./syndication.ts";
import { searchXIndex, type XIndexAccess } from "./x-index.ts";
import { XSkip, type SearchInput, type XCall, type XProvider } from "./types.ts";

export const TINYFISH_SEARCH = "tinyfish.web.search";
export const BRAVE_SEARCH_URL = "https://search.brave.com/search";
const STATUS_LINK = /https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{8,25})/g;
const MAX_POSTS_READ = 12;
const OPERATOR = /(^|\s)-?[a-z_]+:\S+/gi;

/** What a web index can take from an X query: its words and phrases, and the account a `from:` names. X's other
 * operators (since:, min_faves:, lang:, filter:, …) have no meaning there and are dropped. */
export function webQuery(query: string): { text: string; handle?: string } {
  const handle = /(?:^|\s)from:@?([A-Za-z0-9_]{1,15})\b/i.exec(query)?.[1];
  const text = query.replace(OPERATOR, " ").replace(/\(\s*\)/g, " ").replace(/\s+/g, " ").trim();
  return { text, ...(handle ? { handle } : {}) };
}

/** Post ids in the order the index ranked them, with the handle each link named. */
export function statusLinks(text: string): Array<{ id: string; handle: string }> {
  const seen = new Set<string>();
  const links: Array<{ id: string; handle: string }> = [];
  for (const match of text.matchAll(STATUS_LINK)) {
    const [, handle, id] = match;
    if (!seen.has(id!) && !/^(?:i|search|home)$/i.test(handle!)) {
      seen.add(id!);
      links.push({ id: id!, handle: handle! });
    }
  }
  return links;
}

export interface WebSearchOptions extends HttpOptions {
  research?: (credential: ServiceCredential) => ResearchClient;
  /** dusk's keyless X index for this server's dusk account, when it is signed in to one. */
  index?: () => XIndexAccess | null;
}

export function createWebSearchProvider(options: WebSearchOptions = {}): XProvider {
  async function tinyfish(credential: ServiceCredential, words: string): Promise<string> {
    if (!options.research) throw unavailable();
    const answer = await options.research(credential).call({ id: TINYFISH_SEARCH, params: { query: words, domain_type: "web", include_domains: "x.com" } });
    if (answer.upstreamFailed) throw unavailable();
    return typeof answer.result === "string" ? answer.result : JSON.stringify(answer.result ?? "");
  }

  async function brave(words: string): Promise<string> {
    const answer = await httpGet(`${BRAVE_SEARCH_URL}?q=${encodeURIComponent(`site:x.com ${words}`)}&source=web`, { ...options, headers: { accept: "text/html" } });
    if (answer.status === 403) throw rateLimited();
    if (answer.status !== 200) throw unavailable();
    // Brave answers a client it suspects with a 200 page holding a captcha.
    if (statusLinks(answer.text).length === 0 && /captcha/i.test(answer.text)) throw rateLimited();
    return answer.text;
  }

  return {
    id: "websearch",
    emptyIsAnswer: false,
    async search(input: SearchInput, call: XCall): Promise<XPostList> {
      if (input.sinceId !== undefined) throw new XSkip("not_for_this");
      const { text, handle } = webQuery(input.query);
      const words = [handle ? `from ${handle}` : "", text].filter(Boolean).join(" ");
      if (!words) throw new XSkip("not_for_this");
      let found: string | null = null;
      let failure: unknown = null;
      const sources: Array<() => Promise<string>> = [];
      if (call.credential) sources.push(() => tinyfish(call.credential!, words));
      const index = options.index?.();
      if (index) sources.push(() => searchXIndex(index, words, options));
      sources.push(() => brave(words));
      for (const source of sources) {
        const answer = await source().catch((error: unknown) => { failure = error; return null; });
        if (answer !== null) found = answer;
        if (found !== null && statusLinks(found).length > 0) break;
      }
      if (found === null) throw failure instanceof XResearchError ? failure : unavailable();
      const links = statusLinks(found).filter((link) => !handle || link.handle.toLowerCase() === handle.toLowerCase()).slice(0, MAX_POSTS_READ);
      const posts = await syndicationPosts(links.map((link) => link.id), options);
      const kept = handle ? posts.filter((post) => post.author.toLowerCase() === `@${handle.toLowerCase()}`) : posts;
      if (input.sort === "latest") kept.sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
      return postList(kept, { limit: input.limit, freshness: "days", note: X_MESSAGES.olderOnly });
    },
  };
}
