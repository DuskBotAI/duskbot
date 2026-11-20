// Rules again on saved transcripts (run.ts with EVAL_DUMP=<dir>), so builds run at different times are judged by the
// same pass conditions and judge.
//   node --experimental-strip-types scripts/behaviour-eval/rejudge.ts --dumps <dir> --label <name> [--judge gpt-6.2-sol]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CAPABLE_CASES, CASES } from "./cases.ts";
import { judge, rowText, toolsOf, type Message } from "./judge.ts";

const { values } = parseArgs({ options: { dumps: { type: "string" }, label: { type: "string" }, judge: { type: "string", default: "gpt-6.2-sol" } } });
const here = dirname(fileURLToPath(import.meta.url));
const all = [...CASES, ...CAPABLE_CASES];
const rows: Array<{ model: string; id: string; run: number; pass: boolean; why: string; tools: string[]; output: string }> = [];
const files = readdirSync(values.dumps!).filter((name) => name.endsWith(".json"));
const one = async (name: string) => {
  const match = /^(.*)-(\d+)\.json$/.exec(name)!;
  const item = all.filter((c) => match[1]!.endsWith(`-${c.id}`)).sort((a, b) => b.id.length - a.id.length)[0];
  if (!item) return;
  const messages = JSON.parse(readFileSync(join(values.dumps!, name), "utf8")) as Message[];
  const output = messages.filter((m) => m.role === "bot").map(rowText).filter(Boolean).join("\n---\n");
  const tools = toolsOf(messages);
  const acted = !item.tool || tools.some((tool) => item.tool!.test(tool));
  const verdict = await judge(values.judge!, item, output, tools);
  rows.push({ model: match[1]!.slice(0, -item.id.length - 1), id: item.id, run: Number(match[2]), pass: acted && verdict.pass, why: `${acted ? "" : "no matching tool call; "}${verdict.why}`, tools, output: output.slice(0, 3_000) });
};
for (let at = 0; at < files.length; at += 6) await Promise.all(files.slice(at, at + 6).map(one));
rows.sort((a, b) => a.id.localeCompare(b.id) || a.run - b.run);
const runs = new Set(rows.map((r) => r.run)).size;
const passed = rows.filter((r) => r.pass).length;
const byCase = Object.fromEntries([...new Set(rows.map((r) => r.id))].map((id) => [id, `${rows.filter((r) => r.id === id && r.pass).length}/${rows.filter((r) => r.id === id).length}`]));
const summary = { passed, total: rows.length, runs, perRun: `${Math.round((passed / runs) * 10) / 10}/${rows.length / runs}`, byCase };
console.log(JSON.stringify(summary, null, 2));
writeFileSync(join(here, "results", `${values.label}.json`), JSON.stringify({ label: values.label, at: new Date().toISOString(), judge: values.judge, summary, results: rows }, null, 2));
