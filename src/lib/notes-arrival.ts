// Notes from another AI on their way in, as the chat shows it: the waiting card above the message box says they came
// (from Downloads, a dropped file or a paste) for a few seconds, and the first bot's working row says what it is setting
// up while the import runs. Nothing about an import is ever said inside the message box. Held outside the app reducer.
import { useSyncExternalStore } from "react";

export type NotesVia = "downloads" | "drop" | "paste";

/** How long the card says the notes came before it goes. */
export const ARRIVAL_SHOWN_MS = 3_000;
/** A failure stays a little longer, so it can be read. */
export const ARRIVAL_FAILED_MS = 8_000;

export interface NotesArrival {
  via: NotesVia;
  /** The chat it came into; Downloads' is the first bot's. */
  botId: string | null;
  at: number;
  /** Set when reading it failed: the card says so instead. */
  failed?: string;
  /** Set when it was taken in at once (a Grok Bot's export): what came. */
  done?: string;
}

let arrival: NotesArrival | null = null;
/** The bot doing the import, and its working row's words now. */
let work: { botId: string; label: string } | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
const changed = () => { for (const listener of Array.from(listeners)) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

function hideAfter(ms: number) {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideTimer = null;
    arrival = null;
    changed();
  }, ms);
}

/** The notes came: the card says so for ARRIVAL_SHOWN_MS, then goes. */
export function noteArrival(via: NotesVia, botId: string | null, now = Date.now()): void {
  arrival = { via, botId, at: now };
  hideAfter(ARRIVAL_SHOWN_MS);
  changed();
}

/** They couldn't be read: the card says why for ARRIVAL_FAILED_MS. */
export function arrivalFailed(line: string, now = Date.now()): void {
  arrival = { via: arrival?.via ?? "paste", botId: arrival?.botId ?? null, at: now, failed: line };
  hideAfter(ARRIVAL_FAILED_MS);
  changed();
}

/** It was taken in: the card says what came for ARRIVAL_FAILED_MS, so it can be read. */
export function arrivalDone(line: string, now = Date.now()): void {
  arrival = { via: arrival?.via ?? "paste", botId: arrival?.botId ?? null, at: now, done: line };
  hideAfter(ARRIVAL_FAILED_MS);
  changed();
}

export function dismissArrival(): void {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = null;
  if (!arrival) return;
  arrival = null;
  changed();
}

export const notesArrival = () => arrival;
export function useNotesArrival(): NotesArrival | null {
  return useSyncExternalStore(subscribe, notesArrival, () => null);
}

/** The import's step, on `botId`'s working row; null ends it. */
export function setNotesWork(botId: string, label: string | null): void {
  const next = label ? { botId, label } : null;
  if (!next && work?.botId !== botId) return;
  if (next && work && work.botId === next.botId && work.label === next.label) return;
  work = next;
  changed();
}

export const notesWork = () => work;
/** What `botId`'s working row says while it brings notes in; null when it isn't. */
export function useNotesWork(botId: string | undefined): string | null {
  return useSyncExternalStore(subscribe, () => (botId && work?.botId === botId ? work.label : null), () => null);
}

export function resetNotesArrivalForTests(): void {
  dismissArrival();
  work = null;
}
