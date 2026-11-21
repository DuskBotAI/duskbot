// One post by id through X's embed backend (cdn.syndication.twimg.com/tweet-result), which every embedded post on the
// web loads: text, time, likes, reply count, author and the quoted post, with no sign-in. Its `token` is derived from
// the id the way X's embed script does (as in vercel/react-tweet, MIT); a wrong one is refused.
import { isRow, toPost, X_MESSAGES, XResearchError, type XPost, type XPostWithReplies } from "../x-research.ts";
import { httpGet, parseJson, type HttpOptions } from "./http.ts";
import { XSkip, type PostInput, type XProvider } from "./types.ts";

export const SYNDICATION_URL = "https://cdn.syndication.twimg.com/tweet-result";

export function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(6 ** 2).replace(/(0+|\.)/g, "");
}

/** The post, or null when X has no such post (deleted, private or withheld: an empty answer or a tombstone). */
export async function syndicationPost(id: string, options: HttpOptions = {}): Promise<XPost | null> {
  const answer = await httpGet(`${SYNDICATION_URL}?id=${id}&token=${syndicationToken(id)}&lang=en`, { ...options, headers: { accept: "application/json" } });
  if (answer.status === 404) return null;
  if (answer.status !== 200) throw new XResearchError("unavailable", X_MESSAGES.unavailable);
  if (!answer.text.trim()) return null;
  const body = parseJson(answer.text);
  if (!isRow(body) || body.__typename === "TweetTombstone") return null;
  return toPost(body);
}

/** Posts by id, a few at a time; a post that could not be read is left out. */
export async function syndicationPosts(ids: readonly string[], options: HttpOptions & { concurrency?: number } = {}): Promise<XPost[]> {
  const found: Array<XPost | null> = Array.from({ length: ids.length }, () => null);
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < ids.length; index = next++) found[index] = await syndicationPost(ids[index]!, options).catch(() => null);
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 5, ids.length) }, worker));
  return found.filter((post): post is XPost => post !== null);
}

export function createSyndicationProvider(options: HttpOptions = {}): XProvider {
  return {
    id: "syndication",
    emptyIsAnswer: false,
    async post(input: PostInput): Promise<XPostWithReplies> {
      if (input.replies) throw new XSkip("not_for_this");
      const post = await syndicationPost(input.id, options);
      if (!post) throw new XResearchError("not_found", X_MESSAGES.postNotFound);
      return { post };
    },
  };
}
