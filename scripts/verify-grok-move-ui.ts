// "Move from Grok Bot" in the real renderer: the whole app, as the desktop app's own window, against an isolated
// fake-engine server run as that app's own (owner token) whose temporary home holds the synthetic Grok Bot profile
// (server/testing/grok-bot-profile.ts). Drives the flow by its buttons: the palette's Move from Grok Bot, the preview, the
// move, the result, Ask (the page's openExternal only records the link: Grok Bot is installed where this runs and must
// never be driven), the bot's export written into the fixture's Downloads, the row turning to Got it, a refused file, the
// Settings row, and Undo after its preview. Prints counts and timings only.
// Run: node --experimental-strip-types scripts/verify-grok-move-ui.ts
// Playwright is not a dependency: DUSK_VERIFY_PLAYWRIGHT names a playwright(-core) module, DUSK_VERIFY_BROWSER_CHROME a
// Chrome to launch. SHOTS=<dir> saves 2x screenshots, SKIN=light|dark and WIDTH=<px> pick the look.
// GROK_HOME_FROM=<home>: copy only Grok Bot's cache and photos from that home instead, move every live bot through the
// screens and stop there (no screenshots, no Ask, no undo): the way to time the screens on a copy of a real profile.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { launchVerificationServer, verificationHome } from "./control-dusk.ts";
import { mountPreview, type MountedPreview } from "./testing/preview-fixture.ts";
import { GROK_MOVE_ROUTES as R, grokExportFileName, type GrokDetection, type GrokMoveProgress } from "../shared/grok-move.ts";
import { plantGrokProfile, SYNTHETIC_BOTS, syntheticExport } from "../server/testing/grok-bot-profile.ts";

const owner = randomBytes(32).toString("base64url");
const env = { ...process.env, DUSK_TEST_DESKTOP_OWNER_TOKEN: owner };
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => realFetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), "x-dusk-desktop-owner": owner } });
const from = process.env.GROK_HOME_FROM?.trim();
const shots = from ? "" : process.env.SHOTS?.trim() ?? "";
const skin = process.env.SKIN === "dark" ? "grok-dark" : "grok";
const width = Number(process.env.WIDTH) || 1440;
const phone = width < 600;

const fixture = await launchVerificationServer(env);
const home = verificationHome(env, fixture.info.dataDir);
const grokRoot = join("Library", "Application Support", "Grok Bot");
if (from) {
  for (const folder of ["sand-client-persistence", "roster-avatars"]) {
    const source = join(from, grokRoot, folder);
    if (existsSync(source)) cpSync(source, join(home, grokRoot, folder), { recursive: true, verbatimSymlinks: true });
  }
} else plantGrokProfile(home);
const call = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return await response.json() as T;
};
await call("PUT", "/api/config", { language: "en" });

let ui: MountedPreview | undefined;
let browser: { close(): Promise<void> } | undefined;
let failurePage: { screenshot(options: { path: string }): Promise<unknown> } | undefined;
const report: Record<string, unknown> = { source: from ? "copied home" : "synthetic profile", skin, width };
const started = performance.now();
const ms = () => Math.round(performance.now() - started);
try {
  ui = await mountPreview(fixture, {
    entry: "/scripts/testing/grok-move-preview.tsx", route: "/__grok-move.html", title: "Isolated Grok Bot move",
    proxyHeaders: { "x-dusk-desktop-owner": owner }, hmr: false, logLevel: "error",
  });
  const playwright = await import(process.env.DUSK_VERIFY_PLAYWRIGHT || "playwright");
  const { chromium } = playwright.chromium ? playwright : playwright.default;
  const launched = await chromium.launch({ headless: true, executablePath: process.env.DUSK_VERIFY_BROWSER_CHROME || undefined, args: ["--use-mock-keychain", "--password-store=basic"] });
  browser = launched;
  const page = await launched.newPage({ viewport: { width, height: phone ? 844 : 900 }, deviceScaleFactor: 2, reducedMotion: "reduce", colorScheme: skin === "grok" ? "light" : "dark" });
  failurePage = page;
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  if (shots) mkdirSync(shots, { recursive: true });
  const sheet = page.locator("[data-grok-move]");
  const shot = async (name: string) => {
    if (!shots) return;
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(shots, `${name}.png`), ...(phone ? {} : { clip: await sheet.boundingBox().then((box: { x: number; y: number; width: number; height: number }) => ({ x: box.x - 24, y: box.y - 24, width: box.width + 48, height: box.height + 48 })) }) });
  };
  const screen = async (name: string) => page.waitForSelector(`[data-grok-move="${name}"]`, { timeout: 20_000 });

  await page.goto(`${ui.previewUrl}?skin=${skin}`);
  await page.waitForSelector("[data-sidebar-root], [data-chat-root], main", { timeout: 30_000 });
  await page.waitForTimeout(1_500);
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Move from Grok Bot");
  await page.keyboard.press("Enter");
  await screen("preview");
  const detection = await call<GrokDetection>("GET", R.detect);
  const live = detection.bots.filter((bot) => !bot.removed);
  report.preview = {
    ms: ms(), title: await page.locator("#grok-move-title").textContent(), rows: await page.locator("[data-grok-bot]").count(),
    pictures: await page.locator("[data-grok-bot] img").count(), removedFolded: await page.locator("[data-grok-removed]").getAttribute("aria-expanded"),
  };
  assert.equal(report.preview && (report.preview as { rows: number }).rows, detection.bots.length, "one row per bot");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "grok-move-title", "focus on the title");
  if (!from) {
    assert.equal((report.preview as { title: string }).title, `${live.length} bots found on this Mac`);
    assert.equal(await page.locator("[data-grok-bot] [data-grok-chip=problem-newerFormat]").count(), 1, "the chat in a newer format is named on its row");
    await shot("1-preview");
    await page.locator(`[data-grok-bot="${live[0]!.rosterId}"] button[aria-expanded]`).click();
    await shot("1-preview-open");
    await page.locator(`[data-grok-bot="${live[0]!.rosterId}"] button[aria-expanded]`).click();
  }

  // the first look at progress is held a moment, so the screen on its way can be seen; the data is the server's own
  let held = false;
  await page.route(`**${R.progress}`, async (route: { fetch(): Promise<unknown>; fulfill(options: { response: unknown }): Promise<void> }) => {
    const response = await route.fetch();
    if (!held) { held = true; await new Promise((resolve) => setTimeout(resolve, 1_500)); }
    await route.fulfill({ response });
  });
  const moveStarted = performance.now();
  await page.locator("[data-grok-start]").click();
  await screen("progress");
  report.progress = { title: await page.locator("#grok-move-title").textContent(), rows: await page.locator("[data-grok-row]").count(), count: await page.locator("[data-grok-count]").textContent() };
  await shot("2-progress");
  await screen("result");
  const moveMs = Math.round(performance.now() - moveStarted);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const progress = await call<GrokMoveProgress>("GET", R.progress);
  const bots = (await call<{ bots: Array<{ id: string; name: string; section?: string; tasks?: Array<{ unread?: boolean }>; installedPackage?: { origin?: { app: string } } }> }>("GET", "/api/bots")).bots;
  const moved = bots.filter((bot) => bot.installedPackage?.origin?.app === "grok-bot");
  report.result = {
    moveMs, title: await page.locator("#grok-move-title").textContent(), state: progress.state, done: progress.result?.moved, failed: progress.result?.failed,
    messages: progress.bots.reduce((sum, bot) => sum + (bot.moved?.messages ?? 0), 0), pictures: progress.bots.filter((bot) => bot.moved?.picture).length,
    inSection: moved.filter((bot) => bot.section === "Grok Bot").length, unread: moved.filter((bot) => bot.tasks?.some((task) => task.unread)).length,
    askRows: await page.locator("[data-grok-ask-row]").count(), apps: progress.result?.apps.length,
  };
  assert.equal(progress.state, "done");
  assert.equal(progress.result?.failed, 0);
  assert.equal(moved.length, live.length, "every live bot moved");
  if (from) {
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = errors.length ? 1 : 0;
  } else {
    assert.equal(await page.evaluate(() => document.activeElement?.id), "grok-move-title", "focus moves to the new screen's title");
    await shot("3-result");

    const nova = live.find((bot) => bot.name === SYNTHETIC_BOTS[0]!.name)!;
    const quill = live.find((bot) => bot.name === SYNTHETIC_BOTS[1]!.name)!;
    await page.getByRole("button", { name: `Ask ${nova.label} for the rest` }).click();
    await page.waitForSelector(`[data-grok-ask-row="${nova.rosterId}"][data-grok-ask-state=waiting]`);
    const opened = await page.evaluate(() => (window as unknown as { grokOpened: string[] }).grokOpened);
    assert.equal(opened.length, 1, "one link, through the app's own bridge");
    assert.ok(opened[0]!.startsWith(`grokbot://app/v1/prompt?id=${nova.rosterId}&text=`), "Grok Bot's prompt link for that bot");
    assert.ok(opened[0]!.length <= 2048);
    report.ask = { url: opened[0]!.slice(0, 40) + "…", urlLength: opened[0]!.length, row: await page.locator(`[data-grok-ask-row="${nova.rosterId}"]`).getAttribute("data-grok-ask-state") };
    await page.getByRole("button", { name: `Ask ${quill.label} for the rest` }).click();
    await page.waitForSelector(`[data-grok-ask-row="${quill.rosterId}"][data-grok-ask-state=waiting]`);
    await page.locator(`[data-grok-ask-row="${nova.rosterId}"]`).evaluate((row: HTMLElement) => row.scrollIntoView({ block: "center" }));
    await shot("4-waiting");

    const downloads = join(home, "Downloads");
    mkdirSync(downloads, { recursive: true });
    const arrivedAt = performance.now();
    writeFileSync(join(downloads, grokExportFileName(nova.rosterId)), syntheticExport(nova.name));
    writeFileSync(join(downloads, grokExportFileName(quill.rosterId)), syntheticExport(quill.name, { api_key: "invented-not-a-key" }));
    await page.waitForSelector(`[data-grok-ask-row="${nova.rosterId}"][data-grok-ask-state=arrived]`, { timeout: 30_000 });
    await page.waitForSelector(`[data-grok-ask-row="${quill.rosterId}"][data-grok-ask-state=problem]`, { timeout: 30_000 });
    report.export = {
      ms: Math.round(performance.now() - arrivedAt),
      gotIt: await page.locator(`[data-grok-ask-row="${nova.rosterId}"]`).innerText().then((text: string) => text.includes("Got it:")),
      refusedSaysWhy: await page.locator(`[data-grok-ask-row="${quill.rosterId}"]`).innerText().then((text: string) => text.includes("passwords, tokens or keys")),
    };
    assert.deepEqual(report.export && { ...(report.export as object), ms: 0 }, { ms: 0, gotIt: true, refusedSaysWhy: true });
    await page.locator(`[data-grok-ask-row="${nova.rosterId}"]`).evaluate((row: HTMLElement) => row.scrollIntoView({ block: "center" }));
    await shot("5-got-it");

    await page.keyboard.press("Escape");
    await page.waitForSelector("[data-grok-move]", { state: "detached" });
    await page.keyboard.press("Meta+k");
    await page.keyboard.press("Meta+a");
    await page.keyboard.type("Bring in from other apps");
    await page.keyboard.press("Enter");
    const row = page.locator("[data-grok-entry=settings]");
    await row.waitFor({ timeout: 20_000 });
    report.settingsRow = await row.locator("[data-grok-entry-line]").textContent();
    if (shots) {
      await page.waitForTimeout(400);
      const box = await row.boundingBox();
      await page.screenshot({ path: join(shots, "6-settings-row.png"), clip: { x: box.x - 160, y: box.y - 120, width: box.width + 320, height: box.height + 320 } });
    }
    await row.locator("[data-grok-entry-open]").click();
    await screen("result");

    await call("POST", `/api/bots/${moved.find((bot) => bot.name === nova.name)!.id}/messages`, { text: "An invented message after the move" });
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await page.locator("[data-grok-undo]").click();
    await page.waitForSelector("[data-grok-screen=undo]");
    report.undoPreview = { warns: await page.locator("[data-grok-undo-warn]").count(), lists: await page.locator("[data-grok-section=undo-bots] li").count() };
    await shot("7-undo");
    await page.locator("[data-grok-confirm-undo]").click();
    await page.waitForSelector("[data-grok-screen=undone]");
    const after = (await call<{ bots: Array<{ installedPackage?: { origin?: { app: string } } }> }>("GET", "/api/bots")).bots.filter((bot) => bot.installedPackage?.origin?.app === "grok-bot");
    report.undo = { left: after.length, said: await page.locator("[data-grok-screen=undone]").innerText() };
    assert.equal(after.length, 0, "the move's bots are gone");
    report.pageErrors = errors.length;
    report.totalMs = ms();
    console.log(JSON.stringify(report, null, 2));
    assert.equal(errors.length, 0, errors.join("\n"));
  }
} catch (error) {
  const evidence = join(".dusk-scratch", "verify-evidence", "grok-move-ui");
  mkdirSync(evidence, { recursive: true });
  await failurePage?.screenshot({ path: join(evidence, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await ui?.close();
  await fixture.close();
}
