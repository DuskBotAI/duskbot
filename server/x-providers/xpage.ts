// x.com's own pages as a signed-out visitor gets them: an account's page carries the account and its latest few posts
// of its own (no replies, no reposts), and a post's page carries the post and its first few replies. The page embeds
// the GraphQL answers it was rendered from as JSON text (`kind:"Result.Ok",value:"…"`, measured 2026-11-21); search
// is not served signed out.
import { X_MESSAGES, XResearchError, at, postList, withReplies, type XPostList, type XPostWithReplies, type XProfile } from "../x-research.ts";
import { timelinePosts, toProfile } from "./graphql.ts";
import { httpGet, unavailable, type HttpOptions } from "./http.ts";
import { XSkip, type PostInput, type UserPostsInput, type XProvider } from "./types.ts";

const EMBEDDED = /kind:"Result\.Ok",value:"((?:[^"\\]|\\.)*)"/g;

/** The GraphQL answers a page was rendered from, in page order. */
export function embeddedAnswers(html: string): unknown[] {
  const answers: unknown[] = [];
  for (const match of html.matchAll(EMBEDDED)) {
    try {
      answers.push(JSON.parse(JSON.parse(`"${match[1]}"`) as string));
    } catch {
      // one malformed answer leaves the others readable
    }
  }
  return answers;
}

/** `follow`: x.com/i/status/<id> redirects to the author's own post page. */
async function page(path: string, options: HttpOptions, follow = false): Promise<{ status: number; answers: unknown[] }> {
  const answer = await httpGet(`https://x.com/${path}`, { ...options, headers: { accept: "text/html" }, follow });
  if (answer.status >= 300 && answer.status < 400) throw unavailable();
  if (follow && !/^https:\/\/(?:www\.)?x\.com\//.test(answer.url)) throw unavailable();
  const answers = embeddedAnswers(answer.text);
  if (answer.status === 200 && answers.length === 0) throw unavailable();
  return { status: answer.status, answers };
}

const userOf = (answers: unknown[]) => answers.map((answer) => at(answer, "data", "user_result_by_screen_name", "result"));

export function createXPageProvider(options: HttpOptions = {}): XProvider {
  return {
    id: "xpage",
    emptyIsAnswer: true,
    async profile(handle: string): Promise<XProfile> {
      const { status, answers } = await page(handle, options);
      // Fuller answers come later on the page, so the last one that reads wins.
      const profile = userOf(answers).map(toProfile).filter((one) => one !== null).at(-1);
      if (!profile) {
        if (status === 404 || status === 200) throw new XResearchError("not_found", X_MESSAGES.accountNotFound(handle));
        throw unavailable();
      }
      return profile;
    },
    async userPosts(input: UserPostsInput): Promise<XPostList> {
      if (input.includeReplies) throw new XSkip("not_for_this");
      const { status, answers } = await page(input.handle, options);
      const timeline = userOf(answers).map((user) => at(user, "profile_user_originals_timeline", "timeline")).find((one) => one !== undefined);
      if (!timeline) {
        if (status === 404) throw new XResearchError("not_found", X_MESSAGES.accountNotFound(input.handle));
        throw unavailable();
      }
      const posts = timelinePosts(timeline, input.handle).sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
      // The page shows only the latest few, so a watch is answered only when they reach back to the post it last saw;
      // otherwise there may be posts between, and the next route must read them.
      if (input.sinceId !== undefined && !posts.some((post) => BigInt(post.id) <= BigInt(input.sinceId!))) {
        if (posts.length > 0) throw new XSkip("not_for_this");
      }
      return postList(posts, { limit: input.limit, sinceId: input.sinceId, more: input.sinceId === undefined && posts.length > 0 });
    },
    async post(input: PostInput): Promise<XPostWithReplies> {
      const { status, answers } = await page(`${input.handle ?? "i"}/status/${input.id}`, options, input.handle === undefined);
      const focal = answers.map((answer) => at(answer, "data", "tweet_result_by_rest_id", "result")).find((one) => one !== undefined);
      const posts = timelinePosts(focal === undefined ? undefined : { instructions: [{ entries: [{ content: { tweet_results: { result: focal } } }] }] });
      const post = posts.find((one) => one.id === input.id);
      if (!post) {
        if (status === 404 || status === 200) throw new XResearchError("not_found", X_MESSAGES.postNotFound);
        throw unavailable();
      }
      if (!input.replies) return { post };
      const thread = answers.map((answer) => at(answer, "data", "threaded_conversation_with_injections_v2")).find((one) => one !== undefined);
      const replies = timelinePosts(thread).filter((one) => one.id !== input.id && BigInt(one.id) > BigInt(input.id));
      return withReplies(post, replies, true);
    },
  };
}
