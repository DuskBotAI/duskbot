// The open-item ledger of a one-on-one chat: each distinct ask of the person's (the message that starts a turn, or a
// separate ask the side responder hands into a running turn) is open until a turn delivers it, sets it waiting, or says
// what blocks it, or until the person stops it. The state lives on the ask's own message row, so it survives a restart
// and goes with the conversation; the finish guard sends a turn back once for an ask it leaves open, and the bot sees
// the asks still open from earlier in one short line at the top of its next turn.
import type { Message, Store } from "../store.ts";
import { settleAsks, type Ask, type AskState, type TurnForAsks } from "../turn-stop-gates.ts";

/** Asks older than this are not counted or shown any more; the row keeps its state. */
export const ASK_FRESH_MS = 48 * 60 * 60_000;
export const ASKS_SHOWN = 4;
const ASK_WORDS = 100;
const ROWS_READ = 200;

export interface OpenAsksDeps {
  store: Pick<Store, "activePath" | "patchMessage">;
  /** Teammates or threads still work for this chat's request, whether or not the engine reported the call. */
  handedOff?(threadId: string): boolean;
  now?: () => number;
}

const words = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > ASK_WORDS ? `${flat.slice(0, ASK_WORDS - 1)}…` : flat;
};

export function createOpenAsks(deps: OpenAsksDeps) {
  const now = deps.now ?? Date.now;
  const rows = (threadId: string): Message[] => deps.store.activePath(threadId).slice(-ROWS_READ)
    .filter((row) => row.role === "user" && row.ask !== undefined && now() - row.at < ASK_FRESH_MS);
  const set = (threadId: string, row: Message, state: AskState, nudged = row.ask?.nudged) =>
    deps.store.patchMessage(threadId, row.id, { ask: { state, ...(nudged ? { nudged: true as const } : {}) } });
  const open = (threadId: string) => rows(threadId).filter((row) => row.ask!.state === "open");

  return {
    /** The person's message is a new ask; a row that already is one, or has no words, is left as it is. */
    opened(threadId: string, messageId: string): void {
      const row = deps.store.activePath(threadId).slice(-ROWS_READ).findLast((one) => one.id === messageId);
      if (!row || row.role !== "user" || row.ask !== undefined || !row.text?.trim()) return;
      deps.store.patchMessage(threadId, row.id, { ask: { state: "open" } });
    },

    /** A turn failed: the failure it shows names what blocked every ask still open. */
    failed(threadId: string): void {
      for (const row of open(threadId)) set(threadId, row, "blocked");
    },

    /** The person stopped the work: every ask still open in the chat is theirs to drop. */
    dropped(threadId: string): void {
      for (const row of open(threadId)) set(threadId, row, "dropped");
    },

    open(threadId: string): Ask[] {
      return open(threadId).map((row) => ({ id: row.id, text: words(row.text ?? ""), state: "open" }));
    },

    /** Moves the open asks a finished turn delivered, set waiting or named blocked; returns the words of those still open
     * that the bot was never sent back for. */
    settle(threadId: string, turn: TurnForAsks): string[] {
      const before = open(threadId);
      if (!before.length) return [];
      const changes = new Map(settleAsks(before.map((row) => ({ id: row.id, text: row.text ?? "", state: "open" as const })), { ...turn, handedOff: turn.handedOff || (deps.handedOff?.(threadId) ?? false) }).map((one) => [one.id, one.state]));
      for (const row of before) {
        const state = changes.get(row.id);
        if (state) set(threadId, row, state);
      }
      return before.filter((row) => !changes.has(row.id) && !row.ask!.nudged).map((row) => words(row.text ?? ""));
    },

    /** The bot was sent back for the asks still open; it is never sent back for them again. */
    nudged(threadId: string): void {
      for (const row of open(threadId)) if (!row.ask!.nudged) set(threadId, row, "open", true);
    },

    /** The line in front of a turn's message naming the asks still open from earlier, or "" when there are none. */
    note(threadId: string, currentMessageId?: string): string {
      const earlier = open(threadId).filter((row) => row.id !== currentMessageId).slice(-ASKS_SHOWN);
      return earlier.length ? `Open items: ${earlier.map((row) => `"${words(row.text ?? "")}"`).join("; ")}\n\n` : "";
    },
  };
}

export type OpenAsks = ReturnType<typeof createOpenAsks>;
