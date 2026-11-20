// A secret the person already wrote in their own message (a NAME=value line, "Hindsight token: x"): the server takes it
// from the stored message, so the model never has to copy the value into a tool call and no card asks for it again.
import type { Message } from "../store.ts";
import { SECRET_VALUE_MAX_BYTES } from "../secret-vault.ts";

/** A pasted block counts for the whole recent conversation, not only the last few turns. */
const RECENT_PERSON_MESSAGES = 200;
const MIN_VALUE_LENGTH = 3;
const LONG_VALUE = 12;
/** Words that say what kind of secret it is, not which: NITTER_KEY, "Nitter access key" and NITTER_API_TOKEN are one. */
const FILLER = new Set(["access", "api", "token", "tokens", "key", "keys", "secret", "secrets", "auth", "bearer", "credential",
  "credentials", "the", "my", "your", "a", "an", "for", "personal", "private", "mcp", "server", "service"]);

const wordsOf = (name: string) => name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Two names for one secret: the same words, or the same words once the kind words (key, token, access...) are set aside. */
export function sameSecretName(a: string, b: string): boolean {
  const left = wordsOf(a), right = wordsOf(b);
  if (!left.length || !right.length) return false;
  if (left.join(" ") === right.join(" ")) return true;
  const core = (words: string[]) => [...new Set(words.filter((word) => !FILLER.has(word)))].sort().join(" ");
  const leftCore = core(left);
  return leftCore !== "" && leftCore === core(right);
}

/** A key, token or address, not a word of prose ("Hindsight token: here it is") or a placeholder. */
function looksLikeValue(value: string): boolean {
  if (value.length < MIN_VALUE_LENGTH || Buffer.byteLength(value) > SECRET_VALUE_MAX_BYTES) return false;
  if (/^<.*>$/.test(value) || /^(?:x+|\.+|\*+|your[_-].*|changeme)$/i.test(value)) return false;
  return /\d/.test(value) || value.length >= LONG_VALUE;
}

const ENV_PAIR = /(?:^|[^\w$])(?:export\s+)?([A-Za-z][A-Za-z0-9_]*)\s*=\s*["'`]?([^\s"'`]+)/g;
const LABEL_PAIR = /^[\s>*\-•]*(?:export\s+)?(\p{L}[\p{L}\p{N}_ .-]{0,60}?)\s*[:=]\s*["'`]?([^\s"'`]+)/u;
/** "Here's the token for our Telegram bot: 77…": a value after a colon and a space at the end of a sentence's words. */
const PROSE_PAIR = /(\p{L}[\p{L}\p{N}_ .'’-]{0,80}?):\s+["'`]?([^\s"'`]+)/u;

type Named = { name: string; value: string; prose?: true };

/** Every name and value written as NAME=value or "Some name: value" in a text, in reading order. A prose pair's name is
 * the whole sentence before its colon, so it only matches a name all of whose words it holds. */
export function namedValues(text: string): Named[] {
  const out: Named[] = [];
  for (const line of text.split(/\r?\n/)) {
    const labelled = LABEL_PAIR.exec(line);
    if (labelled) out.push({ name: labelled[1]!.trim(), value: labelled[2]! });
    else {
      const prose = PROSE_PAIR.exec(line);
      if (prose) out.push({ name: prose[1]!.trim(), value: prose[2]!, prose: true });
    }
    for (const pair of line.matchAll(ENV_PAIR)) {
      if (!labelled || pair[1] !== labelled[1]!.trim()) out.push({ name: pair[1]!, value: pair[2]! });
    }
  }
  return out.map((pair) => ({ ...pair, value: pair.value.replace(/[,;.]+$/, "") })).filter(({ value }) => looksLikeValue(value));
}

function names(pair: Named, name: string): boolean {
  if (sameSecretName(pair.name, name)) return true;
  if (!pair.prose) return false;
  const held = new Set(wordsOf(pair.name));
  const wanted = wordsOf(name).filter((word) => !FILLER.has(word));
  return wanted.length > 0 && wanted.every((word) => held.has(word));
}

/** The value written under a name that means `name` in one text, if any. */
export function valueUnderName(text: string, name: string): string | null {
  return namedValues(text).find((pair) => names(pair, name))?.value ?? null;
}

/** The newest value the person wrote under any of `names` in their own messages on this branch; never a bot's text.
 * A message that is nothing but a key, sent while a card asking for one of `names` was the bot's last word, is that
 * key: the person answered the card in the chat. */
export function pastedSecret(path: readonly Message[], wanted: readonly string[]): string | null {
  let seen = 0;
  for (let index = path.length - 1; index >= 0 && seen < RECENT_PERSON_MESSAGES; index--) {
    const message = path[index]!;
    if (message.role !== "user" || typeof message.text !== "string") continue;
    seen++;
    const pairs = namedValues(message.text).reverse();
    for (const pair of pairs) if (wanted.some((name) => names(pair, name))) return pair.value;
    const bare = bareKey(message.text);
    if (bare && askedJustBefore(path, index, wanted)) return bare;
  }
  return null;
}

const BARE_KEY_MIN = 16;

/** One word that reads as a key or token: long, with letters and digits, no spaces. */
function bareKey(text: string): string | null {
  const value = text.trim().replace(/^["'`]|["'`]$/g, "");
  if (value.length < BARE_KEY_MIN || /\s/.test(value) || !/\d/.test(value) || !/\p{L}/u.test(value)) return null;
  return looksLikeValue(value) ? value : null;
}

/** The bot's last word before the person's message at `index` included a card asking for one of `wanted`, still open. */
function askedJustBefore(path: readonly Message[], index: number, wanted: readonly string[]): boolean {
  for (let before = index - 1; before >= 0; before--) {
    const message = path[before]!;
    if (message.role === "user") return false;
    const asked = message.kind === "secret" ? message.secret : undefined;
    if (asked && !asked.dismissed && !asked.stopped && asked.savedAt === undefined && !asked.provided &&
      wanted.some((name) => sameSecretName(asked.label, name))) return true;
  }
  return false;
}
