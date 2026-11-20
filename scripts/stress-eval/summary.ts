// Counts a stress eval run: pass rate, every flag by conversations hit and by persona and shape, latency percentiles,
// and the failing keys per flag, so the report can pick examples.
//   node --experimental-strip-types scripts/stress-eval/summary.ts <out>/results.jsonl
import { readFileSync } from "node:fs";

const rows = readFileSync(process.argv[2]!, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const pct = (list: number[], p: number) => { const s = [...list].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const pass = rows.filter((r) => r.verdict?.pass).length;
console.log(`conversations ${rows.length}, pass ${pass} (${Math.round((pass / rows.length) * 100)}%), mean score ${(rows.reduce((a, r) => a + (r.verdict?.score ?? 0), 0) / rows.length).toFixed(2)}`);
const flags: Record<string, string[]> = {};
for (const r of rows) for (const f of new Set<string>(r.verdict?.flags ?? [])) (flags[f] ??= []).push(r.key);
console.log("\nflags (conversations):");
for (const [f, keys] of Object.entries(flags).sort((a, b) => b[1].length - a[1].length)) console.log(`${String(keys.length).padStart(4)} ${f}: ${keys.slice(0, 14).join(" ")}`);
for (const field of ["persona", "shape"]) {
  const by: Record<string, { n: number; pass: number }> = {};
  for (const r of rows) { const k = r[field]; by[k] ??= { n: 0, pass: 0 }; by[k].n++; if (r.verdict?.pass) by[k].pass++; }
  console.log(`\nby ${field}:`);
  for (const [k, v] of Object.entries(by).sort((a, b) => a[1].pass / a[1].n - b[1].pass / b[1].n)) console.log(`  ${k}: ${v.pass}/${v.n}`);
}
const first = rows.flatMap((r) => (r.timings ?? []).map((t: any) => t.firstVisibleMs).filter((v: any) => typeof v === "number"));
const total = rows.flatMap((r) => (r.timings ?? []).map((t: any) => t.totalMs).filter((v: any) => typeof v === "number"));
console.log(`\nfirst words ms p50 ${pct(first, 0.5)} p90 ${pct(first, 0.9)} max ${pct(first, 1)}; turn total ms p50 ${pct(total, 0.5)} p90 ${pct(total, 0.9)} max ${pct(total, 1)}`);
const fails = rows.filter((r) => !r.verdict?.pass).map((r) => `${r.key} [${r.verdict?.score}] ${(r.verdict?.flags ?? []).join(",")}: ${r.verdict?.why}`);
console.log(`\nfailing (${fails.length}):\n${fails.join("\n")}`);
