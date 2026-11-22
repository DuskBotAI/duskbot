// Workflow eval: a business owner asks a bot, in plain words, to take over a piece of their business (cases.ts). Each
// case gets its own dusk bot server (stress-eval's launcher) with fake connected apps (apps-mcp.mjs, seeded per case)
// and a bot at Full access with no computer (as a headless server runs it). A simulated owner (person.ts) answers the bot until the setup is done; then,
// in a new chat, asks what is running and asks for one change. The judge (judge.ts) grades ten dimensions against
// ground truth: automations and their runs, jobs, waits, documents, bots, and every write the fake apps saw.
//   node --experimental-strip-types scripts/workflow-eval/run.ts --tmp <dir> --out <dir> [--only id,id] [--parallel 4]
//     [--model gpt-6.2-sol] [--judge gpt-6.2-sol] [--repeat 1]
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { client } from "../memory-eval/client.ts";
import { gatewayFromEnv } from "../memory-eval/sandbox.ts";
import { launchServer, type StressServer } from "../stress-eval/server.ts";
import { startTelegram } from "../stress-eval/telegram.ts";
import { CASES, type WorkflowCase } from "./cases.ts";
import { DONE, personReply } from "./person.ts";
import { judgeWorkflow } from "./judge.ts";

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: {
  repo: { type: "string", default: resolve(here, "..", "..") },
  tmp: { type: "string" },
  out: { type: "string" },
  model: { type: "string", default: "gpt-6.2-sol" },
  judge: { type: "string", default: "gpt-6.2-sol" },
  repeat: { type: "string", default: "1" },
  parallel: { type: "string", default: "4" },
  only: { type: "string", default: "" },
  "max-setup-turns": { type: "string", default: "7" },
  keep: { type: "boolean", default: false },
} });
if (!values.tmp || !values.out) throw new Error("--tmp and --out are required");
mkdirSync(values.out, { recursive: true });
const resultsPath = join(values.out, "results.jsonl");
const log = (...parts: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...parts);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gateway = gatewayFromEnv(values.model!);
const judgeGateway = gatewayFromEnv(values.judge!);
const appsServer = join(here, "apps-mcp.mjs");
const telegram = await startTelegram();
const pages = new Map<string, string>();
const pageServer = createServer((req, res) => {
  const html = pages.get(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
  res.writeHead(html ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
  res.end(html ?? "not found");
});
await new Promise<void>((done) => pageServer.listen(0, "127.0.0.1", done));
const pageOrigin = `http://127.0.0.1:${(pageServer.address() as AddressInfo).port}`;
const OWNER = { fromId: 501, from: "Maya" };
// a person's form or store reaches the bot from the internet, as on dusk cloud or a desktop with Remote access on: the
// server advertises this public origin, and the eval's own posts to it go to the server's local receiver
const PUBLIC_HOOKS = "https://hooks.dusk.bot";
const localHook = (url: string, srv: StressServer) => url.replace(PUBLIC_HOOKS, `http://127.0.0.1:${Number(new URL(srv.url).port) + 1}`);
const pairCodes = (said: string) => [...said.matchAll(/start=([\w-]{4,64})/g), ...said.matchAll(/\/start\s+([\w-]{4,64})/g)].map((m) => m[1]!);

type Message = { id: string; role: string; kind?: string; text?: string; card?: any; tool?: { name?: string }; document?: { title: string; kind: string } ; attachments?: Array<{ name?: string; path: string }> };

const TERMINAL = ["needs-input", "completed", "failed", "stalled", "idle"];
async function waitIdle(api: ReturnType<typeof client>, threadId: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  await sleep(1_000);
  let quiet = 0;
  for (;;) {
    const job = await api.call("GET", `/api/threads/${threadId}/job?scope=turn`).catch(() => ({ state: "unreachable" }));
    if (TERMINAL.includes(job.state)) { if (++quiet >= 3) return job.state; } else quiet = 0;
    if (Date.now() > deadline) return `timeout(${job.state})`;
    await sleep(1_000);
  }
}

function render(messages: Message[]): string {
  return messages.filter((m) => m.kind === "text" || (m.role === "bot" && m.kind !== "activity" && m.kind !== "digest")).map((m) => {
    const run = m.role === "user" ? /^\[(?:Scheduled routine|Routine) ("(?:[^"\\]|\\.)*"), do this now:\]/u.exec(m.text ?? "") : null;
    if (run) return `[the app shows: automation ${run[1]} started a run here${(m.text ?? "").includes("this is a test run") ? " (test run)" : ""}]`;
    const who = m.role === "user" ? "PERSON" : m.role === "bot" ? "BOT" : m.role.toUpperCase();
    // at Full access a change applies at once and its card is a receipt (Edit, Pause, Undo), not a question
    const receipt = m.card?.dismissed === true && !(m.card.options?.length);
    if (receipt) return `[the app shows a receipt card: ${String(m.card.title ?? "").replace(/\?$/, "")}, applied]`;
    const kind = m.kind && m.kind !== "text" ? `[${m.kind} card${m.card?.title ? `: ${m.card.title}` : ""}] ` : "";
    const cardText = m.kind !== "text" && m.card ? ` ${JSON.stringify(m.card).slice(0, 400)}` : "";
    const doc = m.document ? ` [document "${m.document.title}" (${m.document.kind})]` : "";
    const files = (m.attachments ?? []).map((a) => ` [file ${a.name ?? a.path.split("/").at(-1)}]`).join("");
    return `${who}: ${kind}${(m.text ?? "").slice(0, 3_000)}${cardText}${doc}${files}`;
  }).join("\n\n");
}

const readJson = (path: string) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };

function workspaceFiles(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > 3 || !existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) workspaceFiles(path, depth + 1, out);
    else if (out.length < 40) out.push(`${path.slice(dir.length - 0)} (${st.size} B)${st.size < 1_500 && /\.(json|txt|md|csv)$/.test(name) ? `: ${readFileSync(path, "utf8").slice(0, 600)}` : ""}`);
  }
  return out;
}

async function groundTruth(srv: StressServer, api: ReturnType<typeof client>, botIds: string[], statePath: string, tools: string[]): Promise<{ text: string; data: any }> {
  const { routines, runs } = await api.call("GET", "/api/routines?since=0").catch(() => ({ routines: [], runs: [] }));
  const [webhooks, appTriggers] = await Promise.all([
    api.call("GET", "/api/webhooks").then((r) => r.webhooks ?? r).catch(() => []),
    api.call("GET", "/api/app-triggers").then((r) => r.triggers ?? []).catch(() => []),
  ]);
  const mine = [
    ...(routines as any[]),
    ...(Array.isArray(webhooks) ? webhooks : []).map((w: any) => ({ ...w, kind: "webhook", schedule: "when its address is called" })),
    ...(appTriggers as any[]).map((t: any) => ({ ...t, kind: "app_event", schedule: `when ${t.app} ${t.event}` })),
  ].filter((r) => botIds.includes(r.botId));
  const ids = new Set(mine.map((r) => r.id));
  const theirRuns = (runs as any[]).filter((r) => ids.has(r.routineId)).map((r) => ({ routine: mine.find((m) => m.id === r.routineId)?.name, status: r.status, trigger: r.trigger ?? r.kind, at: r.startedAt ?? r.scheduledFor, dryRun: r.dryRun === true, result: String(r.output ?? r.error ?? r.attention ?? "").slice(0, 600) }));
  const jobs = (readJson(join(srv.dataDir, "jobs.json"))?.jobs ?? readJson(join(srv.dataDir, "jobs.json")) ?? []);
  const jobList = (Array.isArray(jobs) ? jobs : Object.values(jobs)).filter((j: any) => botIds.includes(j.botId)).map((j: any) => ({ label: j.label, state: j.state ?? j.status, template: j.template, command: String(j.command ?? "").slice(0, 200), onNotify: String(j.onNotify ?? "").slice(0, 300) }));
  const waitsRaw = readJson(join(srv.dataDir, "waits.json"));
  const waits = (Array.isArray(waitsRaw) ? waitsRaw : Object.values(waitsRaw?.waits ?? waitsRaw ?? {})).filter((w: any) => JSON.stringify(w).includes(botIds[0]!)).map((w: any) => ({ label: w.label, kind: w.kind ?? w.check?.kind, state: w.state ?? w.status }));
  const documents = botIds.flatMap((id) => { const dir = join(srv.dataDir, "bot-documents", id); return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => readJson(join(dir, f))).filter(Boolean).map((d: any) => ({ title: d.title, kind: d.kind, content: String(d.content ?? "").slice(0, 500) })) : []; });
  const bots = ((await api.call("GET", "/api/bots?messages=0").catch(() => ({ bots: [] }))).bots as any[]).map((b) => ({ id: b.id, name: b.name, title: b.title }));
  const files = botIds.flatMap((id) => workspaceFiles(join(srv.dataDir, "workspaces", id)).map((f) => `${id.slice(0, 6)}${f}`));
  const apps = readJson(statePath) ?? {};
  const appsSummary = {
    drafts: (apps.drafts ?? []).map((d: any) => ({ to: d.to, subject: d.subject, reply_to: d.reply_to_message_id, body: String(d.body).slice(0, 160) })),
    sent: (apps.sent ?? []).map((d: any) => ({ to: d.to, cc: d.cc, subject: d.subject, reply_to: d.reply_to_message_id, at: d.at, body: String(d.body).slice(0, 160), ...(d.attachments?.length ? { attachments: d.attachments } : {}) })),
    sheets: Object.values(apps.sheets ?? {}).map((s: any) => ({ title: s.title, headers: s.headers, rows: s.rows.length, first_rows: s.rows.slice(0, 6) })),
    calendar_created: (apps.events ?? []).filter((e: any) => String(e.id).startsWith("evt_")).map((e: any) => ({ title: e.title, start: e.start, attendees: e.attendees })),
    labels_changed: (apps.log ?? []).filter((l: any) => l.action === "modify").length,
    app_calls: Object.entries((apps.calls ?? []).reduce((t: Record<string, number>, c: any) => ({ ...t, [c.tool]: (t[c.tool] ?? 0) + 1 }), {})),
  };
  const data = {
    automations: mine.map((r) => ({ name: r.name, bot: r.botId === botIds[0] ? "main" : bots.find((b) => b.id === r.botId)?.name, enabled: r.enabled, schedule: r.schedule, kind: r.kind ?? "schedule", checks: r.checks, instructions: String(r.prompt ?? "").slice(0, 4_000) })),
    runs: theirRuns, jobs: jobList, waits, documents, bots, workspace_files: files, apps: appsSummary, tools_used: tools,
  };
  return { text: JSON.stringify(data, null, 1), data };
}

async function runCase(c: WorkflowCase, run: number): Promise<Record<string, unknown>> {
  const caseDir = join(values.tmp!, `${c.id}-${run}-${randomUUID().slice(0, 6)}`);
  mkdirSync(caseDir, { recursive: true });
  const statePath = join(caseDir, "apps-state.json");
  writeFileSync(statePath, JSON.stringify({ mail: [], ...c.seed }, null, 2));
  const tgToken = `${randomInt(7_000_000, 7_999_999)}:AAH${randomBytes(24).toString("base64url").slice(0, 32)}`;
  const pageKey = `/${c.id}-${run}-${randomUUID().slice(0, 6)}`;
  for (const [name, html] of Object.entries(c.telegram?.pages ?? {})) pages.set(`${pageKey}/${name}/pricing`, html);
  const fill = (text: string) => text.replaceAll("{{TG_TOKEN}}", tgToken).replace(/\{\{PAGE:(\w+)\}\}/g, (_, name: string) => `${pageOrigin}${pageKey}/${name}/pricing`);
  c = { ...c, ask: fill(c.ask), brief: fill(c.brief), change: fill(c.change) };
  const mcpServers = Object.fromEntries(c.apps.map((app) => [app, { command: process.execPath, args: [appsServer, app], env: { BIZ_STATE: statePath } }]));
  // two eval processes can pick the same free port pair at once: the loser exits on EADDRINUSE and tries again
  const launch = async (reuseRoot?: string): Promise<StressServer> => {
    for (let attempt = 0; ; attempt++) {
      try { return await launchServer(values.repo!, caseDir, gateway, [values.model!], { mcpServers }, reuseRoot, { env: { DUSK_TELEGRAM_API_URL: telegram.origin, DUSK_PROBE_LOOPBACK_ORIGIN: pageOrigin, DUSK_WEBHOOK_PUBLIC_URL: PUBLIC_HOOKS } }); }
      catch (error) { if (attempt >= 4) throw error; await sleep(2_000 + Math.random() * 6_000); }
    }
  };
  let srv = await launch();
  const started = Date.now();
  let api = client(srv.url);
  const restartNotes: string[] = [];
  const fireNotes: string[] = [];
  const tools: string[] = [];
  try {
    const bot = await api.createBot("Sage", values.model!);
    // an automation the bot just ran (a test run) reports in the chat: let it land before the person answers
    const runsSettled = async () => {
      const deadline = Date.now() + 420_000;
      while (Date.now() < deadline) {
        const [{ routines, runs }, hooks] = await Promise.all([
          api.call("GET", "/api/routines?since=0").catch(() => ({ routines: [], runs: [] })),
          api.call("GET", "/api/webhooks").then((r) => r.webhooks ?? []).catch(() => []),
        ]);
        const ids = new Set([...(routines as any[]), ...(hooks as any[])].filter((r) => r.botId === bot.id).map((r) => r.id));
        if (!(runs as any[]).some((r) => ids.has(r.routineId) && ["queued", "running", "waiting"].includes(r.status))) return;
        await sleep(5_000);
      }
    };
    const say = async (threadId: string, text: string) => {
      await api.call("POST", `/api/bots/${bot.id}/messages`, { text, threadId, sendId: randomUUID() });
      const state = await waitIdle(api, threadId, 900_000);
      await runsSettled();
      return state;
    };
    const messages = async (threadId: string): Promise<Message[]> => (await api.call("GET", `/api/threads/${threadId}/messages?limit=400`)).messages;
    const setupThread = await api.newThread(bot.id);
    const states: string[] = [];
    // the owner taps Start on a pairing link the moment the bot gives it, as a person with the phone in hand would
    const tapped = new Set<string>();
    const tapStart = async () => {
      if (!c.telegram) return;
      const said = (await messages(setupThread)).filter((m) => m.role === "bot").map((m) => `${m.text ?? ""} ${JSON.stringify(m.card ?? "")}`).join("\n");
      const code = pairCodes(said).filter((one) => !tapped.has(one)).at(-1);
      if (!code) return;
      tapped.add(code);
      telegram.message(tgToken, { ...OWNER, text: `/start ${code}` });
      await sleep(6_000);
    };
    states.push(await say(setupThread, c.ask));
    await tapStart();
    for (let i = 0; i < Number(values["max-setup-turns"]); i++) {
      const next = await personReply(gateway, c, render(await messages(setupThread)));
      if (next.includes(DONE)) break;
      states.push(await say(setupThread, next));
      await tapStart();
    }
    await sleep(5_000);
    if (c.restart) {
      // the server stops mid-workflow and starts again on the same data; then new items arrive and each automation's
      // time comes, so its next run has to continue from what the earlier ones kept
      await srv.close(true);
      srv = await launch(srv.root);
      api = client(srv.url);
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      state.mail = [...(state.mail ?? []), ...c.restart.arrive.map((mail) => ({ ...mail, date: new Date().toISOString() }))];
      writeFileSync(statePath, JSON.stringify(state, null, 2));
      const { routines } = await api.call("GET", "/api/routines?since=0");
      const due = (routines as any[]).filter((r) => r.botId === bot.id && r.enabled && r.schedule?.type !== "once");
      for (const routine of due) await api.call("POST", `/api/routines/${routine.id}/run`, {}).catch((error: Error) => restartNotes.push(`could not run ${routine.name}: ${error.message}`));
      await sleep(3_000);
      await runsSettled();
      restartNotes.push(`the server restarted at ${new Date().toISOString()}, ${c.restart.arrive.length} new emails arrived (${c.restart.arrive.map((m) => m.subject).join("; ")}), and these automations then ran once as if their time had come: ${due.map((r) => r.name).join(", ") || "none existed"}`);
    }
    if (c.fire) {
      const hooks = ((await api.call("GET", "/api/webhooks").catch(() => ({ webhooks: [] }))).webhooks ?? []) as Array<{ id: string; botId?: string; name?: string }>;
      const hook = hooks.find((one) => one.botId === bot.id);
      let posted: string;
      if (!hook) posted = "no webhook automation exists, so nothing was posted";
      else {
        const address = await api.call("GET", `/api/webhooks/${hook.id}/address`).catch((error: Error) => ({ error: error.message }));
        const credential = address.credential as { url?: string; bearer?: string } | undefined;
        const res = credential?.url ? await fetch(localHook(credential.url, srv), { method: "POST", headers: { "content-type": "application/json", ...(credential.bearer ? { authorization: `Bearer ${credential.bearer}` } : {}) }, body: JSON.stringify(c.fire.body) }).catch(() => null) : null;
        posted = credential?.url ? `posted ${JSON.stringify(c.fire.body)} to the webhook "${hook.name}" (HTTP ${res?.status ?? "unreachable"})` : `the webhook "${hook.name}" gave no address: ${JSON.stringify(address).slice(0, 200)}`;
      }
      await sleep(8_000);
      await runsSettled();
      fireNotes.push(`after setup the eval ${posted} at ${new Date().toISOString()} and waited for the run`);
    }
    if (c.telegram) {
      const said = (await messages(setupThread)).filter((m) => m.role === "bot").map((m) => `${m.text ?? ""} ${JSON.stringify(m.card ?? "")}`).join("\n");
      const code = pairCodes(said).at(-1) ?? null;
      const connected = telegram.calls.some((call) => call.token === tgToken && call.method === "getMe");
      if (code && !tapped.has(code)) { tapped.add(code); telegram.message(tgToken, { ...OWNER, text: `/start ${code}` }); await sleep(8_000); }
      const flipAt = Date.now();
      pages.set(`${pageKey}/${c.telegram.change.page}/pricing`, c.telegram.change.html);
      let pinged: string[] = [];
      while (!pinged.length && Date.now() < flipAt + 420_000) {
        await sleep(5_000);
        pinged = telegram.sent(tgToken).filter((call) => call.at > flipAt).map((call) => String(call.params.text ?? "")).filter((text) => text.trim() && !text.startsWith("Connected."));
      }
      fireNotes.push(`the bot's Telegram token was ${connected ? "used with the fake Telegram" : "never used"}; the pairing code was ${code ? "in the chat, and the owner sent /start with it" : "not in the chat, so the owner could not pair"}; then the eval changed the ${c.telegram.change.page} page (Pro $39 to $29) at ${new Date(flipAt).toISOString()} and waited up to 7 minutes: ${pinged.length ? `Telegram messages to the owner after the change: ${JSON.stringify(pinged).slice(0, 600)}` : "no Telegram message came"}; every Telegram message the bot sent: ${JSON.stringify(telegram.sent(tgToken).map((call) => String(call.params.text ?? "").slice(0, 160))).slice(0, 900)}`);
    }
    const laterThread = await api.newThread(bot.id);
    states.push(await say(laterThread, "what's running for me right now? list everything you set up, when it runs and how the last run went"));
    states.push(await say(laterThread, c.change));
    await sleep(3_000);
    const botIds = [bot.id, ...((await api.bots()).filter((b) => b.id !== bot.id && b.name !== "Sage").map((b) => b.id))];
    const setupMessages = await messages(setupThread);
    const laterMessages = await messages(laterThread);
    for (const m of [...setupMessages, ...laterMessages]) if (m.kind === "activity" && m.tool?.name) tools.push(String(m.tool.name).slice(0, m.tool.name.startsWith("error") ? 400 : 60));
    const truth = await groundTruth(srv, api, botIds, statePath, tools);
    if (restartNotes.length) truth.text = `RESTART: ${restartNotes.join(" ")}\n${truth.text}`;
    if (fireNotes.length) truth.text = `FIRED: ${fireNotes.join(" ")}\n${truth.text}`;
    const setupChat = render(setupMessages);
    const laterChat = render(laterMessages);
    const verdict = await judgeWorkflow(judgeGateway, c, setupChat, laterChat, truth.text);
    return { key: `${c.id}#${run}`, id: c.id, dept: c.dept, run, model: values.model, at: new Date().toISOString(), wallMs: Date.now() - started, states, verdict, truth: truth.data, setupChat, laterChat };
  } finally {
    await srv.close(values.keep);
  }
}

const done = new Set(existsSync(resultsPath) ? readFileSync(resultsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).key as string) : []);
const only = values.only ? new Set(values.only.split(",")) : null;
const queue: Array<{ c: WorkflowCase; run: number }> = [];
for (let run = 1; run <= Number(values.repeat); run++) for (const c of CASES) if ((!only || only.has(c.id)) && !done.has(`${c.id}#${run}`)) queue.push({ c, run });
log(`${queue.length} cases to run`);
await Promise.all(Array.from({ length: Number(values.parallel) }, async () => {
  for (;;) {
    const job = queue.shift();
    if (!job) return;
    try {
      const result = await runCase(job.c, job.run);
      appendFileSync(resultsPath, `${JSON.stringify(result)}\n`);
      const v = result.verdict as { score: number; dims: Record<string, boolean>; why: string };
      log(result.key, `score ${v.score}`, Object.entries(v.dims).filter(([, ok]) => !ok).map(([k]) => k).join(",") || "all dims", "-", v.why);
    } catch (error) {
      appendFileSync(resultsPath, `${JSON.stringify({ key: `${job.c.id}#${job.run}`, id: job.c.id, crashed: (error as Error).message.slice(0, 500), verdict: { score: 0, dims: {}, gaps: ["harness crash"], why: (error as Error).message.slice(0, 200) } })}\n`);
      log(job.c.id, "CRASH", (error as Error).message);
    }
  }
}));
log("done:", resultsPath);
await telegram.close();
pageServer.close();
