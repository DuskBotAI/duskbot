// Scores per case and per dimension from one or two results.jsonl files (before, after).
//   node --experimental-strip-types scripts/workflow-eval/summary.ts <before/results.jsonl> [<after/results.jsonl>]
import { readFileSync } from "node:fs";
import { DIMENSIONS } from "./judge.ts";

const load = (path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const files = process.argv.slice(2).map(load);
const dims = Object.keys(DIMENSIONS);
const mean = (xs: number[]) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : "-");

for (const [i, rows] of files.entries()) {
  console.log(`\n## ${process.argv[2 + i]}: ${rows.length} cases, mean score ${mean(rows.map((r) => r.verdict.score))}`);
  console.log(`| dimension | met |\n| --- | --- |`);
  for (const d of dims) {
    const graded = rows.filter((r) => typeof r.verdict.dims?.[d] === "boolean");
    console.log(`| ${d} | ${graded.filter((r) => r.verdict.dims[d] === true).length}/${graded.length} |`);
  }
  console.log(`\n| case | score | missed |\n| --- | --- | --- |`);
  for (const r of rows) console.log(`| ${r.key} | ${r.verdict.score} | ${dims.filter((d) => r.verdict.dims?.[d] === false).join(", ")} |`);
}
