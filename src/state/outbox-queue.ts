// Unsent messages kept until the server has them: each goes again with its own sendId once the live stream is back,
// and the server never delivers one sendId twice.
import type { Action } from "./store";
import type { OutboxSend, SendOutbox } from "./send-outbox";

/** Where a client keeps its list: the phone's preferences, the desktop's localStorage. */
export interface OutboxPrefs {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** a send older than this is given up on rather than delivered into a conversation that has moved on */
export const OUTBOX_MAX_AGE_MS = 24 * 60 * 60_000;
/** how many times a send may come back without an answer before it is handed back to the person */
export const OUTBOX_MAX_TRIES = 6;
const MAX_ENTRIES = 50;

type Entry = OutboxSend & { tries: number };

function valid(value: unknown): value is Entry {
  const one = value as Partial<Entry> | null;
  return Boolean(one) && (one!.kind === "bot" || one!.kind === "group") && [one!.ownerId, one!.threadId, one!.sendId, one!.text].every((field) => typeof field === "string" && field)
    && typeof one!.at === "number" && typeof one!.tries === "number";
}

export function replayAction(send: OutboxSend): Action {
  const extra = { ...(send.replyToId ? { replyToId: send.replyToId } : {}), ...(send.mode ? { mode: send.mode } : {}), ...(send.mentions?.length ? { mentions: send.mentions } : {}) };
  return send.kind === "bot"
    ? { type: "send", botId: send.ownerId, threadId: send.threadId, text: send.text, sendId: send.sendId, ...extra }
    : { type: "sendGroup", groupId: send.ownerId, threadId: send.threadId, text: send.text, sendId: send.sendId, ...extra };
}

/** A client's copy of its unsent messages, one list per workspace, kept in `prefs`. */
export function createOutbox(prefs: OutboxPrefs, key: string, now: () => number = Date.now) {
  let entries: Entry[] = [];
  const inFlight = new Set<string>();
  let writing = Promise.resolve();
  let flushing = false;
  let send: ((action: Action) => void) | null = null;

  const fresh = (entry: Entry) => now() - entry.at < OUTBOX_MAX_AGE_MS;
  function persist() {
    // wait for the saved list before any write so a hold/release during load cannot replace it
    writing = writing.then(async () => {
      await loaded;
      if (entries.length) await prefs.set(key, JSON.stringify(entries));
      else await prefs.remove(key);
    }).catch(() => {});
  }
  const loaded = (async () => {
    try {
      const saved: unknown = JSON.parse(await prefs.get(key) ?? "[]");
      const known = new Set(entries.map((entry) => entry.sendId));
      // sends held before the saved list was read stay, after the older ones
      const older = Array.isArray(saved) ? saved.filter(valid).filter((entry) => fresh(entry) && !known.has(entry.sendId)) : [];
      entries = [...older, ...entries];
    } catch {}
  })();

  /** one at a time, oldest first, so a conversation gets its messages in the order they were written */
  function next() {
    if (!send) { flushing = false; return; }
    entries = entries.filter(fresh);
    const entry = entries.find((one) => !inFlight.has(one.sendId));
    if (!entry || inFlight.size) { flushing = Boolean(entry && inFlight.size); return; }
    flushing = true;
    send(replayAction(entry));
    if (!inFlight.has(entry.sendId)) flushing = false;
  }

  const outbox: SendOutbox & { flush(dispatch: (action: Action) => void): Promise<void>; pending(): OutboxSend[]; ready: Promise<void> } = {
    hold(one) {
      inFlight.add(one.sendId);
      if (entries.some((entry) => entry.sendId === one.sendId)) return;
      entries.push({ ...one, tries: 0 });
      if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
      persist();
    },
    release(sendId) {
      inFlight.delete(sendId);
      const before = entries.length;
      entries = entries.filter((entry) => entry.sendId !== sendId);
      if (entries.length !== before) persist();
      if (flushing) next();
    },
    keep(sendId) {
      inFlight.delete(sendId);
      const entry = entries.find((one) => one.sendId === sendId);
      if (!entry) return false;
      entry.tries += 1;
      if (entry.tries >= OUTBOX_MAX_TRIES || !fresh(entry)) {
        entries = entries.filter((one) => one !== entry);
        persist();
        if (flushing) next();
        return false;
      }
      persist();
      // the connection is still out: the next flush (reconnect, resume) picks up from here
      flushing = false;
      return true;
    },
    waitBehind(sendId) {
      const index = entries.findIndex((entry) => entry.sendId === sendId);
      if (index < 0) return false;
      const { threadId } = entries[index]!;
      if (!entries.slice(0, index).some((entry) => entry.threadId === threadId && !inFlight.has(entry.sendId) && fresh(entry))) return false;
      inFlight.delete(sendId);
      if (send && !flushing) next();
      return true;
    },
    async flush(dispatch) {
      await loaded;
      send = dispatch;
      if (!flushing) next();
    },
    pending: () => entries.filter(fresh).map(({ tries: _tries, ...entry }) => entry),
    ready: loaded,
  };
  return outbox;
}
