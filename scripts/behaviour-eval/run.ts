// Behaviour eval: does a bot do the work instead of narrating a plan, stop when told, and never claim a change it did
// not make? A sandbox server (scripts/memory-eval/sandbox.ts) runs the checkout under test with one OpenAI-compatible
// engine pointed at the recording proxy, which forwards to the gateway; each case runs in a fresh thread. Scored by the
// tool calls the model made, timings over the app's own routes, and a judge model for what the person saw. Each case runs
// in a workspace of its own with one new bot and no test bots, so no case sees another's automations or teammates.
//   node --experimental-strip-types scripts/behaviour-eval/run.ts [--repo <checkout>] --label before --models gpt-6.1-terra,gpt-oss-120b-medium [--only id,id] [--judge gpt-6.1-terra] [--repeat 3]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { client } from "../memory-eval/client.ts";
import { gatewayFromEnv, launchSandbox } from "../memory-eval/sandbox.ts";
import { startProxy } from "../memory-eval/proxy.ts";
import { CAPABLE_CASES, CASES, type Case } from "./cases.ts";
import { judge, rowText, toolsOf, type Message } from "./judge.ts";

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: {
  repo: { type: "string", default: resolve(here, "..", "..") },
  label: { type: "string", default: "run" },
  models: { type: "string", default: "gpt-6.1-terra" },
  judge: { type: "string", default: "gpt-6.1-terra" },
  only: { type: "string", default: "" },
  keep: { type: "boolean", default: false },
  repeat: { type: "string", default: "1" },
  suite: { type: "string", default: "base" },
} });
const log = (...parts: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...parts);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const only = values.only ? new Set(values.only.split(",")) : null;
const suite = values.suite === "capable" ? CAPABLE_CASES : values.suite === "all" ? [...CASES, ...CAPABLE_CASES] : CASES;
const cases = suite.filter((item) => !only || only.has(item.id));

interface Result {
  model: string;
  run: number;
  id: string;
  cluster: string;
  check: Case["check"];
  pass: boolean;
  why: string;
  tools: string[];
  state: string;
  ms: number;
  output: string;
}

async function runModel(model: string): Promise<Result[]> {
  const gateway = gatewayFromEnv(model);
  const port = 7300 + Math.floor(Math.random() * 90);
  const proxy = await startProxy({ mode: "forward", gateway, port, models: [model] });
  const results: Result[] = [];
  try {
    for (let run = 1; run <= Math.max(1, Number(values.repeat) || 1); run++) for (const item of cases) {
      const box = await launchSandbox(values.repo!, { ...gateway, url: proxy.url }, { captureQuietMs: 3_600_000 });
      const api = client(box.url);
      try {
        const bot = await api.createBot("Sage", model);
        if (item.place === "auto") await api.call("PATCH", `/api/bots/${bot.id}`, { computer: null, browser: true });
        const threadId = await api.newThread(bot.id);
        const recordsBefore = proxy.records.length;
        const before = (await api.call("GET", `/api/threads/${threadId}/messages?limit=200`)).messages.length as number;
        const started = Date.now();
        await api.call("POST", `/api/bots/${bot.id}/messages`, { text: item.say, threadId });
        let stopAt = 0, seenAtStop = 0;
        if (item.stop) {
          await sleep(item.stop.afterMs);
          seenAtStop = (await api.call("GET", `/api/threads/${threadId}/messages?limit=200`)).messages.length;
          stopAt = Date.now();
          await api.call("POST", `/api/bots/${bot.id}/messages`, { text: item.stop.text, threadId });
        }
        const state = await waitIdle(api, threadId, item.waitMs ?? 240_000);
        const ms = Date.now() - (stopAt || started);
        const messages = (await api.call("GET", `/api/threads/${threadId}/messages?limit=200`)).messages as Message[];
        const shown = (from: number) => messages.slice(from).filter((m) => m.role === "bot").map(rowText).filter(Boolean);
        const output = shown(before).join("\n---\n");
        if (process.env.EVAL_DUMP) writeFileSync(join(process.env.EVAL_DUMP, `${model}-${item.id}-${run}.json`), JSON.stringify(messages.slice(before), null, 1));
        const tools = toolsOf(messages.slice(before));
        let pass: boolean, why: string;
        if (item.check === "stop") {
          const after = shown(seenAtStop).filter((text) => text !== item.stop!.text);
          const longAfter = after.filter((text) => text.length > 400);
          const callsAfter = proxy.records.slice(recordsBefore).filter((rec) => rec.tools.length > 0 && rec.at > stopAt + 1_000).length;
          pass = ms <= 15_000 && longAfter.length === 0;
          why = `ended ${Math.round(ms / 1000)} s after the stop; ${longAfter.length} long message(s) and ${callsAfter} model call(s) after it`;
        } else {
          const acted = !item.tool || tools.some((name) => item.tool!.test(name));
          const verdict = await judge(values.judge!, item, output, tools);
          pass = acted && verdict.pass;
          why = `${acted ? "" : `no matching tool call (called: ${tools.join(", ") || "none"}); `}${verdict.why}`;
        }
        results.push({ model, run, id: item.id, cluster: item.cluster, check: item.check, pass, why, tools, state, ms, output: output.slice(0, 3_000) });
        log(model, item.id, pass ? "PASS" : "FAIL", "-", why);
      } finally {
        await box.close(values.keep);
      }
    }
  } finally {
    await proxy.close();
  }
  return results;
}

async function waitIdle(api: ReturnType<typeof client>, threadId: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  await sleep(400);
  for (;;) {
    const job = await api.call("GET", `/api/threads/${threadId}/job?scope=turn`);
    if (["needs-input", "completed", "failed", "stalled", "idle"].includes(job.state)) return job.state;
    if (Date.now() > deadline) return `timeout(${job.state})`;
    await sleep(500);
  }
}

process.env.DUSK_NO_TEST_BOTS = "1";
const all: Result[] = [];
for (const model of values.models!.split(",")) all.push(...await runModel(model));
const summary: Record<string, Record<string, string>> = {};
for (const model of new Set(all.map((r) => r.model))) {
  const rows = all.filter((r) => r.model === model);
  const runs = new Set(rows.map((r) => r.run)).size;
  const mean = (set: Result[]) => `${Math.round((set.filter((r) => r.pass).length / runs) * 10) / 10}/${set.length / runs}`;
  const by = (check: string) => mean(rows.filter((r) => r.check === check || (check === "act+deliver" && (r.check === "act" || r.check === "deliver"))));
  summary[model] = { "act+deliver": by("act+deliver"), "no-false-done": by("no-false-done"), stop: by("stop"), vibe: by("vibe"), help: by("help"), capable: by("capable"), all: mean(rows), runs: String(runs) };
}
console.table(summary);
mkdirSync(join(here, "results"), { recursive: true });
writeFileSync(join(here, "results", `${values.label}.json`), JSON.stringify({ label: values.label, at: new Date().toISOString(), judge: values.judge, summary, results: all }, null, 2));
log("wrote", join("scripts/behaviour-eval/results", `${values.label}.json`));
