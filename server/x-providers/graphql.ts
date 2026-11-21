// X's own GraphQL answers, as x.com's pages fetch them (SearchTimeline, UserTweets, TweetDetail, UserByScreenName) and
// as its logged-out pages embed them: timelines of entries holding `tweet_results`, and users in two shapes (`legacy`
// counts, or 2026's `core` / `relationship_counts` / `tweet_counts`).
import { at, firstCount, firstText, isRow, timeOf, toPost, type XPost, type XProfile } from "../x-research.ts";

type Row = Record<string, unknown>;

/** The posts in a timeline's entries, in order, each once. A pinned post (it sits on top whatever its age) and promoted
 * posts are left out. */
export function timelinePosts(timeline: unknown, knownHandle?: string): XPost[] {
  const instructions = at(timeline, "instructions");
  if (!Array.isArray(instructions)) return [];
  const posts: XPost[] = [];
  const seen = new Set<string>();
  for (const instruction of instructions) {
    if (!isRow(instruction) || instruction.type === "TimelinePinEntry" || instruction.__typename === "TimelinePinEntry") continue;
    const entries = Array.isArray(instruction.entries) ? instruction.entries : [];
    for (const entry of entries) {
      if (!isRow(entry) || (typeof entry.entryId === "string" && /^promoted/i.test(entry.entryId))) continue;
      for (const raw of tweetResults(entry.content)) {
        const post = toPost(raw, knownHandle);
        if (post && !seen.has(post.id)) {
          seen.add(post.id);
          posts.push(post);
        }
      }
    }
  }
  return posts;
}

/** Every `tweet_results.result` under a value, depth first; a promoted item inside a module is left out. */
function tweetResults(value: unknown, depth = 0): Row[] {
  if (depth > 12) return [];
  if (Array.isArray(value)) return value.flatMap((item) => tweetResults(item, depth + 1));
  if (!isRow(value)) return [];
  if (isRow(value.promotedMetadata) || isRow(value.promoted_metadata)) return [];
  const result = at(value, "tweet_results", "result");
  if (isRow(result)) return [result];
  return Object.values(value).flatMap((child) => tweetResults(child, depth + 1));
}

/** The first timeline under an answer's `data`, wherever X nests it this month. */
export function findTimeline(data: unknown, depth = 0): unknown {
  if (depth > 8 || !isRow(data)) return undefined;
  if (Array.isArray(data.instructions)) return data;
  for (const child of Object.values(data)) {
    const found = findTimeline(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** A user as either shape; null without a handle. */
export function toProfile(user: unknown): XProfile | null {
  if (!isRow(user)) return null;
  const legacy = isRow(user.legacy) ? user.legacy : {};
  const handle = firstText(at(user, "core", "screen_name"), legacy.screen_name)?.replace(/^@/, "");
  if (!handle) return null;
  const website = firstText(firstUrl(at(user, "profile_bio", "entities", "url", "urls")), firstUrl(at(legacy, "entities", "url", "urls")));
  const verified = at(user, "verification", "is_blue_verified") ?? user.is_blue_verified ?? legacy.verified;
  return {
    handle: `@${handle}`,
    name: firstText(at(user, "core", "name"), legacy.name),
    bio: firstText(at(user, "profile_bio", "description"), legacy.description),
    location: firstText(at(user, "location", "location"), legacy.location),
    website,
    followers: firstCount(at(user, "relationship_counts", "followers"), legacy.followers_count),
    following: firstCount(at(user, "relationship_counts", "following"), legacy.friends_count),
    posts: firstCount(at(user, "tweet_counts", "tweets"), legacy.statuses_count),
    verified: typeof verified === "boolean" ? verified : undefined,
    createdAt: timeOf(at(user, "core", "created_at_ms") ?? at(user, "core", "created_at") ?? legacy.created_at),
    url: `https://x.com/${handle}`,
  };
}

function firstUrl(urls: unknown): string | undefined {
  return Array.isArray(urls) ? firstText(...urls.map((row) => at(row, "expanded_url"))) : undefined;
}
