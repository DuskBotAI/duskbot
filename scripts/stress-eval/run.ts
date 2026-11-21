// Stress eval: many realistic conversations (scenarios.ts) against real dusk bot servers started from --repo, each
// with its own data dir under --tmp and a port pair in 8900-8999, bots on one OpenAI-compatible engine pointed at the
// gateway. Conversations run several at a time per server and on several servers at once, through the app's HTTP
// routes and its live event stream. Each is scored by hard checks (files and links open, no tool or step text in chat,
// no errors, no stuck turns, latency) and a judge model, and appended to <out>/results.jsonl as it finishes; a rerun
// with the same --out skips what is already there.
//   node --experimental-strip-types scripts/stress-eval/run.ts --tmp <dir> --out <dir> --fixtures <dir> \
//     [--model gpt-6.2-sol] [--judge gpt-6.2-sol] [--repeat 2] [--servers 4] [--parallel 3] [--recycle 9] [--only id,id]
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { client } from "../memory-eval/client.ts";
import { gatewayFromEnv, type Gateway } from "../memory-eval/sandbox.ts";
import { launchServer, type Engine, type StressServer } from "./server.ts";
import { startTelegram } from "./telegram.ts";
import { SCENARIOS_2 } from "./scenarios2.ts";
import { listen, type Frame } from "./events.ts";
import { SCENARIOS, type Scenario } from "./scenarios.ts";
import { hardChecks, type Checked } from "./checks.ts";
import { judge, type Verdict } from "./judge.ts";

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: {
  repo: { type: "string", default: resolve(here, "..", "..") },
  tmp: { type: "string" },
  out: { type: "string" },
  fixtures: { type: "string" },
  model: { type: "string", default: "gpt-6.2-sol" },
  judge: { type: "string", default: "gpt-6.2-sol" },
  repeat: { type: "string", default: "2" },
  servers: { type: "string", default: "4" },
  parallel: { type: "string", default: "3" },
  recycle: { type: "string", default: "9" },
  only: { type: "string", default: "" },
  limit: { type: "string", default: "0" },
  /** keep each server's data folder (jobs, job logs, native logs) beside its server.log */
  keep: { type: "boolean", default: false },
  /** how long the live check waits for a watch to report the changed page */
  "live-wait": { type: "string", default: "240000" },
  /** base: round one's scenarios; new: scenarios2.ts; all; matrix: the 60 the engine matrix runs */
  set: { type: "string", default: "base" },
  engine: { type: "string", default: "openai-compat" },
  /** context.compactAt for every server, so long chats fold within a test */
  "compact-at": { type: "string", default: "" },
} });
if (!values.tmp || !values.out || !values.fixtures) throw new Error("--tmp, --out and --fixtures are required");
const out = values.out;
mkdirSync(out, { recursive: true });
const resultsPath = join(out, "results.jsonl");
const log = (...parts: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...parts);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gateway: Gateway = gatewayFromEnv(values.model!);

const done = new Set(existsSync(resultsPath) ? readFileSync(resultsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).key as string) : []);
const only = values.only ? new Set(values.only.split(",")) : null;
let jobs: Array<{ key: string; run: number; scenario: Scenario }> = [];
const MATRIX = ["biz-sales-followup", "biz-sales-leads-csv", "biz-sales-pitch-correct", "biz-sales-pipeline-sheet", "biz-support-inbox-check", "biz-hiring-cv",
  "biz-books-bank-csv", "biz-books-invoice-pdf", "biz-books-receipt-split", "biz-mkt-chart-image", "biz-mkt-sales-csv", "agency-monitor-telegram", "agency-weekly-report-routine",
  "student-homework-math", "student-pdf-summary", "student-whiteboard", "dev-regex", "dev-script-file", "dev-interrupt", "creator-yt-titles", "nonnative-email-boss",
  "vent-angry-bot", "vague-fix-it", "typo-heavy", "hinglish-reminder", "pt-email", "mem-veg-later", "mem-update", "rt-morning-brief", "rt-cancel-none",
  "rt-one-off-relative", "mon-price", "mon-local-page", "cap-what-can", "cap-whatsapp", "computer-files", "edge-doctor-note", "edge-fake-review", "ref-earlier-list",
  "ref-correction-number", "interrupt-stop", "interrupt-change", "burst-messages", "tone-hi", "tone-thanks", "long-business-plan", "long-ppt-outline",
  "x-inbox-chief", "x-receipt-adjust", "x-price-guard", "x-receivables", "x-book-approval", "bw-inbox-triage", "bw-outreach-approve", "bw-hiring-screen",
  "mt-three-in-one", "mt-rapid-separate", "bg-tg-urgent", "ca-tg-connect", "pr-spend-csv"];
const ALL = [...SCENARIOS, ...SCENARIOS_2];
const chosen = values.set === "new" ? SCENARIOS_2 : values.set === "all" ? ALL : values.set === "matrix" ? MATRIX.map((id) => ALL.find((one) => one.id === id)!) : SCENARIOS;
if (chosen.some((one) => !one)) throw new Error("a matrix id names no scenario");
const engine = values.engine as Engine;
if (!["openai-compat", "codex", "opencode"].includes(engine)) throw new Error("--engine is openai-compat, codex or opencode");
const telegram = await startTelegram();
for (let run = 1; run <= Number(values.repeat); run++) {
  for (const scenario of chosen) if (!only || only.has(scenario.id)) jobs.push({ key: `${scenario.id}#${run}`, run, scenario });
}
jobs = jobs.filter((job) => !done.has(job.key));
if (Number(values.limit) > 0) jobs = jobs.slice(0, Number(values.limit));
log(`${jobs.length} conversations to run (${done.size} already done)`);

// The page the live monitor check watches: one path per conversation, whose status the eval flips after it.
const pages = new Map<string, { status: string; hits: number }>();
const pageServer = createServer((req, res) => {
  const page = pages.get((req.url ?? "").split("?")[0]!);
  if (!page) { res.writeHead(404); res.end(); return; }
  page.hits += 1;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><html><head><title>Order 4471</title></head><body><h1>Order 4471</h1><p id="status">Status: ${page.status}</p></body></html>`);
});
await new Promise<void>((done) => pageServer.listen(0, "127.0.0.1", done));
const pageBase = `http://127.0.0.1:${(pageServer.address() as { port: number }).port}`;

type JobFact = { id: string; label: string; command: string; state: string; starts: number; crashes: number; lastExit?: string; alive: boolean; log: string };

/** The bot's background jobs as the server keeps them, whether each process is alive, and the end of its log. */
function jobsOf(dataDir: string, botId: string): JobFact[] {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, "jobs.json"), "utf8")) as { jobs?: Array<Record<string, unknown>> };
    return (raw.jobs ?? []).filter((job) => job.botId === botId).map((job) => {
      let alive = false;
      try { if (typeof job.pid === "number") { process.kill(job.pid, 0); alive = true; } } catch { alive = false; }
      let tail = "";
      try { tail = readFileSync(join(dataDir, "job-logs", `${String(job.id)}.log`), "utf8").slice(-600); } catch { /* no log yet */ }
      return { id: String(job.id), label: String(job.label), command: String(job.command).slice(0, 300), state: String(job.state), starts: Number(job.starts), crashes: Number(job.crashes),
        ...(job.lastExit ? { lastExit: String(job.lastExit) } : {}), alive, log: tail };
    });
  } catch { return []; }
}

const atMs = (value: unknown) => typeof value === "number" ? value : Date.parse(String(value ?? ""));

export interface TurnTiming { say: string; sentAt: number; firstVisibleMs: number | null; firstTextMs: number | null }
type Message = {
  id: string; role: string; at?: number | string; kind?: string; text?: string; card?: unknown;
  attachments?: Array<{ kind: string; path: string; name?: string; mime?: string }>;
  document?: { botId: string; id: string; title: string; kind: string; bytes: number };
  /** the harness's own read of the document card's file: its status and opening text */
  documentRead?: { status: number; text: string };
};
export interface ThreadLog { threadId: string; messages: Message[] }

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", pdf: "application/pdf", csv: "text/csv" };
const OWNER = { fromId: 501, from: "Sid" };

/** Every thread the bot has now: a webhook run or a chat app conversation may open its own. */
async function botThreads(api: ReturnType<typeof client>, botId: string): Promise<string[]> {
  const listed = await api.call("GET", "/api/bots?messages=0").catch(() => ({ bots: [] }));
  const bot = (listed.bots as Array<{ id: string; tasks?: Array<{ threadId: string }> }>).find((one) => one.id === botId);
  // the main thread holds only the bot's hello unless the conversation used it
  return (bot?.tasks ?? []).map((task) => task.threadId).filter((id) => id !== mainThreads.get(botId));
}
const mainThreads = new Map<string, string>();

/** The first bot text after `since` in any of the bot's threads. */
async function saidSince(api: ReturnType<typeof client>, botId: string, since: number): Promise<{ text: string; afterMs: number; threadId: string } | null> {
  for (const id of await botThreads(api, botId)) {
    const said = ((await api.call("GET", `/api/threads/${id}/messages?limit=50`).catch(() => ({ messages: [] }))).messages as Message[])
      .find((m) => m.role === "bot" && m.kind === "text" && atMs(m.at) > since && (m.text ?? "").trim());
    if (said) return { text: (said.text ?? "").slice(0, 600), afterMs: atMs(said.at) - since, threadId: id };
  }
  return null;
}

async function upload(base: string, name: string): Promise<string> {
  const ext = name.split(".").at(-1)!.toLowerCase();
  const mime = MIME[ext]!;
  const bytes = readFileSync(join(values.fixtures!, name));
  const image = mime.startsWith("image/");
  const path = image ? `/api/attachments?uploadId=${randomUUID()}` : `/api/files?name=${encodeURIComponent(name)}&uploadId=${randomUUID()}`;
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": mime, origin: base }, body: bytes });
  const saved = await res.json() as { path?: string; error?: string };
  if (!res.ok || !saved.path) throw new Error(`upload ${name} -> ${res.status}: ${saved.error ?? "?"}`);
  const attr = (v: string) => v.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return image ? `<attached-image path="${attr(saved.path)}" name="${attr(name)}" />` : `<attached-file path="${attr(saved.path)}" name="${attr(name)}" />`;
}

const TERMINAL = ["needs-input", "completed", "failed", "stalled", "idle"];

async function waitIdle(api: ReturnType<typeof client>, threadId: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  await sleep(800);
  let quiet = 0;
  for (;;) {
    const job = await api.call("GET", `/api/threads/${threadId}/job?scope=turn`).catch(() => ({ state: "unreachable" }));
    if (TERMINAL.includes(job.state)) {
      // a queued follow-up can start right after a turn ends: settle only on two quiet reads in a row
      if (++quiet >= 2) return job.state;
    } else quiet = 0;
    if (Date.now() > deadline) return `timeout(${job.state})`;
    await sleep(700);
  }
}

async function converse(srv: StressServer, frames: Frame[], job: { key: string; run: number; scenario: Scenario }) {
  const api = client(srv.url);
  const { scenario } = job;
  const started = Date.now();
  const bot = await api.createBot("Sage", values.model!);
  mainThreads.set(bot.id, bot.threadId);
  const tgToken = `${randomInt(7_000_000, 7_999_999)}:AAH${randomBytes(24).toString("base64url").slice(0, 32)}`;
  if (scenario.browser) await api.call("PATCH", `/api/bots/${bot.id}`, { computer: "browser", browser: true });
  let threadId = await api.newThread(bot.id);
  const threads = [threadId];
  const timings: Array<TurnTiming & { threadId: string; state?: string; totalMs?: number }> = [];
  const states: string[] = [];
  const turnTimeout = scenario.long ? 600_000 : 300_000;
  const pagePath = `/order/${randomUUID().slice(0, 8)}`;
  const live = scenario.live ?? (scenario.localPage ? "page" : undefined);
  const liveWait = scenario.liveWaitMs ?? Number(values["live-wait"]);
  if (live === "page") pages.set(pagePath, { status: "PROCESSING", hits: 0 });
  for (let i = 0; i < scenario.turns.length; i++) {
    const turn = scenario.turns[i]!;
    if (turn.newThread) {
      await sleep(4_000);
      threadId = await api.newThread(bot.id);
      threads.push(threadId);
    }
    const parts = [turn.say.replaceAll("{{PAGE}}", `${pageBase}${pagePath}`).replaceAll("{{TG_TOKEN}}", tgToken)];
    for (const name of turn.attach ?? []) parts.push(await upload(srv.url, name));
    const sentAt = Date.now();
    await api.call("POST", `/api/bots/${bot.id}/messages`, { text: parts.join("\n\n"), threadId, sendId: randomUUID() });
    timings.push({ say: turn.say, sentAt, firstVisibleMs: null, firstTextMs: null, threadId });
    const next = scenario.turns[i + 1];
    if (next?.afterMs !== undefined && !next.newThread) {
      await sleep(next.afterMs);
      continue;
    }
    const state = await waitIdle(api, threadId, turnTimeout);
    states.push(state);
    const end = Date.now();
    for (const timing of timings.filter((t) => t.totalMs === undefined)) { timing.totalMs = end - timing.sentAt; timing.state = state; }
    if (state.startsWith("timeout")) break;
  }
  await sleep(1_500);
  // first words on screen: a streamed delta or a posted bot text, after the message was sent and before the next one
  for (let i = 0; i < timings.length; i++) {
    const t = timings[i]!;
    const until = timings[i + 1]?.sentAt ?? Infinity;
    const mine = frames.filter((f) => f.threadId === t.threadId && f.at >= t.sentAt && f.at < until);
    const text = mine.find((f) => f.kind === "message" && f.data.message?.role === "bot" && f.data.message?.kind === "text" && (f.data.message.text ?? "").trim());
    const delta = mine.find((f) => f.kind === "runtime" && f.data.event?.type === "content.delta" && f.data.event?.streamKind === "assistant_text");
    t.firstTextMs = text ? text.at - t.sentAt : null;
    const visible = [text?.at, delta?.at].filter((v): v is number => typeof v === "number");
    t.firstVisibleMs = visible.length ? Math.min(...visible) - t.sentAt : null;
  }
  // the live check: make the thing happen that only a running watch, automation or chat app sees, and wait for the bot
  let liveCheck: Record<string, unknown> | undefined;
  if (live) {
    const jobsBefore = jobsOf(srv.dataDir, bot.id);
    const page = live === "page" ? pages.get(pagePath)! : null;
    const hitsBefore = page?.hits ?? 0;
    await sleep(5_000);
    const flipAt = Date.now();
    const extra: Record<string, unknown> = {};
    let notified: { text: string; afterMs: number; threadId?: string } | null = null;
    if (live === "page") page!.status = "SHIPPED";
    if (live === "tg-watch") for (const one of scenario.tgPush ?? []) telegram.message(tgToken, { fromId: 900 + one.from.length, from: one.from, text: one.text, chatTitle: one.chat });
    if (live === "webhook") {
      const hooks = (await api.call("GET", "/api/webhooks").catch(() => ({ webhooks: [] }))).webhooks as Array<{ id: string; botId?: string; name?: string }>;
      const hook = hooks.find((one) => one.botId === bot.id) ?? hooks.at(-1);
      extra.webhooks = hooks.map((one) => ({ id: one.id, botId: one.botId, name: one.name }));
      if (hook) {
        const address = await api.call("GET", `/api/webhooks/${hook.id}/address`).catch((error: Error) => ({ error: error.message }));
        const credential = address.credential as { url?: string; bearer?: string } | undefined;
        if (credential?.url) {
          const posted = await fetch(credential.url, { method: "POST", headers: { "content-type": "application/json", ...(credential.bearer ? { authorization: `Bearer ${credential.bearer}` } : {}) }, body: JSON.stringify(scenario.webhookBody ?? {}) }).catch(() => null);
          extra.webhookPost = posted?.status ?? "unreachable";
        } else extra.webhookPost = `no address: ${JSON.stringify(address).slice(0, 200)}`;
      } else extra.webhookPost = "no webhook automation exists";
    }
    if (live === "tg-chat") {
      const said = (await Promise.all(threads.map((id) => api.call("GET", `/api/threads/${id}/messages?limit=100`).then((r) => r.messages as Message[]).catch(() => [] as Message[])))).flat()
        .filter((m) => m.role === "bot").map((m) => m.text ?? "").join("\n");
      const code = /start=([\w-]{4,64})/.exec(said)?.[1] ?? /\/start\s+([\w-]{4,64})/.exec(said)?.[1] ?? null;
      extra.pairCode = code ? "found in chat" : "not in chat";
      const connected = telegram.calls.some((call) => call.token === tgToken && call.method === "getMe");
      extra.telegramConnected = connected;
      if (code) {
        telegram.message(tgToken, { ...OWNER, text: `/start ${code}` });
        await sleep(6_000);
        const asked = Date.now();
        telegram.message(tgToken, { ...OWNER, text: scenario.tgAsk ?? "hi" });
        const deadline = asked + liveWait;
        while (!notified && Date.now() < deadline) {
          await sleep(3_000);
          const reply = telegram.sent(tgToken).filter((call) => call.at > asked).map((call) => String(call.params.text ?? "")).filter((text) => text.trim() && !text.startsWith("Connected."));
          if (reply.length) notified = { text: reply.join(" | ").slice(0, 600), afterMs: Date.now() - asked };
        }
        extra.telegramSent = telegram.sent(tgToken).map((call) => String(call.params.text ?? "").slice(0, 200));
      }
    } else {
      const deadline = flipAt + liveWait;
      while (!notified && Date.now() < deadline) {
        await sleep(5_000);
        notified = await saidSince(api, bot.id, flipAt);
      }
    }
    for (const id of await botThreads(api, bot.id)) if (!threads.includes(id)) threads.push(id);
    if (notified) await waitIdle(api, notified.threadId ?? threadId, 120_000);
    liveCheck = { kind: live, ...(page ? { pageHitsBeforeChange: hitsBefore, pageHitsAfterChange: page.hits - hitsBefore } : {}), jobsBefore: jobsBefore.map(({ log: _log, ...job }) => job),
      jobsAfter: jobsOf(srv.dataDir, bot.id), ...extra, notified: notified !== null, ...(notified ? { notifiedAfterMs: notified.afterMs, notice: notified.text } : { waitedMs: liveWait }) };
    pages.delete(pagePath);
  }
  const threadLogs: ThreadLog[] = [];
  if (!live) for (const id of await botThreads(api, bot.id)) if (!threads.includes(id)) threads.push(id);
  for (const id of threads) {
    const messages = (await api.call("GET", `/api/threads/${id}/messages?limit=300`)).messages as Message[];
    if (messages.length || id === threads[0]) threadLogs.push({ threadId: id, messages });
  }
  for (const message of threadLogs.flatMap((t) => t.messages)) {
    if (!message.document) continue;
    const res = await fetch(`${srv.url}/api/bots/${message.document.botId}/documents/${message.document.id}`, { headers: { origin: srv.url } }).catch(() => null);
    const doc = await res?.json().catch(() => null) as { content?: string } | null;
    message.documentRead = { status: res?.status ?? 0, text: String(doc?.content ?? "").slice(0, 4_000) };
  }
  const runtime = frames.filter((f) => threads.includes(f.threadId ?? "") && f.kind === "runtime").map((f) => f.data.event);
  const tools = runtime.filter((e) => e?.type === "item.started" && e.itemType === "tool").map((e) => {
    const inner = /"name"\s*:\s*"([\w.-]+)"/.exec(String(e.input ?? ""))?.[1];
    return `${String(e.title ?? "?")}${String(e.title).endsWith("use_tool") && inner ? `:${inner}` : ""}`;
  });
  const runtimeErrors = runtime.filter((e) => e?.type === "runtime.error" || e?.type === "runtime.notice" || e?.type === "turn.retrying").map((e) => `${e.type}: ${String(e.message ?? e.reason ?? "").slice(0, 300)}`);
  const routines = (await api.call("GET", "/api/routines").catch(() => ({ routines: [] }))).routines
    .filter((r: { botId: string }) => r.botId === bot.id)
    .map((r: { name: string; prompt: string; enabled: boolean; schedule: unknown; checks?: unknown[]; checkedAt?: number; checkTrouble?: string; lastRunAt?: unknown }) =>
      ({ name: r.name, enabled: r.enabled, schedule: r.schedule, prompt: r.prompt.slice(0, 700), ...(r.checks?.length ? { checks: JSON.stringify(r.checks).slice(0, 400) } : {}), ...(r.checkedAt ? { checkedAt: new Date(r.checkedAt).toISOString() } : {}),
        ...(r.checkTrouble ? { checkTrouble: r.checkTrouble } : {}), ...(r.lastRunAt ? { lastRunAt: r.lastRunAt } : {}) }));
  const waitsFile = join(srv.dataDir, "waits.json");
  let waits: unknown[] = [];
  try {
    const raw = JSON.parse(readFileSync(waitsFile, "utf8"));
    const list = Array.isArray(raw) ? raw : Object.values(raw?.waits ?? raw ?? {});
    waits = (list as Array<Record<string, unknown>>).filter((w) => JSON.stringify(w).includes(bot.id)).map((w) => ({ label: w.label, kind: w.kind, state: w.state ?? w.status }));
  } catch { /* no waits */ }
  const jobFacts = jobsOf(srv.dataDir, bot.id);
  const compactions = threadLogs.flatMap((t) => t.messages).filter((m) => m.kind === "compaction").length;
  const webhooks = ((await api.call("GET", "/api/webhooks").catch(() => ({ webhooks: [] }))).webhooks as Array<Record<string, unknown>>)
    .filter((one) => one.botId === bot.id).map((one) => ({ name: one.name, enabled: one.enabled, instructions: String(one.instructions ?? one.prompt ?? "").slice(0, 200) }));
  const memory = await api.call("GET", `/api/bots/${bot.id}/memory`).then((m) => String(m.text ?? "")).catch(() => "");
  const aboutMe = await api.aboutMe().catch(() => "");
  const checked: Checked = await hardChecks(srv.url, threadLogs, timings, states, runtimeErrors);
  const verdict: Verdict = await judge(gatewayFromEnv(values.judge!), scenario, threadLogs, { tools, routines, waits, jobs: jobFacts, webhooks, compactions, ...(liveCheck ? { liveCheck } : {}), memory: memory.slice(-1500), aboutMe: aboutMe.slice(-800), checked });
  return {
    key: job.key, id: scenario.id, run: job.run, persona: scenario.persona, shape: scenario.shape, model: values.model, at: new Date().toISOString(),
    wallMs: Date.now() - started, states, timings: timings.map(({ say, firstVisibleMs, firstTextMs, totalMs, state }) => ({ say: say.slice(0, 120), firstVisibleMs, firstTextMs, totalMs, state })),
    engine, tools, runtimeErrors, routines, waits, jobs: jobFacts, webhooks, compactions, ...(liveCheck ? { liveCheck } : {}), checked, verdict, dataDir: srv.dataDir, memory: memory.slice(-1500), aboutMe: aboutMe.slice(-800),
    transcript: threadLogs.map((t) => t.messages.filter((m) => m.kind === "text" || (m.role === "bot" && m.kind !== "activity" && m.kind !== "digest")).map((m) => ({
      role: m.role, kind: m.kind, text: (m.text ?? "").slice(0, 4_000), ...(m.document ? { document: { title: m.document.title, kind: m.document.kind, bytes: m.document.bytes, status: m.documentRead?.status } } : {}), attachments: (m.attachments ?? []).map((a) => ({ kind: a.kind, name: a.name ?? a.path.split("/").at(-1) })),
    }))),
  };
}

function serverErrors(srv: StressServer, label: string): void {
  try {
    const lines = readFileSync(srv.logPath, "utf8").split("\n").filter((line) => /\b(error|uncaught|unhandled|exception|ECONNRESET|EADDRINUSE|failed)\b/i.test(line));
    for (const line of lines) appendFileSync(join(out, "server-errors.jsonl"), `${JSON.stringify({ server: label, line: line.slice(0, 600) })}\n`);
  } catch { /* no log */ }
}

async function worker(index: number): Promise<void> {
  const perServer = Number(values.recycle);
  const parallel = Number(values.parallel);
  while (jobs.length) {
    const batch = jobs.splice(0, perServer);
    const label = `w${index}-${Date.now()}`;
    let srv: StressServer;
    try {
      srv = await launchServer(values.repo!, values.tmp!, gateway, [values.model!],
        values["compact-at"] ? { context: { compactAt: Number(values["compact-at"]) } } : {}, undefined, { engine, env: { DUSK_TELEGRAM_API_URL: telegram.origin } });
    } catch (error) {
      log("server failed to start", (error as Error).message);
      jobs.unshift(...batch);
      await sleep(10_000);
      continue;
    }
    const frames: Frame[] = [];
    const stream = listen(srv.url, (frame) => { if (frame.kind === "message" || frame.kind === "runtime") frames.push(frame); });
    log(label, "up at", srv.url, "with", batch.length, "conversations");
    const lane = async () => {
      for (;;) {
        const job = batch.shift();
        if (!job) return;
        try {
          const result = await converse(srv, frames, job);
          appendFileSync(resultsPath, `${JSON.stringify({ ...result, server: label })}\n`);
          const v = result.verdict;
          log(job.key, v.pass ? "PASS" : "FAIL", `${Math.round(result.wallMs / 1000)}s`, v.flags.join(","), "-", v.why);
        } catch (error) {
          appendFileSync(resultsPath, `${JSON.stringify({ key: job.key, id: job.scenario.id, run: job.run, persona: job.scenario.persona, shape: job.scenario.shape, server: label, crashed: (error as Error).message.slice(0, 500), verdict: { pass: false, flags: ["harness-crash"], why: (error as Error).message.slice(0, 200) } })}\n`);
          log(job.key, "CRASH", (error as Error).message);
        }
      }
    };
    await Promise.all(Array.from({ length: parallel }, lane));
    stream.close();
    serverErrors(srv, label);
    await srv.close(values.keep);
  }
}

await Promise.all(Array.from({ length: Number(values.servers) }, (_, i) => worker(i)));
log("all done; results in", resultsPath, readdirSync(out).join(", "));
pageServer.close();
await telegram.close();
