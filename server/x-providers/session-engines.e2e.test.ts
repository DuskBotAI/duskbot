// The X sign-in route on both browser engines, against a stand-in x.com search page that fetches a recorded
// SearchTimeline answer the way x.com's app does: dusk bot's own Chrome engine (BrowserService.readResponses) and
// agent-browser's Chrome over its DevTools socket. No X account and no real x.com is used.
// Runs with DUSK_CDP_E2E=1 (or DUSK_CDP_CHROME); the agent-browser half also needs agent-browser (DUSK_AGENT_BROWSER_PATH).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { agentBrowserIntegration, browserEngineStatus, closeBrowserSession } from "../browser-engine.ts";
import { browserRuntimeEnv } from "../browser-runtime.ts";
import { FixtureServer } from "../browser/cdp/testing/fixtures.ts";
import { CHROME } from "../browser/cdp/testing/real-chrome.ts";
import { startService, type RealService } from "../browser/testing/real-service.ts";
import { hostTimeout } from "../testing/host-timeout.ts";
import { readOnAgentBrowser } from "./cdp-read.ts";
import { createSessionProvider, graphqlOp, XAccountStore, type XSessionBrowser } from "./session.ts";

const SEARCH = readFileSync(join(import.meta.dirname, "fixtures", "session-search-timeline.json"), "utf8");
const EXPECTED = ["2123900000000000001", "2123899406550528422", "2123862344422088794", "2123856316187975756"];
const engine = browserEngineStatus();
if (engine.kind !== "ready") console.log(`skipping the agent-browser half: ${engine.reason}`);
const suite = CHROME ? describe : describe.skip;

suite("X sign-in route on both browser engines", () => {
  let fx: FixtureServer;
  let origin: string;
  const dirs: string[] = [];

  beforeAll(async () => {
    fx = await FixtureServer.start();
    fx.route("/i/api/graphql/q1/SearchTimeline", { body: SEARCH, headers: { "content-type": "application/json" } });
    fx.route("/i/api/graphql/q1/HomeTimeline", { body: "{\"data\":{}}", headers: { "content-type": "application/json" } });
    origin = new URL(fx.page("/search", `<!doctype html><title>Search</title><script>
      const q = new URLSearchParams(location.search).get("q");
      setTimeout(() => {
        fetch("/i/api/graphql/q1/HomeTimeline").then((r) => r.json());
        fetch("/i/api/graphql/q1/SearchTimeline?variables=" + encodeURIComponent(JSON.stringify({ rawQuery: q }))).then((r) => r.json());
      }, 200);
    </script>`)).origin;
  }, hostTimeout(60_000));

  afterAll(async () => {
    await fx?.close();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function provider(key: string, browser: XSessionBrowser) {
    const dir = mkdtempSync(join(tmpdir(), "x-engines-"));
    dirs.push(dir);
    const store = new XAccountStore(dir);
    store.update(key, (record) => ({ ...record, use: "on" }));
    return createSessionProvider({ browser, store, origin });
  }

  it("reads the search page's own answer on dusk bot's Chrome engine", async () => {
    const real: RealService = await startService();
    try {
      const target = { key: "bot:x-engine-cdp", session: "x-engine-cdp" };
      const search = provider(target.key, {
        target: async () => target,
        read: (where, request) => real.service.readResponses(where, { url: request.url, wanted: (url) => graphqlOp(url, request.ops), enough: (names) => request.ops.every((op) => names.has(op)), timeoutMs: request.timeoutMs }),
      });
      const answer = await search.search!({ query: "openai science", sort: "latest", limit: 10 }, { botId: "b", credential: null });
      expect(answer.posts.map((post) => post.id)).toEqual(EXPECTED);
    } finally {
      await real.close();
    }
  }, hostTimeout(240_000));

  (engine.kind === "ready" ? it : it.skip)("reads the search page's own answer on agent-browser's Chrome, starting it when stopped", async () => {
    if (engine.kind !== "ready") return;
    // agent-browser's socket path must stay under 104 bytes, so its folders sit in /tmp.
    const root = mkdtempSync("/tmp/xab-");
    dirs.push(root);
    const spec = agentBrowserIntegration({ binaryPath: engine.binaryPath, session: "xab", encryptionKey: "e".repeat(64), persistent: true, dataDir: root, env: { HOME: root, PATH: process.env.PATH ?? "" } });
    const env = browserRuntimeEnv({ ...spec.env, HOME: root, AGENT_BROWSER_SOCKET_DIR: join(root, "s"), AGENT_BROWSER_SESSION: "xab", ...(CHROME ? { AGENT_BROWSER_EXECUTABLE_PATH: CHROME } : {}) });
    delete env.AGENT_BROWSER_PROXY;
    delete env.AGENT_BROWSER_PROXY_BYPASS;
    // the empty managed config the server writes before a session's first command
    mkdirSync(dirname(env.AGENT_BROWSER_CONFIG!), { recursive: true });
    writeFileSync(env.AGENT_BROWSER_CONFIG!, "{}\n");
    try {
      const search = provider("agent-browser:xab", {
        target: async () => ({ key: "agent-browser:xab", session: "xab" }),
        read: (_where, request) => readOnAgentBrowser({ binaryPath: engine.binaryPath, session: "xab", env }, {
          url: request.url, wanted: (url) => graphqlOp(url, request.ops), enough: (names) => request.ops.every((op) => names.has(op)), timeoutMs: request.timeoutMs,
        }),
      });
      const answer = await search.search!({ query: "openai science", sort: "latest", limit: 10 }, { botId: "b", credential: null });
      expect(answer.posts.map((post) => post.id)).toEqual(EXPECTED);
    } finally {
      await closeBrowserSession(engine.binaryPath, env);
    }
  }, hostTimeout(240_000));
});
