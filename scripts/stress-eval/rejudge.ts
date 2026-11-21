// Judges stored conversations again with the current judge (judge.ts and the scenario's current expect), for a run the
// judge could not reach or graded on an older rubric. Writes <in>.rejudged.jsonl beside the input.
//   node --experimental-strip-types scripts/stress-eval/rejudge.ts <results.jsonl> [--judge gpt-6.2-sol] [--all] [--only id,id]
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { gatewayFromEnv } from "../memory-eval/sandbox.ts";
import { SCENARIOS } from "./scenarios.ts";
import { SCENARIOS_2 } from "./scenarios2.ts";
import { SCENARIOS_3 } from "./scenarios3.ts";
import { judge } from "./judge.ts";
import type { ThreadLog } from "./run.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  judge: { type: "string", default: "gpt-6.2-sol" },
  /** every result, not only those the judge could not grade */
  all: { type: "boolean", default: false },
  only: { type: "string", default: "" },
} });
const input = positionals[0];
if (!input) throw new Error("give a results.jsonl");
const output = input.replace(/\.jsonl$/, "") + ".rejudged.jsonl";
writeFileSync(output, "");
const scenarios = new Map([...SCENARIOS, ...SCENARIOS_2, ...SCENARIOS_3].map((one) => [one.id, one]));
const only = values.only ? new Set(values.only.split(",")) : null;
const gateway = gatewayFromEnv(values.judge!);

type Stored = { role: string; kind?: string; text: string; card?: unknown; document?: { title: string; kind: string; bytes: number; status?: number; text?: string }; attachments?: Array<{ kind: string; name: string }> };

for (const line of readFileSync(input, "utf8").split("\n").filter(Boolean)) {
  const result = JSON.parse(line);
  const scenario = scenarios.get(result.id);
  const redo = scenario && !result.crashed && (!only || only.has(result.id)) && (values.all || result.verdict?.flags?.includes("judge-unavailable"));
  if (!redo) { appendFileSync(output, `${line}\n`); continue; }
  const threads: ThreadLog[] = (result.transcript as Stored[][]).map((messages, t) => ({
    threadId: `t${t}`,
    messages: messages.map((m, i) => ({
      id: `m${i}`, role: m.role, kind: m.kind, text: m.text, ...(m.card ? { card: m.card } : {}),
      attachments: (m.attachments ?? []).map((a) => ({ kind: a.kind, path: a.name, name: a.name })),
      ...(m.document ? { document: { botId: "", id: "", title: m.document.title, kind: m.document.kind, bytes: m.document.bytes },
        documentRead: { status: m.document.status ?? 0, text: m.document.text ?? "(text not kept in this run)" } } : {}),
    })),
  }));
  const verdict = await judge(gateway, scenario, threads, {
    tools: result.tools ?? [], routines: result.routines ?? [], waits: result.waits ?? [], jobs: result.jobs ?? [], webhooks: result.webhooks ?? [],
    compactions: result.compactions, ...(result.liveCheck ? { liveCheck: result.liveCheck } : {}), shell: result.engine && result.engine !== "openai-compat",
    ...(result.site ? { site: result.site } : {}), memory: result.memory ?? "", aboutMe: result.aboutMe ?? "", checked: result.checked,
  });
  console.log(result.key, verdict.pass ? "PASS" : "FAIL", verdict.flags.join(","), "-", verdict.why);
  appendFileSync(output, `${JSON.stringify({ ...result, verdict, rejudged: true })}\n`);
}
console.log("written", output);
