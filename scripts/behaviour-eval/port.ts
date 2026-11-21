// Port eval: one scenario per behaviour taken from Hermes Agent and OpenClaw, each against a fresh sandbox server
// (../memory-eval/sandbox.ts) whose one engine talks to the gateway through the recording proxy. A scenario drives the
// app's own routes, then a judge model rules on what the person would see, and plain checks read the recorded requests.
//   node --experimental-strip-types scripts/behaviour-eval/port.ts [--repo <checkout>] [--model gpt-6.2-sol] [--judge gpt-6.2-sol] [--only id,id] [--label run]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { client } from "../memory-eval/client.ts";
import { gatewayFromEnv, launchSandbox } from "../memory-eval/sandbox.ts";
import { startProxy, type Proxy } from "../memory-eval/proxy.ts";

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: {
  repo: { type: "string", default: resolve(here, "..", "..") },
  model: { type: "string", default: "gpt-6.2-sol" },
  judge: { type: "string", default: "gpt-6.2-sol" },
  only: { type: "string", default: "" },
  label: { type: "string", default: "port" },
  keep: { type: "boolean", default: false },
} });
const log = (...parts: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...parts);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Api = ReturnType<typeof client>;
interface Context { api: Api; proxy: Proxy; botId: string; threadId: string; model: string }
interface Outcome { shown: string; checks: Array<[string, boolean]> }
interface Scenario { id: string; feature: string; pass: string; run(ctx: Context): Promise<Outcome> }

const EVERY_DAY = { type: "daily", time: "08:00", weekdays: [0, 1, 2, 3, 4, 5, 6] };

async function runRoutine(api: Api, routineId: string, timeoutMs = 240_000): Promise<{ status: string; output: string; report?: { state: string } }> {
  const { run } = await api.call("POST", `/api/routines/${routineId}/run`, {});
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await sleep(2_000);
    const { runs } = await api.call("GET", "/api/routines");
    const now = (runs as Array<{ id: string; status: string; output?: string; report?: { state: string } }>).find((one) => one.id === run.id);
    if (now && ["completed", "failed", "cancelled", "missed"].includes(now.status) && now.report?.state !== "pending") return { status: now.status, output: now.output ?? "", ...(now.report ? { report: now.report } : {}) };
    if (Date.now() > deadline) return { status: `timeout(${now?.status})`, output: now?.output ?? "" };
  }
}

const SCENARIOS: Scenario[] = [
  {
    id: "routine-memory",
    feature: "Routine runs remember their last reports and keep notes",
    pass: "Run 2 and run 3 each give an octopus fact that is different from every earlier run's fact (no repeated fact, even reworded). Each run is one short fact, not a list of all earlier ones.",
    async run({ api, proxy, botId }) {
      const { routine } = await api.call("POST", "/api/routines", { name: "Octopus fact", prompt: "Tell me one surprising fact about octopuses, in one sentence.", botId, schedule: EVERY_DAY, enabled: false });
      const outputs: string[] = [];
      for (let i = 0; i < 3; i++) outputs.push((await runRoutine(api, routine.id)).output);
      const prompts = proxy.records.filter((rec) => rec.kind === "chat" && rec.user.includes("Octopus fact"));
      return {
        shown: outputs.map((text, i) => `Run ${i + 1}: ${text}`).join("\n"),
        checks: [["run 3's request carried two earlier reports", prompts.some((rec) => (rec.user.match(/<earlier-report/g) ?? []).length === 2)]],
      };
    },
  },
  {
    id: "routine-notes",
    feature: "Routine runs remember their last reports and keep notes",
    pass: "Across the three runs the bot reviews the six chapters two at a time in order: run 1 covers chapters 1-2, run 2 covers 3-4, run 3 covers 5-6. Each run picks up where the last stopped instead of starting over.",
    async run({ api, proxy, botId }) {
      const prompt = "Each run, give a one-line takeaway for the next two chapters of this six-chapter reading list that you have not covered yet, in order: 1 Habits, 2 Focus, 3 Sleep, 4 Money, 5 Friends, 6 Rest. Keep track of where you stopped.";
      const { routine } = await api.call("POST", "/api/routines", { name: "Reading list", prompt, botId, schedule: EVERY_DAY, enabled: false });
      const outputs: string[] = [];
      for (let i = 0; i < 3; i++) outputs.push((await runRoutine(api, routine.id)).output);
      const notes = proxy.records.some((rec) => (rec.toolCalls ?? []).some((name) => name.endsWith("trigger")) && rec.user.includes("Reading list"));
      return { shown: outputs.map((text, i) => `Run ${i + 1}: ${text}`).join("\n"), checks: [["a run saved notes with trigger", notes]] };
    },
  },
  {
    id: "silent-finding",
    feature: "A routine's finding is never swallowed by a NOTHING NEW at its end",
    pass: "The person was told that invoice #3 (Lumen Labs) is overdue. Nothing else matters.",
    async run({ api, botId, threadId }) {
      const prompt = "Look at these invoices: #1 Acme, paid. #2 Brightdesk, paid. #3 Lumen Labs, 5 days overdue. Tell me about any overdue one in one line. Always end your reply with a last line that says NOTHING NEW.";
      const { routine } = await api.call("POST", "/api/routines", { name: "Invoice check", prompt, botId, schedule: EVERY_DAY, enabled: false, resultsThreadId: threadId });
      const result = await runRoutine(api, routine.id);
      await sleep(3_000);
      const messages = (await api.call("GET", `/api/threads/${threadId}/messages?limit=50`)).messages as Array<{ role: string; text?: string; quietRun?: boolean }>;
      const shown = messages.filter((m) => m.role === "bot" && m.text && !m.quietRun && !m.text.startsWith("[digest]")).map((m) => m.text).join("\n") || (result.report?.state === "quiet" ? "" : result.output);
      return { shown, checks: [["the run did not count as quiet", result.status === "completed" && result.report?.state !== "quiet"], ["the token was not shown", !/nothing new/i.test(shown)]] };
    },
  },
  {
    id: "routine-no-self-spawn",
    feature: "A routine run does its work instead of setting itself up again",
    pass: "The run delivers one motivational quote now. It does not say it set up, scheduled or created anything.",
    async run({ api, botId }) {
      const { routine } = await api.call("POST", "/api/routines", { name: "Morning quote", prompt: "Every morning at 7am, send me one short motivational quote.", botId, schedule: EVERY_DAY, enabled: false });
      const result = await runRoutine(api, routine.id);
      const { routines } = await api.call("GET", "/api/routines");
      return { shown: result.output, checks: [["no second routine was made", (routines as unknown[]).length === 1]] };
    },
  },
  {
    id: "commitments",
    feature: "An explicit promise is kept in the commitments list and reaches the automations; a vague wish is not",
    pass: "The weekly check run names sending Asha the Q4 deck (due Friday 27 November). It does not list exercising more as something owed.",
    async run({ api, botId, threadId }) {
      await api.say(botId, threadId, "Heads up: I promised Asha I'd send her the Q4 deck by Friday, 27 November 2026. Keep track of that for me.");
      await api.say(botId, threadId, "Also I should probably exercise more at some point.");
      const files = await Promise.all((await api.bots()).map((bot) => api.botMemory(bot.id)));
      const list = files.map((memory) => memory["memory/commitments.md"] ?? "").join("\n");
      const { routine } = await api.call("POST", "/api/routines", { name: "Weekly check", prompt: "List anything I owe people this week, one line each. If there is nothing, say so.", botId, schedule: EVERY_DAY, enabled: false });
      const result = await runRoutine(api, routine.id);
      return { shown: result.output, checks: [["commitments.md holds the Asha promise", /asha/i.test(list) && /deck/i.test(list)], ["the vague wish is not in it", !/exercis/i.test(list)]] };
    },
  },
];

async function judge(model: string, scenario: Scenario, shown: string): Promise<{ pass: boolean; why: string }> {
  const gateway = gatewayFromEnv(model);
  const prompt = `You grade a personal assistant bot on one behaviour: ${scenario.feature}.\nWhat the person saw, in order:\n<output>\n${shown || "(nothing)"}\n</output>\nPass condition: ${scenario.pass}\nAnswer with JSON only: {"pass": true|false, "why": "<one short sentence>"}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`${gateway.url}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${gateway.key}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0 }), signal: AbortSignal.timeout(120_000),
    }).catch(() => null);
    const json = await res?.json().catch(() => null) as { choices?: Array<{ message?: { content?: string } }> } | null;
    const match = /\{[\s\S]*\}/.exec(json?.choices?.[0]?.message?.content ?? "");
    if (match) { try { const parsed = JSON.parse(match[0]); return { pass: parsed.pass === true, why: String(parsed.why ?? "") }; } catch { /* asked again below */ } }
    await sleep(3_000 * (attempt + 1));
  }
  return { pass: false, why: "judge unavailable" };
}

process.env.DUSK_NO_TEST_BOTS = "1";
const only = values.only ? new Set(values.only.split(",")) : null;
const model = values.model!;
const gateway = gatewayFromEnv(model);
const proxy = await startProxy({ mode: "forward", gateway, port: 7300 + Math.floor(Math.random() * 90), models: [model] });
const results: Array<{ id: string; feature: string; pass: boolean; why: string; checks: Array<[string, boolean]>; shown: string }> = [];
try {
  for (const scenario of SCENARIOS.filter((one) => !only || only.has(one.id))) {
    const box = await launchSandbox(values.repo!, { ...gateway, url: proxy.url }, { captureQuietMs: 3_600_000 });
    const api = client(box.url);
    try {
      const bot = await api.createBot("Sage", model);
      const threadId = await api.newThread(bot.id);
      proxy.records.length = 0;
      const outcome = await scenario.run({ api, proxy, botId: bot.id, threadId, model });
      const verdict = await judge(values.judge!, scenario, outcome.shown);
      const pass = verdict.pass && outcome.checks.every(([, ok]) => ok);
      results.push({ id: scenario.id, feature: scenario.feature, pass, why: verdict.why, checks: outcome.checks, shown: outcome.shown.slice(0, 3_000) });
      log(scenario.id, pass ? "PASS" : "FAIL", "-", verdict.why, outcome.checks.map(([name, ok]) => `${ok ? "ok" : "MISSING"}: ${name}`).join("; "));
    } catch (error) {
      results.push({ id: scenario.id, feature: scenario.feature, pass: false, why: String(error), checks: [], shown: "" });
      log(scenario.id, "ERROR", error);
    } finally {
      await box.close(values.keep);
    }
  }
} finally {
  await proxy.close();
}
mkdirSync(join(here, "results"), { recursive: true });
writeFileSync(join(here, "results", `${values.label}.json`), JSON.stringify({ label: values.label, at: new Date().toISOString(), model, judge: values.judge, results }, null, 2));
log("wrote", join("scripts/behaviour-eval/results", `${values.label}.json`), `${results.filter((r) => r.pass).length}/${results.length} passed`);
