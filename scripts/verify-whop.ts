// Real registry, OAuth and renderer; no real Whop or Agentcard account, and no financial calls.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer } from "./control-dusk.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./testing/preview-fixture.ts";
import { startFakeOAuth } from "../server/testing/fake-oauth-server.ts";
import { startFakeHttpMcp } from "../server/testing/fake-http-mcp-server.ts";

// Node cannot import the app's table (it pulls in a PNG), so the official addresses are named here too.
const OFFICIAL = { whop: "https://mcp.whop.com/mcp", agentcard: "https://mcp.agentcard.sh/mcp" };
const fixture = await launchVerificationServer();
const oauth = await startFakeOAuth();
const mcp = await startFakeHttpMcp({ acceptBearer: oauth.isValid, wwwAuthenticate: oauth.challenge,
  tools: [{ name: "list_products", inputSchema: { type: "object", properties: {} } }] });
let ui: MountedPreview | undefined;
let browser: { close(): Promise<void> } | undefined;
try {
  const api = fixtureApi(fixture.info.url);
  // An unrelated existing name must survive Connect untouched.
  await api("POST", "/api/mcp/servers", { name: "whop", command: "node", args: ["unrelated-fixture.mjs"], enabled: false });
  const pairing = await api("POST", "/api/auth/pairing", { scopes: ["admin", "client"] });
  let authorizationUrl = "";
  let failCreate = true;
  let failTest = false;
  ui = await mountPreview(fixture, {
    entry: "/scripts/testing/whop-preview.tsx", route: "/__whop.html", title: "Isolated Whop integration",
    extraRoutes: [
      { path: "/api/connectors/catalog", handler: (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ configured: false, mode: "self-hosted", source: "curated", cards: ["gmail", "slack", "notion"].map((slug) => ({ slug, label: slug === "gmail" ? "Gmail" : slug[0].toUpperCase() + slug.slice(1), blurb: "Connect your account", logo: null, domain: null })) }));
      } },
      { path: /^\/api\/connectors(?:\/connected)?$/, handler: (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ services: {} }));
      } },
      { path: /^\/api\/mcp\/servers(?:\/.*)?$/, handler: async (req, res) => {
      const path = req.url!;
      if (req.method === "POST" && path === "/api/mcp/servers" && failCreate) {
        failCreate = false;
        res.writeHead(503, { "content-type": "application/json" }).end('{"error":"Synthetic save failure"}');
        return;
      }
      if (req.method === "POST" && path.endsWith("/test") && failTest) {
        failTest = false;
        res.writeHead(200, { "content-type": "application/json" }).end('{"ok":false,"error":"Synthetic discovery failure"}');
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      // Only the fixture substitutes transport: production always saves the official URL.
      if (raw) { const body = JSON.parse(raw); if (Object.values(OFFICIAL).includes(body.url)) body.url = mcp.url; raw = JSON.stringify(body); }
      const response = await fetch(`${fixture.info.url}${path}`, { method: req.method,
        headers: { "content-type": "application/json", cookie: req.headers.cookie ?? "", "x-forwarded-for": "192.0.2.10" },
        ...(raw ? { body: raw } : {}),
      });
      const body = await response.json();
      for (const server of body.servers ?? []) if (server.url === mcp.url) server.url = server.name.startsWith("agentcard") ? OFFICIAL.agentcard : OFFICIAL.whop;
      if (req.method === "POST" && path.endsWith("/sign-in") && response.ok) {
        authorizationUrl = body.auth.authorizationUrl;
        body.auth.authorizationUrl = "https://oauth.example.test/authorize";
      }
      res.writeHead(response.status, { "content-type": "application/json" }).end(JSON.stringify(body));
    } }],
  });
  const { chromium } = await import(process.env.DUSK_VERIFY_PLAYWRIGHT || "playwright");
  browser = await chromium.launch({ headless: true, executablePath: process.env.DUSK_VERIFY_BROWSER_CHROME || undefined, args: ["--use-mock-keychain", "--password-store=basic"] });
  const context = await (browser as any).newContext({ viewport: { width: 1100, height: 1000 } });
  const page = await context.newPage();
  const errors: string[] = [];
  // The preview's Vite client throws when its hot-reload socket drops across a page reload.
  page.on("pageerror", (error: Error) => { if (!error.stack?.includes("/@vite/client")) errors.push(error.message); });
  await page.addInitScript(() => { window.open = () => null; });
  await page.goto(ui.previewUrl);
  assert.equal(await page.evaluate(async (code: string) => (await fetch("/api/auth/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, cookie: true, label: "Whop fixture" }) })).status, pairing.code), 200);
  await page.reload();
  const row = page.locator('[data-app-tile="whop"]');
  const connected = (card: typeof row) => card.locator('[role="status"][data-tone="ok"]');
  const search = page.getByRole("combobox", { name: "Search across apps and skills", exact: true });
  const hit = (name: string) => page.getByRole("option", { name, exact: true });
  const openApp = async (name: string) => {
    await search.fill(name.toLowerCase());
    await hit(name).click();
    await page.locator("[data-app-page]").getByRole("heading", { name, exact: true }).waitFor();
  };
  const back = page.locator(".ca-bar").getByRole("button", { name: /^(Back|Connect apps)$/ });
  const home = async () => {
    while (await back.count()) await back.first().click();
    await page.getByRole("button", { name: "Your plugins", exact: true }).waitFor();
  };
  const plugins = async () => {
    await home();
    await page.getByRole("button", { name: "Your plugins", exact: true }).click();
    await page.locator(".ca-yours").waitFor();
  };
  const connect = () => row.getByRole("button", { name: "Connect Whop", exact: true }).click();
  await openApp("Whop");
  assert.equal(await page.getByText("Set up Whop", { exact: true }).count(), 0);
  const status = async () => (await api("GET", "/api/mcp/servers")).servers;
  // This browser is not on the server's machine and the fixture has no https
  // address to come back to, so the paste-back box is shown up front.
  const pasteBack = () => page.getByText("After you approve, your browser shows a page that can't load. Copy that page's full address and paste it here.", { exact: true });
  const complete = async () => {
    await pasteBack().waitFor();
    assert.equal(await page.getByText("Signing in from another computer?", { exact: true }).count(), 0);
    const approved = await fetch(authorizationUrl, { redirect: "manual" });
    await page.getByRole("textbox", { name: "Redirect URL", exact: true }).fill(approved.headers.get("location")!);
    await page.getByRole("button", { name: "Complete sign-in", exact: true }).click();
  };
  await connect();
  await page.getByRole("alert").getByText("Synthetic save failure", { exact: true }).waitFor();
  assert.equal((await status()).length, 1);
  await connect();
  await pasteBack().waitFor();
  assert.equal((await status()).find((server: any) => server.name === "whop-2").enabled, false);
  await row.getByRole("button", { name: "Cancel", exact: true }).click();
  await connect();
  oauth.options.deny = true;
  await complete();
  await row.getByRole("button", { name: "Connect Whop", exact: true }).waitFor();
  assert.equal((await status()).length, 2, "Retry reuses the same entry");
  assert.equal((await status()).find((server: any) => server.name === "whop-2").enabled, false);
  oauth.options.deny = false;
  await connect();
  await complete();
  await connected(row).waitFor();
  const signedIn = (await status()).find((server: any) => server.name === "whop-2");
  assert.equal(signedIn.auth, "signed-in");
  assert.equal(signedIn.enabled, true);
  assert.ok(mcp.seenHeaders.some((headers) => oauth.isValid(headers.authorization)));
  const bearer = mcp.seenHeaders.find((headers) => oauth.isValid(headers.authorization))!.authorization!.replace(/^Bearer /, "");
  assert.equal(JSON.stringify(signedIn).includes(bearer), false, "The browser listing never includes the token");
  assert.equal(mcp.calls.length, 0, "Connecting never executes business tools");
  assert.equal((await status()).find((server: any) => server.name === "whop").command, "node");
  const output = process.env.DUSK_UI_EVIDENCE_DIR || "/tmp/dusk-whop-evidence";
  mkdirSync(output, { recursive: true });
  await page.screenshot({ path: join(output, "connected.png"), fullPage: true });
  await plugins();
  await page.locator('.ca-yours [data-app-row="whop"]').waitFor();
  assert.equal(await page.locator('.ca-yours [data-app-row="gmail"]').count(), 0);
  await home();
  assert.equal(await page.getByRole("button", { name: "Your plugins", exact: true }).innerText(), "1 connected");
  await page.locator('.ca-yours').waitFor({ state: "detached" });
  await openApp("Whop");
  await row.getByRole("button", { name: "Disconnect Whop", exact: true }).click();
  await row.getByRole("button", { name: "Connect Whop", exact: true }).waitFor();
  await plugins();
  assert.equal(await page.locator('.ca-yours [data-app-row="whop"]').count(), 0);
  await home();
  await openApp("Whop");
  await connect(); await complete();
  await connected(row).waitFor();
  await page.reload();
  await openApp("Whop");
  await row.getByRole("button", { name: "Disconnect Whop", exact: true }).waitFor();
  assert.equal(await page.locator("[data-whop-setup]").count(), 0);
  await row.getByRole("button", { name: "Disconnect Whop", exact: true }).click();
  await row.getByRole("button", { name: "Connect Whop", exact: true }).waitFor();
  assert.equal((await status()).find((server: any) => server.name === "whop-2").enabled, false);
  assert.ok(oauth.counts.revoke > 0);
  assert.equal(await page.getByText("Whop is connected and enabled. Bot access follows each bot’s MCP server selection.", { exact: true }).count(), 0);
  assert.equal(await row.getByText(/list_products/).count(), 0);
  // A successful login alone must not claim the tool connection is ready.
  failTest = true;
  await connect(); await complete();
  await page.getByText("Signed in, but Whop’s tools could not be loaded: Synthetic discovery failure. Please connect again to retry.", { exact: true }).waitFor();
  assert.equal((await status()).find((server: any) => server.name === "whop-2").enabled, false);
  await connect(); await complete();
  await connected(row).waitFor();
  await home();
  await search.fill("whop");
  await hit("Whop").waitFor();
  assert.equal(await hit("Gmail").count(), 0);
  await search.fill("gmail");
  await hit("Gmail").waitFor();
  assert.equal(await hit("Whop").count(), 0);
  await search.fill("agentcard");
  await hit("Agentcard").waitFor();
  assert.equal(await hit("Whop").count(), 0);
  await hit("Agentcard").click();
  const agentcard = page.locator('[data-app-tile="agentcard"]');
  await agentcard.waitFor();
  assert.equal(await agentcard.locator("img").count(), 0, "Agentcard draws a glyph, never a logo");
  await agentcard.getByRole("button", { name: "Connect Agentcard", exact: true }).click();
  await complete();
  await connected(agentcard).waitFor();
  const agentcardServer = (await status()).find((server: any) => server.name === "agentcard");
  assert.equal(agentcardServer.auth, "signed-in");
  assert.equal(agentcardServer.enabled, true);
  await home();
  assert.equal(await page.getByRole("button", { name: "Your plugins", exact: true }).innerText(), "2 connected");
  await plugins();
  assert.equal(await page.locator('.ca-yours [data-app-row="whop"]').count(), 1, "Whop stays connected beside Agentcard");
  await page.locator('.ca-yours').getByRole("button", { name: "Open Agentcard", exact: true }).click();
  await agentcard.waitFor();
  await agentcard.getByRole("button", { name: "Disconnect Agentcard", exact: true }).click();
  await agentcard.getByRole("button", { name: "Connect Agentcard", exact: true }).waitFor();
  assert.equal((await status()).find((server: any) => server.name === "agentcard").enabled, false);
  await home();
  await openApp("Whop");
  await connected(row).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "narrow.png"), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, ...fixture.info, evidence: output, liveWhopAccountTested: false }));
} finally {
  await browser?.close(); await ui?.close(); await mcp.close(); await oauth.close(); await fixture.close();
}
