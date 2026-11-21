#!/usr/bin/env -S node --experimental-strip-types
// Real-engine reply latency on an isolated fixture: each engine answers quick questions through the local model gateway
// (MCHAT_API_KEY, as the memory eval reads it), behind a timing proxy, with the engine CLI wrapped by
// testing/bench-engine-stamp.mjs. A turn is split into: send -> POST answered -> engine spawned -> engine ready (MCP
// servers up) -> first model request -> model's first byte -> engine's first text -> first text frame on /api/events
// (the bubble the app draws) -> turn.completed. Costs a few cents per run; never part of a test suite.
//   node --experimental-strip-types scripts/bench-engines.ts [--engines claude,codex,grokBuild,opencode,openai]
//     [--runs 5] [--mode cold,warm,idle] [--set quick|work|remind|mixed|setup] [--effort low] [--server built|ts] [--idle-ms N] [--json FILE]
//     [--keep] [--trace] [--dump-dir DIR] [--engine-args claude:--debug] [--claude-as gpt-6.2-sol]
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { createServer, request as httpRequest, Agent as HttpAgent, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { gatewayFromEnv } from "./memory-eval/sandbox.ts";
import { freePortBlock } from "../server/testing/ports.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const { values: opts } = parseArgs({
  options: {
    engines: { type: "string", default: "claude,codex,grokBuild,opencode,openai" },
    runs: { type: "string", default: "5" },
    mode: { type: "string", default: "cold,warm" },
    "idle-ms": { type: "string" },
    question: { type: "string" },
    set: { type: "string", default: "quick" },
    json: { type: "string" },
    keep: { type: "boolean", default: false },
    trace: { type: "boolean", default: false },
    env: { type: "string", multiple: true },
    "claude-as": { type: "string", default: "gpt-6.2-sol" },
    server: { type: "string", default: "built" },
    "engine-args": { type: "string" },
    "dump-dir": { type: "string" },
    effort: { type: "string" },
  },
});

const QUESTIONS = [
  "What is 18% of 2,450?",
  "How many minutes are in 3.5 hours?",
  "What's the capital of Australia?",
  "Is 91 a prime number?",
  "What is 15 times 24?",
  "How many days are in a leap year?",
  "Convert 30 degrees Celsius to Fahrenheit.",
  "What is 7 squared plus 5?",
];

// work asks: the ack the harness posts while the engine starts on real work, then the result
const WORK = [
  "Look up today's weather in Tokyo and Paris and tell me which is warmer.",
  "Find the current population of Delhi and Mumbai and compare them in one line.",
  "Search for the release year of the first iPhone and the first Android phone.",
  "Check what the tallest building in Europe is and how tall it is.",
  "Look up the exchange rate from US dollars to euros today.",
  "Find out who won the most recent FIFA World Cup and where it was held.",
];

// reminders: one-off and recurring automations, the commonest ask that runs tools
const REMIND = [
  "Remind me tomorrow at 9am to call mom.",
  "Remind me in 2 hours to take the laundry out.",
  "Every weekday at 8am send me a short motivational quote.",
  "Remind me on Friday at 6pm to pay the electricity bill.",
  "Remind me next Monday at 10am to book a dentist appointment.",
  "Every Sunday at 7pm remind me to plan my week.",
];

// the stress eval's slowest first words: watches, routines, charts and changes that run several tools before replying
const SETUP = [
  "Tell me when the price of the Sony WH-1000XM5 on amazon.in drops below ₹20,000.",
  "Every Monday at 9am give me a summary of the week's top AI news in 5 bullets.",
  "Let me know when https://example.com changes.",
  "Every morning at 7:30 send me a weather summary for Pune and Mumbai.",
  "Find the current prices of Bitcoin, Ethereum and Solana and give me a short table.",
  "Remind me at 7 to call grandma.",
  "Look up the population of Tokyo, Delhi and Shanghai and tell me which grew fastest since 2010.",
  "Make it 9:30 instead, and skip Fridays.",
];

// alternating quick questions and short asks the router counts as work (no tools needed): quick, work, quick, ...
const MIXED = [
  "What is 15 times 24?",
  "Write a two-line poem about rain.",
  "How many days are in a leap year?",
  "Translate 'good morning' into French and Spanish.",
  "What's the capital of Australia?",
  "Summarize what photosynthesis is in one sentence.",
  "Is 91 a prime number?",
  "Draft a one-line birthday wish for a friend.",
  "What is 18% of 2,450?",
  "Write a one-sentence tip for better sleep.",
];

const which = (name: string) => { try { return execFileSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim(); } catch { return ""; } };
const realCli = (name: string, fallback: string[] = []) => [...fallback, which(name)].find((path) => path && existsSync(path)) ?? "";

interface EngineSpec {
  id: string;
  instance: Record<string, unknown>;
  model: string;
  cli?: string;
  setup?: (home: string) => void;
}

const gateway = gatewayFromEnv("unused");
const median = (values: number[]) => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : NaN; };
const round = (value: number) => Math.round(value);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ModelCall { at: number; firstByte: number; end: number; path: string; bytes: number; model: string; cacheRead: number; input: number; status: number }
const calls: ModelCall[] = [];

async function startProxy(): Promise<{ url: string; close(): void }> {
  const upstream = new URL(gateway.url.replace(/\/v1$/, ""));
  const agent = new HttpAgent({ keepAlive: true });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const at = Date.now();
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      let model = "";
      try {
        const parsed = JSON.parse(body.toString("utf8"));
        model = parsed.model ?? "";
        // the gateway's Claude sign-in is not usable, so Claude Code's requests are answered by the same model as the others
        if (model.startsWith("claude-") && opts["claude-as"]) { model = parsed.model = opts["claude-as"]; body = Buffer.from(JSON.stringify(parsed)); }
      } catch {}
      const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: upstream.host, "content-length": String(body.length) };
      for (const key of ["authorization", "x-api-key"]) if (headers[key]) headers[key] = key === "authorization" ? `Bearer ${gateway.key}` : gateway.key;
      if (opts["dump-dir"]) writeFileSync(join(opts["dump-dir"], `${at}-${model}.json`), body);
      const call: ModelCall = { at, firstByte: NaN, end: NaN, path: req.url ?? "", bytes: body.length, model, cacheRead: 0, input: 0, status: 0 };
      const out = httpRequest({ host: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers, agent }, (up) => {
        call.status = up.statusCode ?? 0;
        res.writeHead(up.statusCode ?? 502, up.headers);
        let tail = "";
        up.on("data", (chunk: Buffer) => {
          if (Number.isNaN(call.firstByte)) call.firstByte = Date.now();
          tail = (tail + chunk.toString("utf8")).slice(-20_000);
          res.write(chunk);
        });
        up.on("end", () => {
          call.end = Date.now();
          const read = [...tail.matchAll(/"(?:cache_read_input_tokens|cached_tokens)"\s*:\s*(\d+)/g)].map((m) => Number(m[1]));
          const input = [...tail.matchAll(/"(?:input_tokens|prompt_tokens)"\s*:\s*(\d+)/g)].map((m) => Number(m[1]));
          call.cacheRead = read.length ? Math.max(...read) : 0;
          call.input = input.length ? Math.max(...input) : 0;
          if (req.method === "POST") calls.push(call);
          res.end();
        });
      });
      out.on("error", (error) => { res.writeHead(502); res.end(String(error)); });
      out.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

function engineSpecs(proxy: string, dataDir: string): EngineSpec[] {
  const stamp = join(dataDir, "..", "engine-stamp.sh");
  const specs: EngineSpec[] = [
    {
      id: "claude", model: "claude-sonnet-5", cli: realCli("claude", [join(process.env.HOME!, ".local", "bin", "claude")]),
      instance: { driver: "claudeAgent", displayName: "Claude Code", config: { cli: stamp, requireApiKey: true },
        environment: { ANTHROPIC_API_KEY: "bench", ANTHROPIC_AUTH_TOKEN: "bench", ANTHROPIC_BASE_URL: proxy, ANTHROPIC_MODEL: "claude-sonnet-5" } },
    },
    {
      id: "codex", model: "gpt-6.2-sol", cli: realCli("codex"),
      instance: { driver: "codex", displayName: "Codex", config: { cli: stamp, managed: { url: `${proxy}/v1`, models: ["gpt-6.2-sol"] } },
        environment: { DUSK_COMPANY_API_KEY: "bench", CODEX_HOME: join(dataDir, "codex-home") } },
      setup: () => mkdirSync(join(dataDir, "codex-home"), { recursive: true }),
    },
    {
      id: "grokBuild", model: "gw-grok", cli: realCli("grok"),
      instance: { driver: "grokAgent", displayName: "Grok Build", config: { cli: stamp }, environment: { GROK_HOME: join(dataDir, "grok-home") } },
      setup: () => {
        mkdirSync(join(dataDir, "grok-home"), { recursive: true });
        writeFileSync(join(dataDir, "grok-home", "config.toml"), [
          "[models]", 'default = "gw-grok"', "",
          "[model.gw-grok]", 'model = "gpt-6.2-sol"', `base_url = "${proxy}/v1"`, 'name = "Gateway Grok"',
          'api_backend = "chat_completions"', 'api_key = "bench"', "",
        ].join("\n"));
        // Grok Build answers ACP only with a grok.com sign-in (cached_token), even for a model on its own base_url. A copy
        // is used only while its token is good for another hour, so grok never refreshes (and rotates) it from the copy.
        const own = join(process.env.HOME!, ".grok", "auth.json");
        const sessions = existsSync(own) ? Object.values(JSON.parse(readFileSync(own, "utf8")) as Record<string, { expires_at?: string }>) : [];
        if (sessions.some((session) => Date.parse(session.expires_at ?? "") > Date.now() + 3_600_000)) copyFileSync(own, join(dataDir, "grok-home", "auth.json"));
        else console.error("grokBuild: no grok.com sign-in good for another hour; its turns will fail");
      },
    },
    {
      id: "opencode", model: "gw/gpt-6.2-sol", cli: realCli("opencode", [join(process.env.HOME!, ".opencode", "bin", "opencode")]),
      instance: { driver: "opencodeGo", displayName: "OpenCode", config: { cli: stamp } },
      setup: (home) => {
        const dir = join(home, ".config", "opencode");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "opencode.json"), JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: { gw: { npm: "@ai-sdk/openai-compatible", name: "Gateway", options: { baseURL: `${proxy}/v1`, apiKey: "bench" }, models: { "gpt-6.2-sol": { name: "gpt-6.2-sol" } } } },
        }, null, 2));
      },
    },
    {
      id: "openai", model: "gpt-6.2-sol",
      instance: { driver: "openai-compat", displayName: "Gateway", config: { url: `${proxy}/v1`, key: "bench", model: "gpt-6.2-sol" } },
    },
  ];
  const wanted = new Set(opts.engines!.split(","));
  return specs.filter((spec) => wanted.has(spec.id));
}

interface Fixture { url: string; dataDir: string; child: ChildProcess; stampDir: string; logPath: string }

async function startFixture(specs: EngineSpec[], proxyUrl: string): Promise<Fixture> {
  const root = mkdtempSync(join("/tmp", "dusk-bench-engines-"));
  const dataDir = join(root, "data");
  const home = join(root, "home");
  const stampDir = join(root, "stamps");
  for (const dir of [dataDir, home, stampDir, join(dataDir, "tmp")]) mkdirSync(dir, { recursive: true });
  const ready = engineSpecs(proxyUrl, dataDir).filter((spec) => specs.some((wanted) => wanted.id === spec.id));
  writeFileSync(join(root, "engine-stamp.sh"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, "scripts", "testing", "bench-engine-stamp.mjs"))} "$@"\n`, { mode: 0o755 });
  for (const spec of ready) spec.setup?.(home);
  const instances: Record<string, unknown> = {};
  for (const spec of ready) {
    const instance = structuredClone(spec.instance) as { environment?: Record<string, string> };
    if (spec.cli) instance.environment = { ...instance.environment, BENCH_REAL_CLI: spec.cli, BENCH_STAMP_FILE: join(stampDir, `${spec.id}.ndjson`),
      ...(opts["engine-args"]?.startsWith(`${spec.id}:`) ? { BENCH_ENGINE_ARGS: opts["engine-args"].slice(spec.id.length + 1) } : {}) };
    instances[spec.id] = instance;
  }
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ features: { smartSetupChoices: false }, language: "en", instances }, null, 2), { mode: 0o600 });
  const port = await freePortBlock([0, 1], 7_400, 500);
  const pathDirs = [dirname(process.execPath), ...ready.flatMap((spec) => spec.cli ? [dirname(spec.cli)] : []), "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const env: NodeJS.ProcessEnv = {
    PATH: [...new Set(pathDirs)].join(":"), HOME: home, TMPDIR: join(dataDir, "tmp"), LANG: process.env.LANG ?? "en_US.UTF-8", TZ: process.env.TZ,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local", "share"),
    DUSK_DATA_DIR: dataDir, DUSK_PORT: String(port), DUSK_WEBHOOK_PORT: String(port + 1), DUSK_NO_TEST_BOTS: "1", DUSK_DEV_TRUST_LOCAL_BROWSER: "1", DUSK_ALLOW_REAL_ENGINES: "1", DUSK_TEST_SEALED_PATH: "1",
    DUSK_MODEL_DIR: join(tmpdir(), "duskbot-bench-models"),
    ...(opts["idle-ms"] ? { DUSK_SESSION_IDLE_MS: opts["idle-ms"], DUSK_SESSION_IDLE_MIN_MS: "1" } : {}),
  };
  for (const pair of opts.env ?? []) { const cut = pair.indexOf("="); env[pair.slice(0, cut)] = pair.slice(cut + 1); }
  const logPath = join(root, "server.log");
  const log = openSync(logPath, "a", 0o600);
  // built: the packaged server entry with its compile cache, as the desktop app runs it (pnpm build:server first)
  const entry = opts.server === "ts" ? ["--experimental-strip-types", join(ROOT, "server", "index.ts")] : [join(ROOT, "dist-server", "desktop-entry.mjs")];
  if (opts.server !== "ts") env.DUSK_SERVER_COMPILE_CACHE = join(tmpdir(), "duskbot-bench-compile-cache");
  const child = spawn(process.execPath, entry, { cwd: ROOT, env, stdio: ["ignore", log, log] });
  closeSync(log);
  const url = `http://127.0.0.1:${port}`;
  for (const deadline = Date.now() + 90_000; ;) {
    if (child.exitCode !== null) throw new Error(`server exited; see ${logPath}`);
    const ok = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) }).then((r) => r.ok).catch(() => false);
    if (ok) break;
    if (Date.now() > deadline) throw new Error(`server did not start; see ${logPath}`);
    await sleep(100);
  }
  return { url, dataDir: root, child, stampDir, logPath };
}

const keepAlive = new HttpAgent({ keepAlive: true });
function api(fixture: Fixture, method: string, path: string, body?: unknown): Promise<any> {
  const text = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${fixture.url}${path}`, { method, agent: keepAlive, headers: { "content-type": "application/json", origin: fixture.url, ...(text ? { "content-length": Buffer.byteLength(text) } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const out = Buffer.concat(chunks).toString();
        if ((res.statusCode ?? 500) >= 400) reject(new Error(`${method} ${path}: ${res.statusCode} ${out.slice(0, 300)}`));
        else resolve(out ? JSON.parse(out) : null);
      });
    });
    req.on("error", reject);
    req.end(text);
  });
}

type Listener = (frame: any, at: number) => void;
function listen(fixture: Fixture): { on(listener: Listener): () => void; close(): void } {
  const listeners = new Set<Listener>();
  const controller = new AbortController();
  void (async () => {
    const response = await fetch(`${fixture.url}/api/events`, { headers: { origin: fixture.url, accept: "text/event-stream" }, signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      const at = Date.now();
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
        const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).join("\n");
        if (!data) continue;
        try {
          const frame = JSON.parse(data);
          for (const item of Array.isArray(frame) ? frame : [frame]) for (const listener of listeners) listener(item, at);
        } catch {}
      }
    }
  })().catch(() => {});
  return { on: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }, close: () => controller.abort() };
}

interface Sample { engine: string; mode: string; question?: string; marks: Record<string, number>; ok: boolean; text: string; modelCalls: number; promptBytes: number; cacheRead: number; inputTokens: number }

const STAMP_HOPS: Record<string, { spawn: RegExp; ready: RegExp; text: RegExp }> = {
  claude: { spawn: /^spawn/, ready: /^out system:init$/, text: /^out stream_event:content_block_delta:text_delta$|^out assistant$/ },
  codex: { spawn: /^spawn app-server/, ready: /^out result thread\/(start|resume)$/, text: /^out item\/agentMessage\/delta$/ },
  grokBuild: { spawn: /^spawn/, ready: /^out result session\/(new|load|resume)$/, text: /^out session\/update:agent_message_chunk$/ },
  opencode: { spawn: /^spawn/, ready: /^out result session\/(new|load|resume)$/, text: /^out session\/update:agent_message_chunk$/ },
};

async function runTurn(fixture: Fixture, events: ReturnType<typeof listen>, engine: string, bot: { id: string }, threadId: string, mode: string, question: string): Promise<Sample> {
  const stampFile = join(fixture.stampDir, `${engine}.ndjson`);
  const marks: Record<string, number> = {};
  let text = "";
  const done = new Promise<boolean>((resolve) => {
    const off = events.on((item, at) => {
      const event = item?.kind === "runtime" ? item.event : null;
      if (event && event.threadId === threadId) {
        if (marks.firstEvent === undefined) marks.firstEvent = at;
        if (event.type === "content.delta" && event.streamKind === "assistant_text" && event.delta && marks.bubble === undefined) marks.bubble = at;
        if (event.type === "turn.completed") { marks.done = at; off(); resolve(event.payload?.state !== "failed"); }
      }
      if (item?.kind === "message" && item.threadId === threadId && item.message?.role === "bot" && item.message?.kind === "text") {
        if (marks.message === undefined) marks.message = at;
        text = item.message.text ?? text;
      }
    });
    setTimeout(() => { off(); resolve(false); }, 180_000);
  });
  const callsBefore = calls.length;
  const t0 = Date.now();
  await api(fixture, "POST", `/api/bots/${bot.id}/messages`, { text: question, threadId });
  marks.accepted = Date.now();
  const ok = await done;
  await sleep(300);
  const stamps = existsSync(stampFile) ? readFileSync(stampFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { event: string; at: number }).filter((stamp) => stamp.at >= t0) : [];
  const hops = STAMP_HOPS[engine];
  const first = (pattern: RegExp) => stamps.find((stamp) => pattern.test(stamp.event))?.at;
  if (hops) {
    const spawned = first(hops.spawn); if (spawned) marks.spawned = spawned;
    const ready = first(hops.ready); if (ready) marks.ready = ready;
    const engineText = first(hops.text); if (engineText) marks.engineText = engineText;
  }
  const turnCalls = calls.slice(callsBefore).filter((call) => call.at >= t0 && call.at <= (marks.done ?? Infinity));
  const main = [...turnCalls].sort((a, b) => b.bytes - a.bytes);
  if (main[0]) { marks.modelRequest = main[0].at; marks.modelFirstByte = main[0].firstByte; }
  if (turnCalls.length) marks.firstModelRequest = Math.min(...turnCalls.map((call) => call.at));
  if (opts.trace) console.error(`${engine}/${mode}: ${stamps.map((stamp) => `${stamp.event}@${stamp.at - t0}`).join(" | ")} || calls ${turnCalls.map((call) => `${call.model}:${call.bytes}b@${call.at - t0}->${call.firstByte - t0} cache=${call.cacheRead}/${call.input}`).join(", ")}`);
  const visible = [marks.bubble, marks.message].filter((at): at is number => at !== undefined);
  if (visible.length) marks.firstVisible = Math.min(...visible);
  const relative: Record<string, number> = {};
  for (const [key, value] of Object.entries(marks)) relative[key] = value - t0;
  return { engine, mode, marks: relative, ok, text: text.slice(0, 80), modelCalls: turnCalls.length, promptBytes: main[0]?.bytes ?? 0, cacheRead: main[0]?.cacheRead ?? 0, inputTokens: main[0]?.input ?? 0 };
}

async function waitIdle(fixture: Fixture, botId: string) {
  for (let tries = 0; tries < 300; tries += 1) {
    const bot = (await api(fixture, "GET", "/api/bots?messages=0")).bots.find((candidate: any) => candidate.id === botId);
    if (bot && !bot.busy && !bot.working && bot.status !== "working") return;
    await sleep(100);
  }
}

const HOPS = ["accepted", "spawned", "ready", "firstModelRequest", "modelRequest", "modelFirstByte", "engineText", "bubble", "message", "firstVisible", "done"] as const;
const p90 = (values: number[]) => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)]! : NaN; };

const proxy = await startProxy();
const specs = engineSpecs(proxy.url, "/nonexistent");
const fixture = await startFixture(specs, proxy.url);
const events = listen(fixture);
const samples: Sample[] = [];
const modes = opts.mode!.split(",");
console.error(`fixture ${fixture.url} data ${fixture.dataDir}`);
try {
  await sleep(1_500);
  const listed = await api(fixture, "GET", "/api/instances?fresh=1") as { instances: Array<{ instanceId: string; snapshot?: { state?: string; reason?: string } }> };
  for (const row of listed.instances) {
    if (specs.some((spec) => spec.id === row.instanceId)) console.error(`engine ${row.instanceId}: ${row.snapshot?.state ?? "?"}${row.snapshot?.reason ? ` (${row.snapshot.reason})` : ""}`);
  }
  let q = 0;
  for (const spec of specs) {
    const { bot } = await api(fixture, "POST", "/api/bots", { name: `Bench ${spec.id}`, greeting: false });
    await api(fixture, "PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: spec.id, model: spec.model, ...(opts.effort ? { effort: opts.effort } : {}) } });
    for (const mode of modes) {
      let warmThread = "";
      for (let run = 0; run < Number(opts.runs) + (mode === "warm" || mode === "idle" ? 1 : 0); run += 1) {
        const threadId = mode === "cold" || run === 0
          ? (await api(fixture, "POST", `/api/bots/${bot.id}/tasks`, { select: false })).task.threadId as string
          : warmThread;
        warmThread = threadId;
        if (mode === "idle" && run > 0) {
          // the engine closes after its idle window; a person then types for a moment before sending
          await sleep(Number(opts["idle-ms"] ?? 10_000) + 2_500);
          await sleep(1_500);
        }
        const pool = opts.set === "work" ? WORK : opts.set === "remind" ? REMIND : opts.set === "mixed" ? MIXED : opts.set === "setup" ? SETUP : QUESTIONS;
        const question = opts.question ?? pool[q++ % pool.length]!;
        const sample = await runTurn(fixture, events, spec.id, bot, threadId, mode, question);
        sample.question = question;
        if ((mode === "warm" || mode === "idle") && run === 0) { sample.mode = `${mode}-first`; }
        samples.push(sample);
        console.error(`${spec.id} ${sample.mode} #${run}: ${sample.ok ? "ok" : "FAILED"} ${HOPS.map((hop) => `${hop}=${sample.marks[hop] ?? "-"}`).join(" ")} calls=${sample.modelCalls} prompt=${sample.promptBytes}b cache=${sample.cacheRead}/${sample.inputTokens} "${sample.text}"`);
        await waitIdle(fixture, bot.id);
        await sleep(500);
      }
    }
  }
} catch (error) {
  console.error(error);
} finally {
  events.close();
  const summary: Record<string, Record<string, number>> = {};
  for (const engine of new Set(samples.map((sample) => sample.engine))) {
    for (const mode of new Set(samples.map((sample) => sample.mode))) {
      const set = samples.filter((sample) => sample.engine === engine && sample.mode === mode && sample.ok);
      if (!set.length) continue;
      const row: Record<string, number> = { n: set.length };
      for (const hop of HOPS) row[hop] = round(median(set.map((sample) => sample.marks[hop] ?? NaN)));
      row.firstVisibleP90 = round(p90(set.map((sample) => sample.marks.firstVisible ?? NaN)));
      row.doneP90 = round(p90(set.map((sample) => sample.marks.done ?? NaN)));
      row.promptKB = Math.round(median(set.map((sample) => sample.promptBytes)) / 1024);
      row.cacheRead = median(set.map((sample) => sample.cacheRead));
      row.input = median(set.map((sample) => sample.inputTokens));
      row.calls = median(set.map((sample) => sample.modelCalls));
      summary[`${engine}/${mode}`] = row;
    }
  }
  console.log(JSON.stringify(summary, null, 1));
  if (opts.json) appendFileSync(opts.json, `${JSON.stringify({ at: new Date().toISOString(), summary, samples })}\n`);
  fixture.child.kill("SIGTERM");
  await new Promise((resolve) => { fixture.child.once("exit", resolve); setTimeout(resolve, 8_000); });
  proxy.close();
  if (!opts.keep) rmSync(fixture.dataDir, { recursive: true, force: true });
  process.exit(0);
}
