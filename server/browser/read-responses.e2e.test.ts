// The server's own read of what a page fetched (x_search's X sign-in route) on real Chrome: a background tab, the
// named answers' bodies, nothing else kept, and the tab gone after. x.com's app reads every answer it fetches; Chrome
// reports a fetch finished (and its body readable) only once the page has read it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hostTimeout } from "../testing/host-timeout.ts";
import { graphqlOp } from "../x-providers/session.ts";
import { FixtureServer } from "./cdp/testing/fixtures.ts";
import { CHROME } from "./cdp/testing/real-chrome.ts";
import { startService, type RealService } from "./testing/real-service.ts";

const suite = CHROME ? describe : describe.skip;

suite("reading a page's own requests on real Chrome", () => {
  let fx: FixtureServer;
  let real: RealService;

  beforeAll(async () => {
    fx = await FixtureServer.start();
    real = await startService();
  }, hostTimeout(240_000));

  afterAll(async () => {
    await real?.close();
    await fx?.close();
  });

  it("keeps only the named GraphQL answers and closes its tab", async () => {
    fx.route("/i/api/graphql/abc/SearchTimeline", { body: JSON.stringify({ data: { search: "found" } }), headers: { "content-type": "application/json" } });
    fx.route("/i/api/graphql/abc/HomeTimeline", { body: JSON.stringify({ data: { home: "not wanted" } }), headers: { "content-type": "application/json" } });
    const url = fx.page("/search", `<!doctype html><title>search</title><script>
      setTimeout(() => { fetch("/i/api/graphql/abc/HomeTimeline?v=1").then((r) => r.json()); fetch("/i/api/graphql/abc/SearchTimeline?variables=%7B%7D").then((r) => r.json()); }, 300);
    </script>`);
    const target = { session: "x-read", key: "bot:x-read" };
    await real.call(target, "agent_browser_open", { url: fx.page("/home", "<title>home</title>") });
    const read = await real.service.readResponses(target, { url, wanted: (one) => graphqlOp(one, ["SearchTimeline"]), enough: (names) => names.has("SearchTimeline"), timeoutMs: 15_000 });
    expect(read.url).toBe(url);
    expect(read.responses).toEqual([{ name: "SearchTimeline", status: 200, body: JSON.stringify({ data: { search: "found" } }) }]);
    const profile = real.service.profiles().find((one) => one.key === target.key)!;
    await expect.poll(() => profile.tabs.list().map((tab) => tab.page.url()), { timeout: 5_000 }).toEqual([fx.page("/home", "<title>home</title>")]);
  }, hostTimeout(60_000));
});
