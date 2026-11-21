import { credentialResumeOutcome } from "../../shared/credential-request";
import { firstCredential } from "../../shared/redact";
import type { Message } from "@/state/store";

// Security: a key typed into the composer would be kept in the chat and handed to the engine as written. Sending one
// takes the person's choice; the safe one moves it into an open Secrets card or out of the words.

export type KeyInSend = { key: string; cardId: string | null };

/** The newest Secrets card in the chat that still takes a value. */
export function openSecretCard(messages: readonly Message[] | undefined): Message | null {
  if (!messages) return null;
  for (let index = messages.length - 1; index >= 0; index--) {
    const secret = messages[index]?.secret;
    if (!secret) continue;
    if (credentialResumeOutcome(secret) === null && !secret.superseded && !secret.stopped) return messages[index]!;
  }
  return null;
}

/** The credential in words about to be sent, with the open Secrets card it belongs in; null when there is none. */
export function keyInSend(text: string, messages: readonly Message[] | undefined): KeyInSend | null {
  const key = firstCredential(text);
  return key ? { key, cardId: openSecretCard(messages)?.id ?? null } : null;
}

const tidy = (text: string) => text.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+$/gm, "").trim();

/** The words with one credential taken out; any other stays, to be caught by the next send. */
export function withoutKey(text: string, key: string): string {
  return tidy(text.replace(key, ""));
}

/** The words with every credential taken out. */
export function withoutKeys(text: string): string {
  let out = text;
  for (let key = firstCredential(out); key; key = firstCredential(out)) out = out.replace(key, "");
  return tidy(out);
}

const offered = new Map<string, string>();
const watchers = new Set<() => void>();

/** Hands a value to the Secrets card `cardId`, which takes it into its private field. */
export function offerToSecretCard(cardId: string, value: string): void {
  offered.set(cardId, value);
  for (const watch of Array.from(watchers)) watch();
}

/** The value offered to `cardId`, once. */
export function takeOfferedSecret(cardId: string): string | undefined {
  const value = offered.get(cardId);
  offered.delete(cardId);
  return value;
}

export function watchOfferedSecrets(watch: () => void): () => void {
  watchers.add(watch);
  return () => { watchers.delete(watch); };
}
