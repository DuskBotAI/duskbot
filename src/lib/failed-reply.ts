// grok's failed-reply card: what stopped the newest replies, one card above the composer, never a row in the chat.
import { offersSignIn } from "@/components/EngineSetup";
import { statusActivity } from "@/lib/activity-runs";
import { t } from "@/lib/i18n";
import { peerLine } from "@/lib/peer-message";
import { isReceipt } from "@/lib/receipts";
import type { LocaleKey } from "@/locales";
import type { InstanceInfo, Message } from "@/state/store";
import { failedTurnCause, type BrowserBlocker } from "../../shared/failed-turn";
import { isCancelledTranscriptRow } from "../../shared/client-cancel";
import { freeFallback } from "../../shared/ai-ranking";
import { errorKind, rowFailureKind, type ErrorKind, type FailureKind } from "../../shared/failure-plan";

export type FailedReplyKind = FailureKind;

/** A failed turn's row: a reply that never came, not one that came back with a step that failed. */
export function isFailedReply(message: Message): boolean {
  const tool = message.tool;
  return message.kind === "activity" && Boolean(tool) && failedTurnCause(tool!.name) !== null && !tool!.partial && !isCancelledTranscriptRow(message);
}

/** A turn that ended without a word from its AI: no error row says it, so the card does. */
export function isUnansweredTurn(message: Message): boolean {
  return Boolean(message.tool?.rescue?.over);
}

/** A notice line a bot's turn left (a sign-out, a limit, a switch to another AI); never a live rescue or a stop. */
export function isFoldableNotice(message: Message): boolean {
  const status = statusActivity(message);
  return status !== null && status.kind !== "stopped" && !message.tool?.rescue;
}

/** A failure stops being news after a day: by then it says nothing about how the bot is now. */
export const FAILED_REPLY_STALE_MS = 24 * 60 * 60 * 1000;

/** A failed reply the card no longer shows: its cause was fixed since (the server marks it), or it is a day old. */
export function isStaleFailure(message: Message, now = Date.now()): boolean {
  return Boolean(message.tool?.resolvedAt) || now - message.at > FAILED_REPLY_STALE_MS;
}

/** The rows nothing has followed, since the person last wrote: per bot, its newest failed reply, and the notices after
 * its newest other row. A reply, a new message or a stop clears them, and so does fixing the cause or a day passing. */
export function trailingRows(messages: readonly Message[], scan = 200, now = Date.now()): { failures: Message[]; notices: Message[] } {
  const settled = new Set<string>();
  const failures: Message[] = [];
  const notices: Message[] = [];
  for (let i = messages.length - 1; i >= 0 && i >= messages.length - scan; i -= 1) {
    const m = messages[i]!;
    if (m.role === "user" && !peerLine(m)) break;
    // what the turn's end leaves around its outcome (receipts, a digest, a call's record) is no newer reply
    if (isReceipt(m) || m.kind === "digest" || m.kind === "compaction" || m.kind === "call") continue;
    const who = m.from?.botId ?? "";
    if (settled.has(who)) continue;
    if (isFoldableNotice(m)) { notices.push(m); continue; }
    settled.add(who);
    if ((isFailedReply(m) || isUnansweredTurn(m)) && !isStaleFailure(m, now)) failures.push(m);
  }
  return { failures: failures.reverse(), notices: notices.reverse() };
}

// the runtime's own words for a turn a restart cut, whose steps it lists (server/runtime/tree.ts INTERRUPTED_OUTWARD)
const RESTART_DID = /\bafter it already (.+?); not resumed\b/;

// the app's names before it became dusk bot, as older stored errors still say them
const OLD_NAMES = /\b(?:OpenMausBot|OpenMaus|Open Maus Bot|MausBot|Maus Bot)\b/g;
const OLD_IMAGE = /^The VPS container uses an incompatible or untrusted (?:OpenMausBot|OpenMaus|MausBot|dusk bot) image\b/i;

/** A stored error in today's words: a known old computer error becomes its plain line, old app names become dusk bot. */
export function currentFailureWords(text: string): string {
  if (OLD_IMAGE.test(text.trim())) return t("failedReply.computerOutdated");
  return text.replace(OLD_NAMES, "dusk bot");
}

/** What a turn a restart cut had already done outside, in the server's words: "sent an email (gmail_send)". */
export function restartAlreadyDid(cause: string): string | null {
  return RESTART_DID.exec(cause)?.[1]?.trim() || null;
}

/** What the free backup running out, being rate limited or not answering reads as: with no AI of the person's own none
 * of these is a failure they can fix by trying harder, only by connecting one. */
const FREE_BACKUP_DOWN: ReadonlySet<ErrorKind> = new Set(["out_of_credit", "usage_limit", "busy", "no_reply", "model", "ai_setup", "other"]);

/** What stopped a failed row, read the one way the server reads it, then what this app knows now: an AI signed in again
 * since is no longer the fix, and `ownAi` (an AI the person connected is ready) means connecting one isn't either. */
export function failedReplyKind(tool: NonNullable<Message["tool"]>, engine: InstanceInfo | undefined, ownAi = false): FailedReplyKind {
  let kind = rowFailureKind(tool);
  // an AI that runs on a key the person pasted is fixed by a new key, never by signing in
  if (kind === "signed_out" && (engine?.access === "api" || engine?.access === "custom")) kind = "key_rejected";
  if (kind === "signed_out" && engine?.snapshot?.state === "available" && engine.snapshot.authenticated !== false) kind = "other";
  if (kind === "no_ai" && ownAi) kind = "other";
  return !ownAi && FREE_BACKUP_DOWN.has(errorKind(kind)) && (!engine || freeFallback(engine)) ? "no_ai" : kind;
}

/** What stopped a reply, in the card's plain words, when its engine words say a reason; null for any other failure. */
export function plainFailureWords(cause: string): string | null {
  const kind = errorKind(rowFailureKind({ name: cause }));
  return kind === "busy" || kind === "no_reply" ? t(WORDS[kind], { engine: t("failedReply.yourAi") }) : null;
}

/** Most actionable first: when bots fail for different reasons, the card says the one a person can fix. */
const PRIORITY: ErrorKind[] = ["repeating", "no_ai", "signed_out", "key_rejected", "ai_setup", "folder", "out_of_credit", "plan", "usage_limit", "model", "chat_full", "computer",
  "interrupted", "busy", "no_reply", "other"];

export function mostActionable<T extends { kind: FailedReplyKind }>(items: readonly T[]): T | undefined {
  return [...items].sort((a, b) => PRIORITY.indexOf(errorKind(a.kind)) - PRIORITY.indexOf(errorKind(b.kind)))[0];
}

/** Each kind's one sentence; a place, a stopped browser run and a Claude update bring their own words. */
const WORDS: Record<Exclude<ErrorKind, "signed_out" | "computer" | "repeating">, LocaleKey> = {
  key_rejected: "failedReply.keyRejected",
  plan: "failedReply.plan",
  folder: "failedReply.folder",
  out_of_credit: "failedReply.credits",
  usage_limit: "failedReply.usageLimit",
  busy: "failedReply.busy",
  no_reply: "failedReply.noReply",
  model: "failedReply.model",
  chat_full: "failedReply.context",
  ai_setup: "failedReply.cliMissing",
  no_ai: "failedReply.noAi",
  interrupted: "failedReply.restarted",
  other: "failedReply.other",
};

/** The card's one plain sentence for a kind. Never the engine's or the server's own words: those stay in the server's
 * log under the row's reference code. */
export function failedReplyDetail(kind: FailedReplyKind, engineName: string, onServer: boolean): string {
  const named = errorKind(kind);
  if (named === "signed_out") return t(onServer ? "failedReply.signedOutServer" : "failedReply.signedOutHere", { engine: engineName });
  if (kind === "claude_update") return t("chat.claudeUpdate.offer");
  if (named === "computer" || named === "repeating") return t("error.plain.generic");
  return t(WORDS[named], { engine: engineName });
}

/** Why dusk bot stopped a browser run itself, in one line. */
/** A failed row as a list previews it: the plain line its failure card leads with, never the engine's raw words. */
export function failurePreviewLine(tool: NonNullable<Message["tool"]>, engine: InstanceInfo | undefined): string {
  const kind = failedReplyKind(tool, engine, true);
  if (kind === "blocker" && tool.blocker) return blockerDetail(tool.blocker);
  return failedReplyDetail(kind, engine?.displayName ?? t("failedReply.yourAi"), false);
}

export function blockerDetail(blocker: BrowserBlocker): string {
  const site = blocker.site ?? "";
  if (blocker.kind === "loop") return site ? t("chat.blocker.loopOn", { site }) : t("chat.blocker.loop");
  return t(blocker.kind === "credentials" ? "chat.blocker.credentials" : blocker.kind === "credit" ? "chat.blocker.credit" : "chat.blocker.blocked", { site: site || t("chat.blocker.theSite") });
}

/** "Bot failed to respond" in a direct chat; in a group, who: "Echo couldn't respond", "Echo, Quill and 2 more couldn't respond". */
export function failedReplyTitle(names: readonly string[], group: boolean): string {
  const unique = [...new Set(names.filter(Boolean))];
  if (!group || unique.length === 0) return t("failedReply.title");
  if (unique.length === 1) return t("failedReply.titleOne", { name: unique[0]! });
  if (unique.length === 2) return t("failedReply.titleTwo", { first: unique[0]!, second: unique[1]! });
  return t("failedReply.titleMore", { first: unique[0]!, second: unique[1]!, count: unique.length - 2 });
}

/** A sign-in the app can open for this engine. */
export function canOfferSignIn(kind: FailedReplyKind, engine: InstanceInfo | undefined): boolean {
  return kind === "signed_out" && offersSignIn(engine);
}
