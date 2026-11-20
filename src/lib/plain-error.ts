import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { requestTooLargeModel } from "../../shared/request-too-large";
import { isStaleChunkError, STALE_CHUNK } from "./stale-chunks";

const UNREACHABLE = /^(?:TypeError:\s*)?(?:Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed|fetch failed)$/i;
const TIMED_OUT = /^(?:TimeoutError:\s*)?(?:The operation was aborted due to timeout|signal timed out|The operation timed out\.?)$/i;
const ABORTED = /^(?:AbortError:\s*)?(?:The operation was aborted\.?|This operation was aborted\.?|The user aborted a request\.?|signal is aborted without reason|Aborted\.?)$/i;
// what a slip in the app's own code throws: never words for a person
const PROGRAMMER = /\bCannot read properties of (?:undefined|null)\b|\b(?:undefined|null) is not an object\b|\bMaximum call stack size exceeded\b|^[\w$]+(?:\.[\w$]+)*(?:\(\.\.\.\))? is (?:not a function|not iterable|not a constructor|not defined|undefined|null)\.?$/;

const TECHNICAL: RegExp[] = [
  UNREACHABLE,
  TIMED_OUT,
  ABORTED,
  STALE_CHUNK,
  PROGRAMMER,
  /^\d{3}(?: [A-Za-z][\w '-]*)?$/,
  /[{[]\s*"[\w$-]+"\s*:/,
  /\n\s+at \S/,
  /^[A-Z][a-z]+Error: /,
  /\b(?:E(?:CONNRESET|CONNREFUSED|CONNABORTED|NOTFOUND|AI_AGAIN|TIMEDOUT|PIPE|ACCES|PERM|NOENT|ADDRINUSE|HOSTUNREACH|NETUNREACH)|ERR_[A-Z_]{3,})\b/,
  /^(?:[\w-]+ ){0,2}(?:API Error|HTTP|status(?: code)?)[:\s]+\d{3}\b/i,
  /Unexpected token .* in JSON|is not valid JSON|Unexpected end of JSON input/,
  /^\S+(?: \S+){0,2} exited (?:with code )?(?:-?\d+|null|SIG[A-Z0-9]+)\b/,
  /^[a-z]+(?:_[a-z0-9]+)+$/,
  // a JSON-RPC -32603 from an engine's agent server: what follows is its own internals (once, the whole prompt it was sent)
  /^Internal error\b/i,
  // the chat-completions drivers' own protocol failures (server/drivers/openai-chat*.ts)
  /^provider (?:stream|returned|reasoning|tool calls)\b/i,
  // nobody reads a wall of engine text in a one-line card
  /^[\s\S]{280,}$/,
];

const KINDS: Array<[RegExp, LocaleKey]> = [
  [STALE_CHUNK, "error.plain.updated"],
  [UNREACHABLE, "error.plain.unreachable"],
  [ABORTED, "error.plain.timeout"],
  [/\b429\b|rate.?limit|too many requests/i, "error.plain.rateLimited"],
  [/overloaded|\b529\b|\b503\b|capacity|service unavailable/i, "error.plain.busy"],
  [/ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|socket hang up|connection (?:reset|refused)/i, "error.plain.connection"],
  [/timeout|timed out|ETIMEDOUT/i, "error.plain.timeout"],
  [/\b(?:EACCES|EPERM)\b/, "error.plain.permission"],
  [/\b40[13]\b|unauthori[sz]ed|forbidden/i, "error.plain.access"],
  [/\b404\b|not found|ENOENT/i, "error.plain.notFound"],
  [/\b413\b|too large/i, "error.plain.tooLarge"],
  [/\b5\d\d\b|internal server error|bad gateway/i, "error.plain.server"],
];

/** Which plain-words kind a raw error reads as, whether or not it is technical; null for none of them. */
export function plainErrorKind(raw: string): LocaleKey | null {
  return KINDS.find(([pattern]) => pattern.test(raw))?.[1] ?? null;
}

export function isTechnicalError(raw: string): boolean {
  const text = raw.trim();
  return Boolean(text) && TECHNICAL.some((pattern) => pattern.test(text));
}

const STATUS_PREFIX = /^(?:[\w-]+ ){0,2}(?:API Error|HTTP|status(?: code)?)[:\s]+\d{3}\b[\s:.-]*/i;

const REASON_PHRASE = /^(?:[A-Z][a-z]+ ?){1,4}\.?$/;

/** The provider's own plain sentence after a status line ("HTTP 400: Invalid model id."), or undefined. */
export function providerSentence(raw: string): string | undefined {
  const text = raw.trim();
  const rest = text.replace(STATUS_PREFIX, "").trim();
  return rest !== text && /[A-Za-z]+\s+[A-Za-z]+/.test(rest) && !REASON_PHRASE.test(rest) && !isTechnicalError(rest) ? rest : undefined;
}

export function plainErrorLine(raw: string): string | undefined {
  const tooLargeFor = requestTooLargeModel(raw);
  if (tooLargeFor) return t("chat.error.requestTooLarge", { model: tooLargeFor });
  if (!isTechnicalError(raw)) return undefined;
  const text = raw.trim();
  const rest = providerSentence(text);
  if (rest) return rest;
  const key = KINDS.find(([pattern]) => pattern.test(text))?.[1] ?? "error.plain.generic";
  return t(key);
}

// things only a developer reads: an address, a file of the app's own code, an Electron call's wrapper
const RAW_FOR_PEOPLE: RegExp[] = [
  /\b(?:https?|file|wss?|blob|chrome-extension|app):\/\/\S/i,
  /(?:^|[\s(/@])[\w.@~-]*\/[\w./@~-]*\.(?:m?jsx?|cjs|tsx?|css|map|json|node|wasm)\b/i,
  /\bnode_modules\b|\/@(?:fs|id|vite)\//,
  /^[\w.]*Error$/,
];
const STACKED = /\n\s+at \S/;
const IPC_PREFIX = /^Error invoking remote method '[^']*': (?:\w*Error: )?/;

function rawTextOf(reason: unknown): string {
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  if (reason && typeof reason === "object") {
    const { message, error } = reason as { message?: unknown; error?: unknown };
    if (typeof message === "string") return message;
    if (typeof error === "string") return error;
    if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") return (error as { message: string }).message;
  }
  return "";
}

/** The words a person reads for any caught failure, wherever it is shown. A plain sentence (often the server's own)
 * passes as it is; anything technical becomes one short plain line; `fallback` stands in when nothing better fits. */
/** The server's own English refusals a person can meet, said in the app's words and language instead. */
const SERVER_REFUSALS: Array<[RegExp, LocaleKey]> = [
  [/^the message being replied to is no longer available$/i, "chat.error.replyGone"],
];

export function friendlyError(reason: unknown, fallback?: string): string {
  // only the first line of a message that carries its stack, without a bare "Error: " in front
  const whole = rawTextOf(reason).replace(IPC_PREFIX, "").trim();
  const text = STACKED.test(whole) ? whole.split("\n")[0]!.replace(/^Error: /, "").trim() : whole;
  const generic = () => fallback ?? t("error.plain.generic");
  if (!text) return generic();
  const refusal = SERVER_REFUSALS.find(([pattern]) => pattern.test(text));
  if (refusal) return t(refusal[1]);
  if (isStaleChunkError(text)) return t("error.plain.updated");
  if (reason instanceof Error && (reason.name === "AbortError" || reason.name === "TimeoutError") && !isPlainSentence(text)) return t("error.plain.timeout");
  const plain = plainErrorLine(text);
  if (plain !== undefined) return plain === t("error.plain.generic") || !isPlainSentence(plain) ? generic() : plain;
  return isPlainSentence(text) ? text : generic();
}

function isPlainSentence(text: string): boolean {
  return !RAW_FOR_PEOPLE.some((pattern) => pattern.test(text)) && !isTechnicalError(text);
}
