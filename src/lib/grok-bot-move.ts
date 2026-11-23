import { useEffect, useRef, useState } from "react";

import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { api, ApiError } from "@/state/store";
import { GROK_EXPORT_FORMAT, GROK_EXPORT_MAX_CHARS } from "../../shared/grok-import";
import {
  GROK_MOVE_ROUTES as R,
  type GrokAcceptExportRequest, type GrokAcceptExportResult, type GrokDetection, type GrokExportApplied, type GrokExportProblem, type GrokMoveChoice,
  type GrokMoveProgress, type GrokMoveStep, type GrokRequestText, type GrokSliceProblem, type GrokUndoPreview, type GrokUndoResult, type GrokWaitingList,
} from "../../shared/grok-move";
import { externalOpener } from "./app-links";

export interface GrokMoveClient {
  detect(): Promise<GrokDetection>;
  start(bots: GrokMoveChoice[]): Promise<GrokMoveProgress>;
  /** null when there has been no move. */
  progress(): Promise<GrokMoveProgress | null>;
  stop(): Promise<GrokMoveProgress>;
  undoPreview(moveId: string): Promise<GrokUndoPreview>;
  undo(moveId: string): Promise<GrokUndoResult>;
  waiting(): Promise<GrokWaitingList>;
  request(rosterId: string): Promise<GrokRequestText>;
  accept(body: GrokAcceptExportRequest): Promise<GrokAcceptExportResult>;
}

const post = <T,>(path: string, body: unknown) => api<T>(path, { method: "POST", body: JSON.stringify(body) });

export const grokMoveApi: GrokMoveClient = {
  detect: () => api<GrokDetection>(R.detect, { timeoutMs: 15_000 }),
  start: (bots) => post(R.start, { bots }),
  progress: () => api<GrokMoveProgress>(R.progress).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }),
  stop: () => post(R.stop, {}),
  undoPreview: (moveId) => api<GrokUndoPreview>(`${R.undo}?moveId=${encodeURIComponent(moveId)}`),
  undo: (moveId) => post(R.undo, { moveId, confirm: true }),
  waiting: () => api<GrokWaitingList>(R.waiting),
  request: (rosterId) => post(R.request, { rosterId }),
  accept: (body) => post(R.acceptExport, body),
};

const OPEN_EVENT = "dusk:open-grok-move";

/** `result`: the last move's result, when there was one (Settings' "Waiting for 3 bots"); otherwise what was found. */
export interface GrokMoveOpen { at?: "result" }

let asked: GrokMoveOpen = {};

export function openGrokMove(options: GrokMoveOpen = {}): void {
  asked = options;
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export function useGrokMoveRequests(onOpen: (options: GrokMoveOpen) => void): void {
  const latest = useRef(onOpen);
  latest.current = onOpen;
  useEffect(() => {
    const open = () => latest.current(asked);
    window.addEventListener(OPEN_EVENT, open);
    return () => window.removeEventListener(OPEN_EVENT, open);
  }, []);
}

const CHANGED_EVENT = "dusk:grok-move-changed";
/** A move, an undo or an export changed what the entry points show. */
export const grokMoveChanged = () => window.dispatchEvent(new Event(CHANGED_EVENT));

/** What the entry points show of Grok Bot here: what was found, the last move and the bots still awaited. Looks again
 * when a move changes something, and every few seconds while a bot is awaited. */
export function useGrokMoveSummary(enabled: boolean, client: GrokMoveClient = grokMoveApi) {
  const [summary, setSummary] = useState<{ detection: GrokDetection; last: GrokMoveProgress | null; waiting: GrokWaitingList } | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const again = () => setRound((n) => n + 1);
    window.addEventListener(CHANGED_EVENT, again);
    return () => window.removeEventListener(CHANGED_EVENT, again);
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void Promise.all([client.detect(), client.progress().catch(() => null), client.waiting().catch(() => ({ bots: [], waiting: 0 }))])
      .then(([detection, last, waiting]) => alive && setSummary({ detection, last, waiting }), () => {});
    return () => { alive = false; };
  }, [client, enabled, round]);
  const waiting = summary?.waiting.waiting ?? 0;
  useEffect(() => {
    if (!enabled || !waiting) return;
    const timer = setInterval(() => setRound((n) => n + 1), 5_000);
    return () => clearInterval(timer);
  }, [enabled, waiting]);
  return summary;
}

/** Opens Grok Bot on that bot with the request typed; false when this app cannot open it. */
export async function openInGrokBot(url: string, opener = externalOpener()): Promise<boolean> {
  if (!opener) return false;
  try {
    await opener(url);
    return true;
  } catch {
    return false;
  }
}

/** The request itself, pasted here instead of in Grok Bot. */
export const isGrokRequest = (text: string) => text.includes("I am moving you to dusk bot");

/** A bot's own export, written for the request: it goes to the bot it is for, never into a chat. */
export function looksLikeGrokExport(text: string): boolean {
  return text.length <= GROK_EXPORT_MAX_CHARS && text.includes(GROK_EXPORT_FORMAT) && text.includes("{");
}

export const grokProblemText = (problem: Pick<GrokExportProblem, "code" | "keys">): string =>
  t(`grokBotMove.problem.${problem.code}` as LocaleKey, { keys: (problem.keys ?? []).join(", ") });

export const sliceProblemText = (problem: GrokSliceProblem): string =>
  t(`grokBotMove.slice.${problem.slice}.${problem.code}` as LocaleKey);

export const stepText = (step: GrokMoveStep | undefined): string => t(`grokBotMove.step.${step ?? "profile"}` as LocaleKey);

const counted = (count: number, one: LocaleKey, many: LocaleKey) => (count === 1 ? t(one) : t(many, { count }));

/** "instructions, 42 memories, 3 skills, 5 routines (paused)" */
export function appliedParts(applied: GrokExportApplied): string[] {
  const memories = applied.memories + applied.facts;
  return [
    ...(applied.instructions ? [t("grokBotMove.got.instructions")] : []),
    ...(memories ? [counted(memories, "grokBotMove.got.memoryOne", "grokBotMove.got.memories")] : []),
    ...(applied.skills ? [counted(applied.skills, "grokBotMove.got.skillOne", "grokBotMove.got.skills")] : []),
    ...(applied.routines.length ? [counted(applied.routines.length, "grokBotMove.got.routineOne", "grokBotMove.got.routines")] : []),
  ];
}

/** What the person still has to do after an export came: skills to check, routines to set, apps to connect. */
export function appliedNeeds(applied: GrokExportApplied): string[] {
  return [
    ...(applied.skillsOff ? [counted(applied.skillsOff, "grokBotMove.need.skillOne", "grokBotMove.need.skills")] : []),
    ...(applied.routinesToSet.length ? [counted(applied.routinesToSet.length, "grokBotMove.need.routineOne", "grokBotMove.need.routines")] : []),
    ...(applied.apps.length ? [counted(applied.apps.length, "grokBotMove.need.appOne", "grokBotMove.need.apps")] : []),
  ];
}

/** One line for a dropped or pasted export: what came, for whom, or why it could not be used. */
export function acceptLine(result: GrokAcceptExportResult, list: (parts: string[]) => string): { line: string; failed: boolean } {
  const problem = result.problems[0];
  if (!result.applied.length) return { line: problem ? grokProblemText(problem) : t("grokBotMove.problem.unusable"), failed: true };
  const names = list(result.applied.map((bot) => bot.name));
  return { line: t("grokBotMove.accepted", { names }), failed: false };
}
