/** The kinds of developer detail a person never reads in a failure: they go to the logs, or behind Copy details. */
export type RawDetailKind = "path" | "url" | "stack" | "json" | "exit" | "errno" | "status";

const RAW_DETAIL: ReadonlyArray<[RawDetailKind, RegExp]> = [
  ["path", /(?:^|[\s"'(=:])(?:\/(?:Users|home|private|var|tmp|opt|usr|etc|root|Applications|Library|Volumes|mnt|srv)\/|~\/\.|[A-Za-z]:\\|\\\\[\w.-]+\\)/],
  ["url", /\b(?:https?|file|wss?):\/\/\S/i],
  ["stack", /\n\s+at \S|\bat (?:async )?[\w$.<>]+ \((?:[\w./\\-]+|node:[\w/]+):\d+:\d+\)|^\s*Traceback \(most recent call last\)/m],
  ["json", /[{[]\s*"[\w$-]+"\s*:/],
  ["exit", /\b(?:exit(?:ed)? (?:with )?(?:code|status)|exited)[ :]+-?\d+\b|\bsignal SIG[A-Z0-9]+\b/i],
  ["errno", /\b(?:E(?:CONNRESET|CONNREFUSED|CONNABORTED|NOTFOUND|AI_AGAIN|TIMEDOUT|PIPE|ACCES|PERM|NOENT|ADDRINUSE|HOSTUNREACH|NETUNREACH|EXIST|ISDIR|NOTDIR)|ERR_[A-Z_]{3,})\b/],
  ["status", /(?:API Error|HTTP|status(?: code)?)[:\s]+\d{3}\b/i],
];

/** Which developer detail `text` carries, or null when a person can read it as it is. */
export function rawDetailIn(text: string): RawDetailKind | null {
  return RAW_DETAIL.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

const HOME = /(?:\/Users\/|\/home\/)[^/\s"'`]+(?=\/)|[A-Za-z]:\\Users\\[^\\\s"'`]+(?=\\)/g;

/** `text` with each home folder written as `~`: the path still says where, without the account name. */
export function shortenHomePaths(text: string): string {
  return text.replace(HOME, "~");
}

export function hasRawDetail(text: string): boolean {
  return rawDetailIn(text) !== null;
}
