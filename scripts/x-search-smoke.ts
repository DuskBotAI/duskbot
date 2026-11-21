// Live check of x_search's free routes: three asks per route against X itself, printed as one line each.
//   node scripts/x-search-smoke.ts
// The web index through treg runs too when DUSK_SMOKE_TREG_KEY holds a treg key (free endpoint; never printed), or,
// with DUSK_SMOKE_TREG_CLI=1, through the logged-in `treg` CLI (the key stays inside the CLI).
// No X account is used: the person's sign-in route needs a real login and is covered by its fixture tests.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createXIndexRoutes } from "../apps/dashboard/server/x-index/routes.ts";
import { createXIndexService, type XIndexResult } from "../apps/dashboard/server/x-index/service.ts";
import type { ServiceCredential } from "../server/included-services.ts";
import { createResearchClient, type ResearchClient } from "../server/research.ts";
import { createOembedProvider } from "../server/x-providers/oembed.ts";
import { createSyndicationProvider } from "../server/x-providers/syndication.ts";
import { XSkip, type XCall } from "../server/x-providers/types.ts";
import { createWebSearchProvider } from "../server/x-providers/websearch.ts";
import { createXPageProvider } from "../server/x-providers/xpage.ts";
import { createXRouter } from "../server/x-providers/index.ts";

const POSTS = ["2123899406550528422", "2123852660688494744", "2123820070803542306"];
const HANDLES = ["OpenAI", "nasa", "sama"];
const QUERIES = ["claude code", "from:OpenAI gpt", "tesla robotaxi"];
const call: XCall = { botId: "smoke", credential: null };
const viaCli = process.env.DUSK_SMOKE_TREG_CLI === "1";
const treg: ServiceCredential | null = process.env.DUSK_SMOKE_TREG_KEY ? { token: process.env.DUSK_SMOKE_TREG_KEY, api: "https://treg.to", included: false }
  : viaCli ? { token: "cli", api: "https://treg.to", included: false } : null;
/** The same free call through the treg CLI's own login. */
const cliResearch = {
  call: async (input: { id: string; params?: Record<string, unknown> }) => {
    const args = ["call", input.id, ...Object.entries(input.params ?? {}).flatMap(([key, value]) => ["-p", `${key}=${String(value)}`])];
    const out = execFileSync("treg", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 });
    return { result: JSON.parse(out.slice(out.indexOf("{"))) };
  },
} as unknown as ResearchClient;
const researchFor = (credential: ServiceCredential) => (viaCli && !process.env.DUSK_SMOKE_TREG_KEY ? cliResearch : createResearchClient(credential));

type Row = { route: string; ask: string; ok: boolean; ms: number; what: string };
const rows: Row[] = [];

async function check(route: string, ask: string, run: () => Promise<string>): Promise<void> {
  const started = performance.now();
  try {
    const what = await run();
    rows.push({ route, ask, ok: true, ms: Math.round(performance.now() - started), what });
  } catch (error) {
    const what = error instanceof XSkip ? `skipped (${error.reason})` : error instanceof Error ? `${(error as { code?: string }).code ?? "error"}: ${error.message.slice(0, 90)}` : String(error);
    rows.push({ route, ask, ok: false, ms: Math.round(performance.now() - started), what });
  }
}

const newest = (posts: Array<{ createdAt?: string }>) => posts.map((post) => post.createdAt ?? "").sort().at(-1)?.slice(0, 10) ?? "-";
const syndication = createSyndicationProvider();
const oembed = createOembedProvider();
const xpage = createXPageProvider();
const web = createWebSearchProvider({ research: researchFor });
const router = createXRouter({ research: researchFor });

for (const id of POSTS) await check("syndication post", id, async () => { const { post } = await syndication.post!({ id, replies: false }, call); return `${post.author} ${post.createdAt?.slice(0, 10)} likes=${post.likes}`; });
for (const id of POSTS) await check("oembed post", id, async () => { const { post } = await oembed.post!({ id, replies: false }, call); return `${post.author} ${post.createdAt?.slice(0, 10)} ${post.text.length} chars`; });
for (const handle of HANDLES) await check("x.com profile", handle, async () => { const p = await xpage.profile!(handle, call); return `${p.handle} followers=${p.followers} posts=${p.posts}`; });
for (const handle of HANDLES) await check("x.com user_posts", handle, async () => { const list = await xpage.userPosts!({ handle, limit: 20, includeReplies: false }, call); return `${list.posts.length} posts, newest ${newest(list.posts)}`; });
for (const id of POSTS) await check("x.com post+replies", id, async () => { const read = await xpage.post!({ id, replies: true }, call); return `${read.post.author}, ${read.replies?.length ?? 0} replies`; });
for (const query of QUERIES) await check("web index (Brave)", query, async () => { const list = await web.search!({ query, sort: "latest", limit: 10 }, call); return `${list.posts.length} posts, newest ${newest(list.posts)}`; });
if (treg) for (const query of QUERIES) await check("web index (treg TinyFish)", query, async () => { const list = await web.search!({ query, sort: "latest", limit: 10 }, { ...call, credential: treg }); return `${list.posts.length} posts, newest ${newest(list.posts)}`; });
for (const query of QUERIES) await check("router search, no key", query, async () => { const list = await router.client(call).search({ query, sort: "latest", limit: 10 }); return `${list.posts.length} posts${list.freshness ? ` (${list.freshness})` : ""}, newest ${newest(list.posts)}`; });
if (treg) for (const query of QUERIES) await check("router search, treg index", query, async () => { const list = await router.client({ ...call, credential: treg }).search({ query, sort: "top", limit: 10 }); return `${list.posts.length} posts${list.freshness ? ` (${list.freshness})` : ""}, newest ${newest(list.posts)}`; });
if (viaCli) {
  // The account service's keyless index on loopback, its TinyFish search live through the treg CLI; the router reaches
  // it as a signed-in desktop with no key of its own.
  const dir = mkdtempSync(join(tmpdir(), "x-index-smoke-"));
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const service = createXIndexService({
    dataDir: dir, clouds: { get: () => null }, unseal: (value) => value, publicUrl: base,
    search: async (query) => ((await cliResearch.call({ id: "tinyfish.web.search", params: { query, domain_type: "web", include_domains: "x.com" } })).result as { results: XIndexResult[] }).results,
  });
  const routes = createXIndexRoutes(service, () => ({ id: "smoke-account", email: "smoke@test-mail.invalid" }));
  server.on("request", (req, res) => { void routes.handle(req, res, new URL(req.url ?? "/", base)); });
  const access = service.issue("smoke-account");
  const keyless = createXRouter({ index: () => ({ kind: "desktop", ...access }) });
  for (const query of QUERIES) await check("router search, keyless index", query, async () => { const list = await keyless.client(call).search({ query, sort: "latest", limit: 10 }); return `${list.posts.length} posts${list.freshness ? ` (${list.freshness})` : ""}, newest ${newest(list.posts)}`; });
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}
for (const handle of HANDLES) await check("router user_posts, no key", handle, async () => { const list = await router.client(call).userPosts({ handle, limit: 10, includeReplies: false }); return `${list.posts.length} posts, newest ${newest(list.posts)}`; });

const width = Math.max(...rows.map((row) => row.route.length));
for (const row of rows) console.log(`${row.ok ? "ok  " : "FAIL"} ${row.route.padEnd(width)}  ${row.ask.padEnd(20)} ${String(row.ms).padStart(6)} ms  ${row.what}`);
const byRoute = new Map<string, { ok: number; all: number }>();
for (const row of rows) { const seen = byRoute.get(row.route) ?? { ok: 0, all: 0 }; seen.all++; if (row.ok) seen.ok++; byRoute.set(row.route, seen); }
console.log("");
for (const [route, seen] of byRoute) console.log(`${route.padEnd(width)}  ${seen.ok}/${seen.all}`);
