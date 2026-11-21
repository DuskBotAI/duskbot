// The agents catalog's X and research tools and the internal route behind each. x_search reads X through free routes
// first (server/x-providers), so every bot whose research switch is on is shown it; the research tools are paid, from the
// person's own treg balance or their Cloud plan's allowance, so they are shown only when research works for a held
// credential (a plan's relay can have X without research); each route checks again before it spends.
import { agentsCallMember } from "../../shared/agents-tool-names.ts";
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

/** Each call's route, by the member name it goes by (x_search's actions are its members). */
const RESEARCH_ROUTES: Readonly<Record<string, string>> = {
  x_search: "x/search", x_user_posts: "x/user-posts", x_post: "x/post", x_profile: "x/profile",
  research_search: "research/search", research_endpoint: "research/endpoint", research_call: "research/call",
  web_search_many: "research/web-search-many",
};
export const RESEARCH_TOOL_NAMES: ReadonlySet<string> = new Set(["x_search", "research_search", "research_endpoint", "research_call", "web_search_many"]);
/** The ones that need only X: shown without research. */
export const X_TOOL_NAMES: ReadonlySet<string> = new Set(["x_search"]);

/** What each X read cannot go without, said before anything is spent. */
const X_NEEDS: Readonly<Record<string, string>> = { x_search: "query", x_user_posts: "handle", x_post: "post", x_profile: "handle" };
const X_ACTIONS = new Set(["search", "user_posts", "post", "profile"]);

export async function callResearchTool(name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const member = agentsCallMember(name, args);
  const { action, ...rest } = args;
  const input = name === "x_search" ? rest : args;
  if (name === "x_search") {
    if (action !== undefined && action !== null && !X_ACTIONS.has(String(action))) return { text: "x_search action is search (the default), user_posts, post or profile.", isError: true };
    const needed = X_NEEDS[member]!;
    const value = input[needed];
    if (typeof value !== "string" || !value.trim()) return { text: `x_search ${member === "x_search" ? "search" : String(action)} needs ${needed}.`, isError: true };
  }
  const { ok, body } = await context.client.apiResponse(`/api/internal/${RESEARCH_ROUTES[member]}`, { method: "POST", body: JSON.stringify(input) });
  if (ok && name === "web_search_many" && typeof body.message === "string") return { text: body.message };
  if (ok && name === "web_search_many" && Array.isArray(body.results)) return searchResultsText(body.results);
  return ok ? { text: JSON.stringify(body) } : { text: String(body.error ?? "Research failed. Try again shortly."), isError: true };
}

const pageKey = (url: string) => url.replace(/^https?:\/\/(?:www\.)?/i, "").replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();

/** A batch's answers as short numbered lines, each page once: a page that answers several queries is listed under the
 * first and named by number after it. */
export function searchResultsText(answers: readonly unknown[]): ToolCallResult {
  const seen = new Map<string, number>();
  const lines: string[] = [];
  let failed = 0;
  let found = 0;
  for (const answer of answers) {
    if (!answer || typeof answer !== "object") continue;
    const { query, results, error, cost, cached } = answer as Json;
    lines.push(`## ${String(query ?? "")}${cached ? " (reused from a search minutes ago, no charge)" : typeof cost === "string" ? ` (${cost})` : ""}`);
    if (typeof error === "string") { failed += 1; lines.push(`Failed: ${error}`); continue; }
    const rows = Array.isArray(results) ? results.filter((row): row is Json => Boolean(row) && typeof row === "object") : [];
    if (!rows.length) lines.push("No results.");
    const again: number[] = [];
    for (const row of rows) {
      const url = String(row.url ?? "");
      const earlier = seen.get(pageKey(url));
      if (earlier !== undefined) { again.push(earlier); continue; }
      seen.set(pageKey(url), (found += 1));
      const snippet = String(row.snippet ?? "").replace(/\s+/g, " ").trim();
      lines.push(`${found}. ${String(row.title ?? "").trim() || url}\n   ${url}${snippet ? `\n   ${snippet}` : ""}`);
    }
    if (again.length) lines.push(`Also here: ${again.map((index) => `#${index}`).join(", ")} above.`);
  }
  if (failed === answers.length) return { text: lines.join("\n"), isError: true };
  return { text: lines.join("\n") };
}

export const RESEARCH_TOOL_DEFINITIONS = [
  {
    name: "web_search_many",
    description: "Search the web for 1 to 10 independent queries concurrently in one call. Prefer this for 2 or more searches. Returns up to 5 top results per query, each with title, url and snippet; a page found by several queries is listed once. Uses Perplexity Fast Search through treg, billed to the user's treg balance or Cloud research allowance; reports cost when available. The same query again within 20 minutes reuses its results at no charge. A failed query does not discard the others.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { queries: { type: "array", minItems: 1, maxItems: 10, items: { type: "string", minLength: 1, maxLength: 512 }, description: "1 to 10 independent web search queries, at most 512 characters each." } },
      required: ["queries"],
    },
  },
  {
    name: "x_search",
    description:
      "Read X (Twitter), read-only: you cannot post, like or reply. search (the default) finds posts; write one well-filtered query instead of many broad ones. The query takes X operators: from:handle, to:handle, \"exact phrase\", since:YYYY-MM-DD, until:YYYY-MM-DD (both about a day loose), min_faves:N, -filter:replies, lang:en, OR. Bare words are all required, so use a short phrase or OR between alternatives. user_posts reads an account's recent posts, newest first. Both return compact posts (link, author, time, text, likes, reposts, replies, quotes, views) and newestId: to watch X, for example in a routine, keep newestId and pass it back as sinceId next time to get only newer posts; when a call fails, keep the sinceId you had, and the next call catches up. Live search needs the person's own x.com sign-in in your browser (dusk bot asks them once) or a treg key or plan; without one, search answers with freshness \"days\": older posts from a web search index, never complete, so say so and do not watch with it. user_posts without that reads only an account's latest few posts. A note in an answer is for you to follow or pass on. When X can't be reached the error is one sentence with an Open on X link: give the person both. post reads one post, and with replies the first replies to it. profile looks up an account: name, bio, followers, following, post count and verified status.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["search", "user_posts", "post", "profile"], description: "search (default), user_posts, post or profile." },
        query: { type: "string", minLength: 1, maxLength: 512, description: "search: the X search query; operators allowed." },
        sort: { type: "string", enum: ["latest", "top"], description: "search: latest (default) or top." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "search and user_posts: how many posts, 1-50. Default 20." },
        sinceId: { type: "string", pattern: "^\\d{1,25}$", description: "search and user_posts: only posts newer than this post id, a newestId from an earlier call." },
        handle: { type: "string", minLength: 1, description: "user_posts and profile: the account: @handle, handle, or an x.com profile link." },
        includeReplies: { type: "boolean", description: "user_posts: include the account's replies to others. Default false." },
        post: { type: "string", minLength: 1, description: "post: an x.com or twitter.com post link, or the post id." },
        replies: { type: "boolean", description: "post: also return replies to the post. Default false." },
      },
    },
  },
  {
    name: "research_search",
    description:
      "Find a research endpoint for a job in treg's catalog: companies, people and work emails, funding, news, social and trend data, SEO, search results, scraping, generation and more. Describe the job, not a vendor. Returns endpoints with their params, an example and the estimated cost; then call one with research_call. Searching is free.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        job: { type: "string", minLength: 1, maxLength: 300, description: "What the research is for, such as \"work email of a person at a company\"." },
        limit: { type: "integer", minimum: 1, maximum: 10, description: "How many endpoints, 1-10. Default 5." },
      },
      required: ["job"],
    },
  },
  {
    name: "research_endpoint",
    description: "Read one research endpoint in full: its params, an example, its cost and how to check on an async task.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string", minLength: 1, maxLength: 200, description: "An endpoint id from research_search." } },
      required: ["id"],
    },
  },
  {
    name: "research_call",
    description:
      "Call a research endpoint by id and get the provider's answer and what it cost (a paid call). params are its query parameters for a GET endpoint, otherwise its JSON body; query adds a query string to a body endpoint. Follow the endpoint's params and example. An async task answers with how to check on it: call that with research_call.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", minLength: 1, maxLength: 200, description: "The endpoint id." },
        params: { type: "object", additionalProperties: true, description: "The endpoint's parameters." },
        query: { type: "object", additionalProperties: true, description: "Query string for an endpoint that takes a JSON body." },
      },
      required: ["id"],
    },
  },
];
