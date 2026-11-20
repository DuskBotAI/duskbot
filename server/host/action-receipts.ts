// Every outbound action a turn takes (a send, a booking, a purchase, a saved file, a download) leaves a receipt: the
// connected-apps relay writes one for each call it carried, and the turn's own tool calls add theirs. When the turn
// ends, a reply that claims such an action with no receipt behind it is marked "Not confirmed" for the person. Receipts
// go to <data>/receipts/<month>.jsonl (0600), kept 30 days past their month, and name the tool only, never what was sent.
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { ActionKind } from "../../shared/wire.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { pruneMonthFiles } from "../decision-log.ts";

export type { ActionKind };
type Evidence = ActionKind | "browser" | "shell";

/** What else stands behind a claim of each kind: a browser step can send, book, buy or download; a shell command can save or fetch a file. */
const BACKED_BY: Record<ActionKind, readonly Evidence[]> = {
  send: ["send", "browser"],
  book: ["book", "browser", "send"],
  buy: ["buy", "browser"],
  file: ["file", "shell", "download"],
  download: ["download", "browser", "shell"],
};

const SUBJECT = String.raw`(?:^|[.!?:]\s+|\b(?:I|I've|I have|I just|I've just|I also|we|we've)\s+(?:just\s+|now\s+|also\s+|already\s+)?)`;
const PASSIVE = String.raw`\b(?:has been|have been|was|were|is now|are now|is|are|all)\s+`;
const CLAIM_VERBS: Record<ActionKind, string> = {
  send: "sent|emailed|messaged|replied|posted|forwarded|texted|published|tweeted",
  book: "booked|reserved|scheduled",
  buy: "bought|purchased|ordered|paid for|paid",
  file: "saved|wrote|written|created|exported",
  download: "downloaded",
};
/** A sentence that only offers, plans, asks or denies claims nothing. */
const NOT_A_CLAIM = /\b(?:not|never|haven't|hasn't|didn't|couldn't|can't|cannot|won't|would|will|could|should|can|shall|draft(?:ed|s)?|ready to|about to|want me|if you)\b|\?/i;

/** The kinds of outbound action a reply says it did. */
export function claimedActions(text: string): ActionKind[] {
  const found = new Set<ActionKind>();
  const sentences = text.replace(/```[\s\S]*?```/g, " ").split(/(?<=[.!?])\s+|\n+/);
  for (const sentence of sentences) {
    if (!sentence.trim() || NOT_A_CLAIM.test(sentence)) continue;
    for (const [kind, verbs] of Object.entries(CLAIM_VERBS) as Array<[ActionKind, string]>) {
      if (new RegExp(`${SUBJECT}(?:done[,:]?\\s+)?(?:${verbs})\\b|${PASSIVE}(?:${verbs})\\b`, "i").test(sentence.trim())) found.add(kind);
    }
  }
  return [...found];
}

/** A Composio tool slug as the action it is. */
export function connectorActionKind(slug: string): ActionKind {
  if (/EVENT|BOOK|RESERV|MEETING|APPOINTMENT/.test(slug)) return "book";
  if (/ORDER|PURCHASE|PAYMENT|CHECKOUT|CHARGE|PAY_/.test(slug)) return "buy";
  if (/UPLOAD|CREATE_FILE|WRITE|SAVE|CREATE_DOC|APPEND|CREATE_SPREADSHEET|INSERT_ROW/.test(slug)) return "file";
  return "send";
}

const FILE_TOOL = /^(?:write|edit|multiedit|notebookedit|apply_patch|write_file|edit_file|create_file|str_replace\w*|save_file)\b|\b(?:wrote|created|edited|writing|editing)\s+\S/i;
const BROWSER_ACTION = /agent_browser_(?:click|fill|type|press|select|check|upload|batch|drag)\b/;
const SEND_TOOL = /\b(?:send|reply|forward|post)_?(?:email|message|mail|reply|chat)?\b/i;

/** The evidence one finished tool call gives, read from its title and the command it ran. */
export function toolEvidence(title: string | undefined, summary: string | undefined): Evidence | null {
  const name = (title ?? "").trim();
  const command = (summary ?? "").trim();
  if (BROWSER_ACTION.test(name)) return "browser";
  if (/\b(?:curl|wget)\b[^|;]*(?:\s-o\b|\s-O\b|--output\b)|\bwget\s/.test(command)) return "download";
  if (command) return /(?:^|[\s;&|])(?:cp|mv|tee|touch|mkdir)\s|>{1,2}\s*\S/.test(command) ? "file" : "shell";
  if (FILE_TOOL.test(name)) return "file";
  if (SEND_TOOL.test(name) && !/draft/i.test(name)) return "send";
  return null;
}

export function unbackedClaims(claims: readonly ActionKind[], evidence: ReadonlySet<Evidence>): ActionKind[] {
  return claims.filter((kind) => !BACKED_BY[kind].some((proof) => evidence.has(proof)));
}

export interface ActionReceiptDeps {
  dataDir: string;
  /** The bot whose turn this thread runs, or null for one this does not judge (a room, a hidden thread). */
  botOf(threadId: string): string | null;
  /** Marks the reply this turn ended on; false when there is none. */
  mark(threadId: string, turnId: string | undefined, kinds: ActionKind[]): boolean;
  now?: () => number;
}

interface Turn { turnId?: string; text: string; evidence: Set<Evidence>; pending: Map<string, { title?: string; summary?: string }> }

const MAX_PENDING = 256;
export const RECEIPT_RETENTION_DAYS = 30;
const RECEIPT_FILE = /^(\d{4})-(\d{2})\.jsonl$/;
const PRUNE_EVERY_MS = 60 * 60_000;
const RELAY_FAILED = /"successful"\s*:\s*false|"isError"\s*:\s*true/;

export function createActionReceipts(deps: ActionReceiptDeps) {
  const now = deps.now ?? Date.now;
  const turns = new Map<string, Turn>();
  let lastPrune = 0;
  const writing = new Set<Promise<void>>();
  const turn = (threadId: string): Turn => {
    let current = turns.get(threadId);
    if (!current) turns.set(threadId, current = { text: "", evidence: new Set(), pending: new Map() });
    return current;
  };

  function write(threadId: string, kind: Evidence, what: string): void {
    const botId = deps.botOf(threadId);
    if (!botId) return;
    const at = new Date(now());
    const line = JSON.stringify({ at: at.toISOString(), botId, threadId, turnId: turns.get(threadId)?.turnId, kind, what: what.slice(0, 200) }) + "\n";
    const dir = join(deps.dataDir, "receipts");
    const done: Promise<void> = mkdir(dir, { recursive: true, mode: 0o700 })
      .then(() => appendFile(join(dir, `${at.toISOString().slice(0, 7)}.jsonl`), line, { mode: 0o600 }))
      .then(async () => {
        if (at.getTime() - lastPrune < PRUNE_EVERY_MS) return;
        lastPrune = at.getTime();
        await pruneMonthFiles(dir, RECEIPT_RETENTION_DAYS, at, RECEIPT_FILE);
      })
      .catch((error: unknown) => console.error(`receipts: not written: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => writing.delete(done));
    writing.add(done);
  }

  return {
    /** Resolves once every receipt line written so far is on disk (or failed). */
    async settled(): Promise<void> {
      while (writing.size) await Promise.all(writing);
    },

    /** An outbound call the connected-apps relay carried and its app answered without an error. */
    record(threadId: string, slug: string): void {
      const kind = connectorActionKind(slug);
      turn(threadId).evidence.add(kind);
      write(threadId, kind, slug);
    },

    /** The relay's answer to outbound calls: a receipt for each when the app answered without an error. */
    relayed(threadId: string, slugs: readonly string[], status: number, bytes: Uint8Array): void {
      if (!slugs.length || status >= 300 || RELAY_FAILED.test(new TextDecoder().decode(bytes))) return;
      for (const slug of slugs) this.record(threadId, slug);
    },

    onEvent(event: RuntimeEvent): void {
      const { threadId } = event;
      if (event.type === "turn.started") {
        turns.set(threadId, { ...(event.turnId ? { turnId: event.turnId } : {}), text: "", evidence: new Set(), pending: new Map() });
        return;
      }
      if (event.type === "session.exited") { turns.delete(threadId); return; }
      if (event.type === "item.started" && event.itemType === "tool" && event.itemId) {
        const current = turn(threadId);
        if (current.pending.size >= MAX_PENDING) current.pending.delete(current.pending.keys().next().value!);
        current.pending.set(event.itemId, { title: event.title, summary: event.summary });
        return;
      }
      if (event.type === "item.completed" && event.itemType === "tool" && event.itemId) {
        const current = turn(threadId);
        const started = current.pending.get(event.itemId);
        current.pending.delete(event.itemId);
        const evidence = started && event.ok ? toolEvidence(started.title, started.summary) : null;
        if (!evidence) return;
        current.evidence.add(evidence);
        if (evidence !== "shell") write(threadId, evidence, started?.title ?? "tool");
        return;
      }
      if (event.type === "item.completed" && event.itemType === "assistant_text") {
        turn(threadId).text = event.text;
        return;
      }
      if (event.type !== "turn.completed") return;
      const current = turns.get(threadId);
      turns.delete(threadId);
      if (!current?.text || !event.ok || !deps.botOf(threadId)) return;
      const missing = unbackedClaims(claimedActions(current.text), current.evidence);
      if (missing.length) deps.mark(threadId, event.turnId ?? current.turnId, missing);
    },
  };
}

export type ActionReceipts = ReturnType<typeof createActionReceipts>;
