// Checks that need no judge: files a bot shared open, web links load, no tool names or step traces in chat, no error
// text, no empty or stuck turns, and how long the first words took.
import type { ThreadLog, TurnTiming } from "./run.ts";

export interface Checked {
  files: Array<{ path: string; status: number }>;
  links: Array<{ url: string; status: number | string }>;
  leaks: string[];
  errorText: string[];
  noReplyTurns: number;
  stuck: string[];
  duplicates: number;
  emptyBubbles: number;
  slowFirst: number;
  slowTotal: number;
  runtimeErrors: string[];
  flags: string[];
}

const LEAK = /\b(agents_[a-z_]+|use_tool|find_tool|memory_update|data_data_[a-z_]+|attach_file|wait_until|create_routine|coordinate_bots|tool_call|function_call)\b|<\/?(tool|function|invoke|parameter)[ >]|\{"name":\s*"[a-z_]+",\s*"arguments"|\[digest\]|tools: [a-z_]+ ×/;
const ERROR = /something went wrong|an error occurred|internal error|\bECONN|rate.?limit|usage limit|request failed|timed out|couldn'?t reach the (model|engine|server)|stopped responding|\bstack trace\b|undefined is not|TypeError/i;

export async function hardChecks(base: string, threads: ThreadLog[], timings: Array<TurnTiming & { totalMs?: number }>, states: string[], runtimeErrors: string[]): Promise<Checked> {
  const result: Checked = { files: [], links: [], leaks: [], errorText: [], noReplyTurns: 0, stuck: [], duplicates: 0, emptyBubbles: 0, slowFirst: 0, slowTotal: 0, runtimeErrors, flags: [] };
  const seen = new Set<string>();
  for (const thread of threads) {
    for (const message of thread.messages) {
      if (message.role !== "bot" || message.kind !== "text") continue;
      const text = message.text ?? "";
      if (!text.trim() && !message.attachments?.length && !message.document) result.emptyBubbles++;
      const leak = LEAK.exec(text);
      if (leak) result.leaks.push(text.slice(Math.max(0, leak.index - 60), leak.index + 80));
      const error = ERROR.exec(text);
      if (error) result.errorText.push(text.slice(Math.max(0, error.index - 80), error.index + 120));
      const norm = text.trim();
      if (norm.length > 20) { if (seen.has(norm)) result.duplicates++; seen.add(norm); }
      if (message.documentRead) result.files.push({ path: `document:${message.document?.title}`, status: message.documentRead.status });
      const targets = new Set<string>((message.attachments ?? []).map((a) => a.path));
      for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) if (!/^(https?:|mailto:|#|tel:)/.test(m[1]!)) targets.add(decodeURI(m[1]!));
      for (const path of targets) {
        const res = await fetch(`${base}/api/threads/${thread.threadId}/messages/${message.id}/file`, {
          method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ path }),
        }).catch(() => null);
        await res?.arrayBuffer().catch(() => null);
        result.files.push({ path: path.split("/").slice(-2).join("/"), status: res?.status ?? 0 });
      }
      for (const m of text.matchAll(/https?:\/\/[^\s)\]>"'`]+/g)) {
        const url = m[0].replace(/[.,;:!?]+$/, "");
        if (result.links.some((l) => l.url === url) || /127\.0\.0\.1|localhost|t\.me\/sage_\d+_bot/.test(url)) continue;
        const status = await fetch(url, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (Macintosh) dusk-stress-eval" }, signal: AbortSignal.timeout(12_000) })
          .then(async (r) => { await r.arrayBuffer().catch(() => null); return r.status; }).catch((e: Error) => e.name === "TimeoutError" ? "timeout" : "unreachable");
        result.links.push({ url, status });
      }
    }
  }
  result.noReplyTurns = timings.filter((t, i) => t.firstTextMs === null && !(timings[i + 1] && timings[i + 1]!.sentAt - t.sentAt < 15_000)).length;
  result.stuck = states.filter((s) => s !== "completed" && s !== "idle" && s !== "needs-input");
  result.slowFirst = timings.filter((t) => t.firstVisibleMs !== null && t.firstVisibleMs > 20_000).length;
  result.slowTotal = timings.filter((t) => (t.totalMs ?? 0) > 120_000).length;
  if (result.files.some((f) => f.status !== 200)) result.flags.push("broken-file");
  if (result.links.some((l) => typeof l.status !== "number" || (l.status >= 400 && l.status !== 403 && l.status !== 429))) result.flags.push("broken-link");
  if (result.leaks.length) result.flags.push("leak-hard");
  if (result.errorText.length || runtimeErrors.some((e) => e.startsWith("runtime.error"))) result.flags.push("error");
  if (result.noReplyTurns) result.flags.push("no-reply");
  if (result.stuck.length) result.flags.push("stuck");
  if (result.duplicates) result.flags.push("duplicate");
  if (result.emptyBubbles) result.flags.push("empty-bubble");
  if (result.slowFirst) result.flags.push("slow-first");
  if (result.slowTotal) result.flags.push("slow-total");
  return result;
}
