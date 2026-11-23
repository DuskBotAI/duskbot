// "Move from Grok Bot" through its HTTP routes on an isolated fake-engine server run as the desktop app's own (owner
// token), whose temporary home holds the synthetic Grok Bot profile (server/testing/grok-bot-profile.ts). Detects, moves
// every live bot, asks the first for the rest, drops its export into the fixture's Downloads, waits for it to be applied,
// previews the undo and undoes it. Prints counts and timings only, never a name or a line of text.
// Run: node --experimental-strip-types scripts/verify-grok-move.ts
// GROK_HOME_FROM=<home>: copy only Grok Bot's cache and photos from that home instead (no export is dropped, no undo).
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { launchVerificationServer, verificationHome } from "./control-dusk.ts";
import { GROK_MOVE_ROUTES as R, type GrokDetection, type GrokMoveProgress, type GrokRequestText, type GrokUndoPreview, type GrokWaitingList } from "../shared/grok-move.ts";
import { plantGrokProfile, syntheticExport } from "../server/testing/grok-bot-profile.ts";

const owner = randomBytes(32).toString("base64url");
const env = { ...process.env, DUSK_TEST_DESKTOP_OWNER_TOKEN: owner };
// as the desktop app's own window: every request to the fixture carries the owner token
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => realFetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), "x-dusk-desktop-owner": owner } });
const fixture = await launchVerificationServer(env);
const home = verificationHome(env, fixture.info.dataDir);
const from = process.env.GROK_HOME_FROM?.trim();
const grokRoot = join("Library", "Application Support", "Grok Bot");
if (from) {
  for (const folder of ["sand-client-persistence", "roster-avatars"]) {
    const source = join(from, grokRoot, folder);
    if (existsSync(source)) cpSync(source, join(home, grokRoot, folder), { recursive: true, verbatimSymlinks: true });
  }
} else plantGrokProfile(home);

const headers = { "content-type": "application/json", origin: fixture.info.url };
async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T; ms: number }> {
  const started = performance.now();
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as T, ms: Math.round(performance.now() - started) };
}
const report: Record<string, unknown> = { url: fixture.info.url, pid: fixture.info.pid, source: from ? "copied home" : "synthetic profile" };
try {
  const detect = await call<GrokDetection>("GET", R.detect);
  const live = detect.body.bots.filter((bot) => !bot.removed);
  report.detect = {
    status: detect.status, ms: detect.ms, bots: detect.body.bots.length, removed: detect.body.bots.length - live.length,
    withPhoto: detect.body.bots.filter((bot) => bot.look.photoUrl).length, withDescription: detect.body.bots.filter((bot) => bot.hasDescription).length,
    messages: live.reduce((sum, bot) => sum + bot.chat.messages, 0), earlier: live.filter((bot) => bot.chat.earlier).length,
    routineNames: live.reduce((sum, bot) => sum + bot.routines, 0), apps: detect.body.apps.length, problems: detect.body.problems.map((problem) => `${problem.slice}:${problem.code}`),
  };
  const photo = live.find((bot) => bot.look.photoUrl);
  if (photo) {
    const response = await fetch(`${fixture.info.url}${photo.look.photoUrl}`, { headers });
    report.photo = { status: response.status, type: response.headers.get("content-type"), bytes: (await response.arrayBuffer()).byteLength };
  }
  const start = await call<GrokMoveProgress>("POST", R.start, { bots: live.map((bot) => ({ rosterId: bot.rosterId })) });
  const second = await call<{ error: string }>("POST", R.start, { bots: live.slice(0, 1).map((bot) => ({ rosterId: bot.rosterId })) });
  const began = performance.now();
  if (start.status !== 202) throw new Error(`the move did not start (${start.status}): ${JSON.stringify(report.detect)}`);
  let progress = start.body;
  while (progress.state === "running" || progress.state === "stopping") {
    await new Promise((resolve) => setTimeout(resolve, 100));
    progress = (await call<GrokMoveProgress>("GET", R.progress)).body;
  }
  report.move = {
    status: start.status, secondMoveStatus: second.status, ms: Math.round(performance.now() - began), state: progress.state,
    done: progress.bots.filter((bot) => bot.state === "done").length, failed: progress.bots.filter((bot) => bot.state === "failed").length,
    updated: progress.bots.filter((bot) => bot.update).length,
    messages: progress.bots.reduce((sum, bot) => sum + (bot.moved?.messages ?? 0), 0), pictures: progress.bots.filter((bot) => bot.moved?.picture).length,
    routineNames: progress.bots.reduce((sum, bot) => sum + (bot.moved?.routineNames ?? 0), 0),
  };
  const bots = await (await fetch(`${fixture.info.url}/api/bots`, { headers })).json() as { bots: Array<{ section?: string; tasks?: Array<{ unread?: boolean }>; unread?: boolean }> };
  report.landed = {
    inGrokSection: bots.bots.filter((bot) => bot.section === "Grok Bot").length,
    unread: bots.bots.filter((bot) => bot.unread || bot.tasks?.some((task) => task.unread)).length,
    engineTurnsStarted: existsSync(fixture.fixtureDumpPath) ? "some" : 0,
  };
  const first = live[0];
  if (first) {
    const request = await call<GrokRequestText>("POST", R.request, { rosterId: first.rosterId });
    report.request = { status: request.status, textChars: request.body.text.length, urlChars: request.body.url.length };
    if (!from) {
      mkdirSync(join(home, "Downloads"), { recursive: true });
      writeFileSync(join(home, "Downloads", request.body.file), syntheticExport(first.name));
      const waitStarted = performance.now();
      let waiting = (await call<GrokWaitingList>("GET", R.waiting)).body;
      while (waiting.waiting > 0 && performance.now() - waitStarted < 20_000) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        waiting = (await call<GrokWaitingList>("GET", R.waiting)).body;
      }
      const applied = waiting.bots[0]?.applied;
      report.export = {
        ms: Math.round(performance.now() - waitStarted), state: waiting.bots[0]?.state, memories: applied?.memories, skills: applied?.skills,
        skillsOff: applied?.skillsOff, routines: applied?.routines.length, routinesToSet: applied?.routinesToSet.length, apps: applied?.apps.length,
      };
      const preview = await call<GrokUndoPreview>("GET", `${R.undo}?moveId=${progress.moveId}`);
      const undo = await call<{ removedBots: number; kept: unknown[] }>("POST", R.undo, { moveId: progress.moveId, confirm: true });
      report.undo = { previewBots: preview.body.bots.length, removedBots: undo.body.removedBots, kept: undo.body.kept.length, ms: undo.ms };
    }
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await fixture.close();
}
