import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { under } from "./bot-box/plan.ts";

import { writeFileAtomic } from "./atomic.ts";
import { redactSecretsInText } from "./redact.ts";
import type { Message } from "./store.ts";
import { readSpilledToolResult } from "./tool-result-spill.ts";
import { ensureTaskWorkspace } from "./workspace.ts";

export interface ArchivedCall {
  name: string;
  ok?: boolean;
  input?: string;
  /** The full result when the harness kept one, else the preview the chat holds. */
  result?: string;
}

export const ARCHIVE_DIR = "context-archive";
const CALL_MAX_CHARS = 24_000;
const FILE_MAX_CHARS = 1_000_000;

function fenced(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

function clipped(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[… ${text.length - max} more characters not kept]` : text;
}

export function renderToolArchive(calls: readonly ArchivedCall[]): string {
  const parts = [
    "# Tool results from the earlier part of this conversation",
    "Saved word for word (secrets masked) when the conversation was summarized, oldest first. Search it for the exact result you need rather than reading it all.",
  ];
  let size = parts.join("\n\n").length;
  let omitted = 0;
  for (const [index, call] of calls.entries()) {
    const status = call.ok === true ? "ok" : call.ok === false ? "failed" : "no result recorded";
    const block = [
      `## ${index + 1}. ${redactSecretsInText(call.name).replace(/\s+/g, " ").slice(0, 200)} (${status})`,
      ...(call.input?.trim() ? ["Input:", fenced(clipped(redactSecretsInText(call.input), 4_000))] : []),
      call.result?.trim() ? `Result:\n${fenced(clipped(redactSecretsInText(call.result), CALL_MAX_CHARS))}` : "Result: none recorded",
    ].join("\n");
    if (size + block.length > FILE_MAX_CHARS) { omitted = calls.length - index; break; }
    parts.push(block);
    size += block.length + 2;
  }
  if (omitted) parts.push(`[${omitted} later calls did not fit in this file]`);
  return `${parts.join("\n\n")}\n`;
}

/** Writes the folded part's tool results into the chat's own folder, where the bot's file tools reach them. */
export function writeToolArchive(taskDir: string, name: string, calls: readonly ArchivedCall[]): { path: string; count: number } | null {
  if (!calls.length) return null;
  if (!/^[\w.-]{1,120}$/.test(name)) throw new Error("invalid archive name");
  const dir = join(taskDir, ARCHIVE_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${name}.md`);
  writeFileAtomic(path, renderToolArchive(calls), { mode: 0o600 });
  return { path, count: calls.length };
}

export function archivePointer(archive: { path: string; count: number }): string {
  return `- ${archive.path}: ${archive.count} tool result${archive.count === 1 ? "" : "s"} from before this point, word for word. Read or search it with your file tools when an exact earlier result matters.`;
}

/** The tool calls after the last fold through the new one, saved where the bot can read them back; a failure only loses the file. */
export function archiveFoldedTools(input: {
  botId: string; threadId: string; messages: readonly Message[]; afterId?: string; throughId: string; spillDir: string; taskDir?: string;
  /** The chat's working folder; unset is its own folder. */
  cwd?: string | null;
  /** The bot box mounts the working folder, not the chat's own one, so a chat boxed in a project folder could not read the file. */
  boxed: boolean;
}): string | undefined {
  const { threadId, messages } = input;
  const start = input.afterId ? messages.findIndex((m) => m.id === input.afterId) + 1 : 0;
  const end = messages.findIndex((m) => m.id === input.throughId);
  if (end < 0) return undefined;
  const calls: ArchivedCall[] = messages.slice(start, end + 1).flatMap((m) => {
    const tool = m.kind === "activity" ? m.tool : undefined;
    if (!tool?.itemId) return [];
    const full = tool.fullResult !== undefined && m.turnId ? readSpilledToolResult(input.spillDir, `${threadId}:${m.turnId}:${tool.itemId}`) : undefined;
    return [{ name: tool.name, ok: tool.ok, input: tool.input, result: full ?? tool.output }];
  });
  try {
    const taskDir = input.taskDir ?? ensureTaskWorkspace(input.botId, threadId);
    if (input.boxed && input.cwd && !under(resolve(input.cwd), resolve(taskDir))) return undefined;
    const written = writeToolArchive(taskDir, `through-${input.throughId.replace(/[^\w.-]/g, "_").slice(0, 80)}`, calls);
    return written ? archivePointer(written) : undefined;
  } catch (error) {
    console.warn(`compaction: could not save the folded tool results: ${(error as Error).message}`);
    return undefined;
  }
}
