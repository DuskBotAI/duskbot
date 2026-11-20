// Does a long chat keep its thread across dusk bot's compaction? Runs one checkout's real fold code (server/compaction-summary.ts,
// server/context-rebuild.ts) twice over a synthetic 43-turn chat, then asks a model what it remembers and to carry on.
//   node --experimental-strip-types scripts/compaction-eval/run.ts --repo <checkout> --label after [--reps 3] [--model gpt-6.2-sol] [--full]
// The summary helper and the answering model are both --model on the gateway (scripts/memory-eval/sandbox.ts reads its key).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { gatewayFromEnv } from "../memory-eval/sandbox.ts";
import { CONTINUE, conversation, RECALL, type Turn } from "./conversation.ts";

const { values } = parseArgs({ options: {
  repo: { type: "string" }, label: { type: "string" }, reps: { type: "string", default: "3" }, model: { type: "string", default: "gpt-6.2-sol" },
  full: { type: "boolean", default: false }, out: { type: "string" },
} });
const repo = resolve(values.repo ?? process.cwd());
const label = values.label ?? "run";
const gateway = gatewayFromEnv(values.model!);
const summaryModule = await import(pathToFileURL(join(repo, "server/compaction-summary.ts")).href);
const rebuild = await import(pathToFileURL(join(repo, "server/context-rebuild.ts")).href);
const archiveModule = await import(pathToFileURL(join(repo, "server/compaction-archive.ts")).href).catch(() => null);

type Entry = { id: string; role: "user" | "assistant"; text: string };
type ChatMessage = { role: string; content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>; tool_call_id?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function chat(messages: ChatMessage[], tools?: unknown[]): Promise<{ content: string; calls: Array<{ id: string; name: string; args: string }> }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${gateway.url}/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${gateway.key}` },
        body: JSON.stringify({ model: gateway.model, messages, ...(tools ? { tools } : {}) }), signal: AbortSignal.timeout(180_000),
      });
      const json = await res.json() as { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }> };
      const message = json.choices?.[0]?.message;
      if (!res.ok || !message) throw new Error(`gateway ${res.status}`);
      return { content: message.content ?? "", calls: (message.tool_calls ?? []).map((call) => ({ id: call.id, name: call.function.name, args: call.function.arguments })) };
    } catch (error) {
      if (attempt >= 4) throw error;
      await sleep(3_000 * (attempt + 1));
    }
  }
}

async function pool<T, R>(items: readonly T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => { while (next < items.length) { const i = next++; out[i] = await work(items[i]!); } }));
  return out;
}

const turns: Turn[] = conversation();
const entries: Entry[] = turns.flatMap((turn, i) => [{ id: `u${i}`, role: "user" as const, text: turn.user }, { id: `a${i}`, role: "assistant" as const, text: turn.assistant }]);
const FIRST_FOLD_AT = 26;

interface Record { id: string; firstKeptId: string; foldedThroughId: string; summary: string; tokensBefore: number; by: "harness" }

/** What compactConversation does at the start of the turn that sends `upTo`: fold all but the two latest exchanges. */
async function fold(context: Entry[], record: Record | undefined, recordAt: number, archiveDir: string): Promise<{ record: Record; context: Entry[]; model: boolean; ms: number }> {
  const selected = rebuild.selectReplay(context, { budgetBytes: 10_000_000, maxMessages: Number.MAX_SAFE_INTEGER, compaction: record && { ...record, id: record.id } });
  const history: Entry[] = selected.transcript.filter((entry: Entry) => entry.id);
  const point = summaryModule.foldPoint(history);
  if (!point) throw new Error("nothing to fold");
  const foldedThroughId = point.folded.at(-1).id;
  const previous = record && point.folded[0]?.id === record.id ? { id: record.id, summary: record.summary } : undefined;
  let archive: string | undefined;
  if (archiveModule) {
    const from = record ? turns.findIndex((_, i) => `a${i}` === record.foldedThroughId) + 1 : 0;
    const through = Number(foldedThroughId.slice(1));
    const calls = turns.slice(from, through + 1).flatMap((turn) => (turn.tools ?? []).map((tool) => ({ name: tool.name, ok: true, input: tool.input, result: tool.result })));
    const written = archiveModule.writeToolArchive(archiveDir, `through-${foldedThroughId}`, calls);
    archive = written ? archiveModule.archivePointer(written) : undefined;
  }
  let model = false;
  const started = Date.now();
  const summary: string = await summaryModule.draftSummary(point.folded, {
    signal: new AbortController().signal, timeoutMs: 150_000, previous, archive, today: "2026-11-20",
    generateText: async (prompt: string) => { const { content } = await chat([{ role: "user", content: prompt }]); model = Boolean(content.trim()); return content; },
  });
  const next: Record = { id: `c${recordAt}`, firstKeptId: point.firstKeptId, foldedThroughId, summary, tokensBefore: 0, by: "harness" };
  return { record: next, context: [...context, { id: next.id, role: "assistant", text: "" }], model, ms: Date.now() - started };
}

const TOOLS = [
  { type: "function", function: { name: "send_email", description: "Send an email from Maya's account.", parameters: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["to", "subject", "body"] } } },
  { type: "function", function: { name: "read_file", description: "Read a text file on this computer.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "run_command", description: "Run a shell command on this computer.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
];
const SYSTEM = "You are dusk bot, Maya's personal assistant. You act with your tools rather than describing what you would do. Today is 20/11/2026.";

async function ask(transcript: Entry[], text: string, archiveDir: string): Promise<{ reply: string; calls: Array<{ name: string; args: string }> }> {
  const messages: ChatMessage[] = [{ role: "system", content: SYSTEM }, ...transcript.map(({ role, text }) => ({ role, content: text })), { role: "user", content: text }];
  const calls: Array<{ name: string; args: string }> = [];
  let reply = "";
  for (let round = 0; round < 4; round++) {
    const answer = await chat(messages, TOOLS);
    reply += answer.content ? `${answer.content}\n` : "";
    if (!answer.calls.length) break;
    messages.push({ role: "assistant", content: answer.content || null, tool_calls: answer.calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.args } })) as ChatMessage["tool_calls"] });
    for (const call of answer.calls) {
      calls.push({ name: call.name, args: call.args });
      let result = "ok";
      if (call.name === "read_file") {
        let path = "";
        try { path = String(JSON.parse(call.args).path ?? ""); } catch { /* bad arguments read as no path */ }
        try { result = resolve(path).startsWith(archiveDir) ? readFileSync(resolve(path), "utf8") : "error: no such file"; } catch { result = "error: no such file"; }
      } else if (call.name === "send_email") result = "sent";
      else result = "error: this computer is offline";
      messages.push({ role: "tool", content: result, tool_call_id: call.id });
    }
  }
  return { reply: reply.trim(), calls };
}

async function judge(askText: string, pass: string, reply: string, calls: Array<{ name: string; args: string }>): Promise<{ pass: boolean; why: string }> {
  const prompt = `You grade one reply of a personal assistant late in a long chat. The person's latest message:\n<ask>${askText}</ask>\nThe assistant's reply text:\n<reply>${reply || "(none)"}</reply>\nTool calls it made, in order, with arguments:\n<calls>${calls.map((c) => `${c.name} ${c.args}`).join("\n") || "none"}</calls>\nPass condition: ${pass}\nAnswer with JSON only: {"pass": true|false, "why": "<one short sentence>"}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { content } = await chat([{ role: "user", content: prompt }]);
    const match = /\{[\s\S]*\}/.exec(content);
    if (match) { try { const parsed = JSON.parse(match[0]); return { pass: parsed.pass === true, why: String(parsed.why ?? "") }; } catch { /* retried */ } }
  }
  return { pass: false, why: "judge unavailable" };
}

async function rep(n: number, full: boolean) {
  const archiveDir = mkdtempSync(join(tmpdir(), "dusk-compaction-eval-"));
  try {
    let transcript: Entry[];
    const folds: Array<{ model: boolean; ms: number; bytes: number }> = [];
    let summary = "";
    if (full) transcript = entries;
    else {
      const first = await fold(entries.slice(0, FIRST_FOLD_AT * 2), undefined, FIRST_FOLD_AT, archiveDir);
      folds.push({ model: first.model, ms: first.ms, bytes: Buffer.byteLength(first.record.summary) });
      const context = [...first.context, ...entries.slice(FIRST_FOLD_AT * 2)];
      const second = await fold(context, first.record, turns.length, archiveDir);
      folds.push({ model: second.model, ms: second.ms, bytes: Buffer.byteLength(second.record.summary) });
      summary = second.record.summary;
      const selection = rebuild.selectReplay(second.context, { budgetBytes: rebuild.DEFAULT_REBUILD_BYTES, compaction: second.record });
      transcript = selection.transcript.map(({ role, text }: Entry) => ({ id: "", role, text }));
    }
    const recall = await pool(RECALL, 4, async (probe) => {
      const { reply, calls } = await ask(transcript, probe.ask, archiveDir);
      return { id: probe.id, early: probe.early, archiveOnly: Boolean(probe.archiveOnly), pass: probe.expect.test(reply), read: calls.some((c) => c.name === "read_file"), reply: reply.slice(0, 400) };
    });
    const continuation = await pool(CONTINUE, 2, async (item) => {
      const { reply, calls } = await ask(transcript, item.ask, archiveDir);
      const verdict = await judge(item.ask, item.pass, reply, calls);
      return { id: item.id, ...verdict, emailedVendor: calls.some((c) => c.name === "send_email" && /tomasz@nordlane\.io/i.test(c.args)), calls: calls.map((c) => c.name), reply: reply.slice(0, 600) };
    });
    console.log(`[${label}] rep ${n}: recall ${recall.filter((r) => r.pass).length}/${recall.length}, continuation ${continuation.filter((c) => c.pass).length}/${continuation.length}, folds ${JSON.stringify(folds)}`);
    return { rep: n, folds, summary, transcriptBytes: transcript.reduce((s, e) => s + Buffer.byteLength(e.text), 0), recall, continuation };
  } finally { rmSync(archiveDir, { recursive: true, force: true }); }
}

const reps = values.full ? 1 : Number(values.reps);
const results = [];
for (let i = 1; i <= reps; i++) results.push(await rep(i, values.full!));
const rate = (rows: Array<{ pass: boolean }>) => `${rows.filter((r) => r.pass).length}/${rows.length}`;
const all = results.flatMap((r) => r.recall);
const totals = {
  label, model: values.model, reps, turns: turns.length,
  earlyFactRecall: rate(all.filter((r) => r.early && !r.archiveOnly)),
  laterFactRecall: rate(all.filter((r) => !r.early)),
  archivedToolResultRecall: rate(all.filter((r) => r.archiveOnly)),
  continuation: rate(results.flatMap((r) => r.continuation)),
  nextStep: rate(results.flatMap((r) => r.continuation.filter((c) => c.id === "next-step"))),
  driverNotice: rate(results.flatMap((r) => r.continuation.filter((c) => c.id === "driver-notice"))),
  emailedVendorOnNextStep: `${results.flatMap((r) => r.continuation.filter((c) => c.id === "next-step" && c.emailedVendor)).length}/${reps}`,
};
console.log(JSON.stringify(totals, null, 2));
const out = values.out ?? join(import.meta.dirname, "results", `${label}.json`);
mkdirSync(join(out, ".."), { recursive: true });
writeFileSync(out, `${JSON.stringify({ totals, results }, null, 2)}\n`);
console.log(`saved ${out}`);
