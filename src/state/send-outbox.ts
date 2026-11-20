// A place the phone app keeps sends that have not reached the server, so they survive a lost connection and a restart.
// The store reports each send's fate; the outbox sends what is left again later with the same sendId, which the server
// never delivers twice.

export interface OutboxSend {
  kind: "bot" | "group";
  /** the bot's or the room's id */
  ownerId: string;
  threadId: string;
  sendId: string;
  text: string;
  replyToId?: string;
  mode?: "chat" | "goal";
  mentions?: string[];
  at: number;
}

export interface SendOutbox {
  /** before the first attempt */
  hold(send: OutboxSend): void;
  /** the server took it, or refused it for good */
  release(sendId: string): void;
  /** its answer never came back: true when the outbox keeps it to send later, so the store leaves it on screen */
  keep(sendId: string): boolean;
  /** an earlier send in its chat already waits here: true when this one waits behind it instead of going now */
  waitBehind(sendId: string): boolean;
}

/** A send that went into the outbox behind an earlier one in its chat, to go after it. */
export class QueuedBehindError extends Error {
  constructor() { super("The message waits behind an earlier one in this chat."); this.name = "QueuedBehindError"; }
}

let installed: SendOutbox | null = null;

export function installSendOutbox(outbox: SendOutbox): () => void {
  installed = outbox;
  return () => { if (installed === outbox) installed = null; };
}

export const sendOutbox = (): SendOutbox | null => installed;
