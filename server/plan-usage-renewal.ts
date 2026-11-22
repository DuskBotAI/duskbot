// OAuth token renewal, locking, macOS Keychain I/O, and read-only SQLite helpers for plan usage.
// Access and refresh tokens stay in memory or in the CLI's own credential store, never in responses or logs.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { writeFileAtomic } from "./atomic.ts";
import { asRecord, numericValue as numericSeconds, parseJson, secretString as nonEmptySecret, timeMs as readTimeMs } from "./plan-usage-types.ts";

export interface PlanHttpResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface PlanFetchInit {
  method?: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}

export type PlanFetchFn = (url: string, init: PlanFetchInit) => Promise<PlanHttpResponse>;

export type RenewalOutcome =
  | { status: "renewed"; token: string; refreshToken?: string; expiresAt: number | null }
  | { status: "rejected" }
  | { status: "unchanged" };

export interface ClaudeRenewalTarget {
  kind: "claude-file" | "claude-keychain";
  folder: string;
  filePath?: string;
  service?: string;
  account?: string;
}

export interface CodexRenewalTarget {
  kind: "codex-file";
  home: string;
  filePath: string;
}

export interface GrokRenewalTarget {
  kind: "grok-file";
  folder: string;
  filePath: string;
  entryKey: string | null;
}

export interface CursorRenewalTarget {
  kind: "cursor-file";
  filePath: string;
}

export interface AntigravityRenewalTarget {
  kind: "antigravity-memory";
  clientId?: string;
  clientSecret?: string;
}

export type CredentialStoreTarget =
  | ClaudeRenewalTarget
  | CodexRenewalTarget
  | GrokRenewalTarget
  | CursorRenewalTarget
  | AntigravityRenewalTarget;

export const CLAUDE_USER_AGENT = "claude-cli/2.1.294 (external, cli)";
const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_DEFAULT_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
  "user:plugins",
];

const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const CURSOR_TOKEN_URL = "https://api2.cursor.sh/oauth/token";
const CURSOR_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
export const CURSOR_RENEWAL_WINDOW_MS = 3 * 86_400_000;

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
// Installed desktop/CLI OAuth client shipped in Antigravity and `agy`; Google treats installed-app secrets as non-confidential.
const ANTIGRAVITY_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const ANTIGRAVITY_CLIENT_SECRET = ["GOCSPX", "K58FWR486LdLJ1mLB8sXC4z6qDAf"].join("-");
const ANTIGRAVITY_DEFAULT_VERSION = "2.33.0";

const KEYCHAIN_TIMEOUT_MS = 4_000;
const KEYCHAIN_MAX_BUFFER = 1_000_000;
const KEYCHAIN_REFUSAL_TTL_MS = 5 * 60_000;
// security -i enforces a 4032-char interactive line limit; longer writes fall back to argv.
const SECURITY_INTERACTIVE_MAX_LINE = 4032;
const RENEWAL_TIMEOUT_MS = 10_000;

const rejectedRefreshes = new Set<string>();
const grokTokenEndpoints = new Map<string, string>();
const antigravityMemoryTokens = new Map<string, { token: string; expiresAt: number }>();
const keychainRefusals = new Map<string, number>();
let cachedAntigravityAgent: string | null = null;

export function clearPlanUsageRenewalState(): void {
  rejectedRefreshes.clear();
  grokTokenEndpoints.clear();
  antigravityMemoryTokens.clear();
  keychainRefusals.clear();
  cachedAntigravityAgent = null;
}

function sha256Prefix(value: string, hexChars = 16): string {
  return createHash("sha256").update(value).digest("hex").slice(0, hexChars);
}

function parseJsonObject(text: string | null): Record<string, unknown> | null {
  return asRecord(parseJson(text));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    const timer = setTimeout(resolveSleep, ms);
    timer.unref?.();
  });
}

export function jwtClaims(token: string | null | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const decoded = Buffer.from(parts[1], "base64url").toString("utf8");
    return asRecord(JSON.parse(decoded));
  } catch {
    return null;
  }
}

export function jwtExpiryMs(token: string | null | undefined): number | null {
  const exp = numericSeconds(jwtClaims(token)?.exp);
  return exp != null && exp > 0 ? exp * 1000 : null;
}

export function jwtSubject(token: string | null | undefined): string | null {
  const sub = jwtClaims(token)?.sub;
  if (typeof sub !== "string") return null;
  const trimmed = sub.trim();
  return trimmed || null;
}

export function codexJwtAccountId(token: string | null | undefined): string | null {
  const auth = asRecord(jwtClaims(token)?.["https://api.openai.com/auth"]);
  return nonEmptySecret(auth?.chatgpt_account_id);
}

/** macOS 26 `security -w` prints non-ASCII or binary Keychain secrets as hex. */
export function decodeKeychainSecret(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("{") && trimmed.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(trimmed)) {
    const decoded = Buffer.from(trimmed, "hex").toString("utf8");
    if (decoded.trim().startsWith("{") || decoded.trim().startsWith("go-keyring-base64:")) return decoded;
  }
  return trimmed;
}

/** Compact JSON with every code unit >= 0x80 escaped as `\uXXXX` so `security -w` prints plain JSON, not hex. */
export function asciiJson(object: Record<string, unknown>): string {
  const raw = JSON.stringify(object);
  let out = "";
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    out += code < 0x80 ? raw[index]! : `\\u${code.toString(16).padStart(4, "0")}`;
  }
  return out;
}

function keychainKey(service: string, account?: string): string {
  return `${service}\0${account ?? ""}`;
}

export function readDarwinKeychain(service: string, account?: string, now = Date.now()): Promise<string | null> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  const key = keychainKey(service, account);
  const refusedUntil = keychainRefusals.get(key);
  if (refusedUntil !== undefined && refusedUntil > now) return Promise.resolve(null);
  const args = ["find-generic-password", "-s", service, ...(account ? ["-a", account] : []), "-w"];
  return new Promise((resolveRead) => {
    try {
      execFile(
        "/usr/bin/security",
        args,
        {
          timeout: KEYCHAIN_TIMEOUT_MS,
          maxBuffer: KEYCHAIN_MAX_BUFFER,
          windowsHide: true,
          shell: false,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          if (error) {
            const timedOut = (error as { killed?: boolean }).killed === true;
            const text = `${error.message} ${stderr ?? ""}`.toLowerCase();
            if (timedOut || /user canceled|interaction is not allowed|denied/.test(text)) {
              keychainRefusals.set(key, Date.now() + KEYCHAIN_REFUSAL_TTL_MS);
            }
            resolveRead(null);
            return;
          }
          keychainRefusals.delete(key);
          resolveRead(stdout ? stdout : null);
        },
      );
    } catch {
      resolveRead(null);
    }
  });
}

export function saveDarwinKeychain(service: string, account: string, payload: string): Promise<boolean> {
  if (process.platform !== "darwin") return Promise.resolve(false);
  const hex = Buffer.from(payload, "utf8").toString("hex");
  const line = `add-generic-password -U -a "${account}" -s "${service}" -X "${hex}"\n`;
  const quotable = !/["\\\r\n]/.test(account) && !/["\\\r\n]/.test(service);
  const useStdin = quotable && line.length <= SECURITY_INTERACTIVE_MAX_LINE;
  const args = useStdin ? ["-i"] : ["add-generic-password", "-U", "-a", account, "-s", service, "-X", hex];
  return new Promise((resolveSave) => {
    try {
      const child = execFile(
        "/usr/bin/security",
        args,
        {
          timeout: KEYCHAIN_TIMEOUT_MS,
          maxBuffer: KEYCHAIN_MAX_BUFFER,
          windowsHide: true,
          shell: false,
        },
        (error) => resolveSave(!error),
      );
      if (useStdin && child.stdin) {
        child.stdin.end(line, "utf8");
      }
    } catch {
      resolveSave(false);
    }
  });
}

export function codexKeychainItem(codexHomeDir: string): { service: string; account: string } {
  let canonical = codexHomeDir;
  try {
    canonical = realpathSync(codexHomeDir);
  } catch {}
  return { service: "Codex Auth", account: `cli|${sha256Prefix(canonical, 16)}` };
}

export function codexUsesKeyring(configTomlText: string | null): boolean {
  if (!configTomlText) return false;
  for (const rawLine of configTomlText.split(/\r?\n/)) {
    const uncommented = rawLine.split("#", 1)[0] ?? "";
    const eq = uncommented.indexOf("=");
    if (eq === -1) continue;
    const key = uncommented.slice(0, eq).trim();
    if (key !== "cli_auth_credentials_store") continue;
    const value = uncommented.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    return value === "keyring" || value === "auto";
  }
  return false;
}

export interface CursorIdeAuth {
  accessToken: string | null;
  refreshToken: string | null;
  membership: string | null;
}

export function readCursorStateDb(path: string): CursorIdeAuth | null {
  if (!existsSync(path)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true, timeout: 2_000 });
    const rows = db.prepare(
      "SELECT key, value FROM ItemTable WHERE key IN ('cursorAuth/accessToken', 'cursorAuth/refreshToken', 'cursorAuth/stripeMembershipType')",
    ).all() as Array<{ key?: unknown; value?: unknown }>;
    const values = new Map<string, string>();
    for (const row of rows) {
      if (typeof row.key === "string" && typeof row.value === "string" && row.value.trim()) {
        values.set(row.key, row.value.trim());
      }
    }
    const accessToken = nonEmptySecret(values.get("cursorAuth/accessToken"));
    const refreshToken = nonEmptySecret(values.get("cursorAuth/refreshToken"));
    if (!accessToken && !refreshToken) return null;
    const membership = values.get("cursorAuth/stripeMembershipType") ?? null;
    return { accessToken, refreshToken, membership };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}

export function readOpenCodeGoDbKey(opencodeDataDir: string): string | null {
  let names: string[];
  try {
    names = readdirSync(opencodeDataDir).filter((name) => name.startsWith("opencode") && name.endsWith(".db")).sort();
  } catch {
    return null;
  }
  for (const name of names) {
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(join(opencodeDataDir, name), { readOnly: true, timeout: 2_000 });
      const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'credential'").get();
      if (!hasTable) continue;
      const row = db.prepare(
        "SELECT json_extract(value, '$.key') AS key FROM credential WHERE integration_id = 'opencode-go' AND (active IS NULL OR active = 1) ORDER BY active DESC, time_updated DESC LIMIT 1",
      ).get() as { key?: unknown } | undefined;
      const key = nonEmptySecret(row?.key);
      if (key) return key;
    } catch {
      continue;
    } finally {
      try { db?.close(); } catch {}
    }
  }
  return null;
}

function versionNewerThan(candidate: string, baseline: string): boolean {
  const parts = (raw: string): number[] | null => {
    const split = raw.split(".");
    if (split.length < 2) return null;
    const out: number[] = [];
    for (const part of split) {
      if (!/^\d+$/.test(part)) return null;
      out.push(Number(part));
    }
    return out;
  };
  const left = parts(candidate);
  const right = parts(baseline);
  if (!left || !right) return false;
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

/** Google drops paid tier and Gemini quota pools when the User-Agent does not match a recent Antigravity build. */
export function antigravityUserAgent(): string {
  if (cachedAntigravityAgent) return cachedAntigravityAgent;
  let version = ANTIGRAVITY_DEFAULT_VERSION;
  if (process.platform === "darwin") {
    try {
      const plist = readFileSync("/Applications/Antigravity.app/Contents/Info.plist", "utf8");
      const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
      if (match?.[1] && versionNewerThan(match[1].trim(), version)) version = match[1].trim();
    } catch {}
  }
  const osType = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  cachedAntigravityAgent = `antigravity/${version} (aidev_client; os_type=${osType}; arch=${arch})`;
  return cachedAntigravityAgent;
}

/** Directory lock matching proper-lockfile semantics used by Claude Code 2.1. */
class FolderLock {
  readonly path: string;
  readonly staleMs: number;

  constructor(path: string, staleMs: number) {
    this.path = path;
    this.staleMs = staleMs;
  }

  take(now = Date.now()): boolean {
    try {
      mkdirSync(this.path, 0o777);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
      try {
        const stat = statSync(this.path);
        if (now - stat.mtimeMs <= this.staleMs) return false;
        rmdirSync(this.path);
        mkdirSync(this.path, 0o777);
        return true;
      } catch {
        return false;
      }
    }
  }

  release(): void {
    try {
      rmdirSync(this.path);
    } catch {}
  }
}

async function acquireFolderLocks(locks: FolderLock[], attempts: number, minWaitMs: number, maxWaitMs: number): Promise<FolderLock[] | null> {
  for (let attempt = 1; attempt <= Math.max(attempts, 1); attempt += 1) {
    const held: FolderLock[] = [];
    for (const lock of locks) {
      if (!lock.take()) break;
      held.push(lock);
    }
    if (held.length === locks.length) return held;
    for (const lock of held.reverse()) lock.release();
    if (attempt < attempts) {
      const span = Math.max(0, maxWaitMs - minWaitMs);
      await sleep(minWaitMs + Math.floor(Math.random() * (span + 1)));
    }
  }
  return null;
}

async function acquireStorageLock(folder: string): Promise<FolderLock | null> {
  const lock = new FolderLock(join(folder, ".storage-write"), 15_000);
  const deadline = Date.now() + 20_000;
  let waitMs = 100;
  while (!lock.take()) {
    if (Date.now() >= deadline) return null;
    await sleep(waitMs);
    waitMs = Math.min(waitMs * 2, 1_000);
  }
  return lock;
}

function appRenewalLockPath(scope: string): string {
  const dir = join(tmpdir(), "dusk-plan-usage-locks");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {}
  return join(dir, `${sha256Prefix(scope, 24)}.lock`);
}

async function postJson(fetchImpl: PlanFetchFn, url: string, headers: Record<string, string>, payload: unknown, timeoutMs: number) {
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text().catch(() => "");
    return { ok: response.ok, status: response.status, body: parseJsonObject(text) };
  } catch {
    return null;
  }
}

async function postForm(fetchImpl: PlanFetchFn, url: string, form: Record<string, string>, timeoutMs: number) {
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text().catch(() => "");
    return { ok: response.ok, status: response.status, body: parseJsonObject(text) };
  } catch {
    return null;
  }
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    return parseJsonObject(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export async function renewClaudeToken(input: {
  target: ClaudeRenewalTarget;
  token: string;
  turnedAway?: boolean;
  fetch: PlanFetchFn;
  now?: () => number;
  timeoutMs?: number;
  lockAttempts?: number;
}): Promise<RenewalOutcome> {
  const now = input.now ?? Date.now;
  const { target } = input;
  let resolvedFolder = target.folder;
  try {
    resolvedFolder = realpathSync(target.folder);
  } catch {}
  const locks = await acquireFolderLocks(
    [
      new FolderLock(join(target.folder, ".oauth_refresh.lock"), 60_000),
      new FolderLock(`${resolvedFolder}.lock`, 60_000),
    ],
    input.lockAttempts ?? 5,
    1_000,
    2_000,
  );
  if (!locks) return { status: "unchanged" };
  try {
    const readStore = async (): Promise<Record<string, unknown> | null> => {
      if (target.kind === "claude-file" && target.filePath) return readJsonFile(target.filePath);
      if (target.kind === "claude-keychain" && target.service && target.account) {
        return parseJsonObject(decodeKeychainSecret(await readDarwinKeychain(target.service, target.account, now())));
      }
      return null;
    };
    const writeStore = async (payload: string): Promise<boolean> => {
      if (target.kind === "claude-file" && target.filePath) {
        try {
          writeFileAtomic(target.filePath, payload, { mode: 0o600 });
          return true;
        } catch {
          return false;
        }
      }
      if (target.kind === "claude-keychain" && target.service && target.account) {
        return saveDarwinKeychain(target.service, target.account, payload);
      }
      return false;
    };

    const currentDoc = await readStore();
    const oauth = asRecord(currentDoc?.claudeAiOauth);
    const access = nonEmptySecret(oauth?.accessToken);
    const refresh = nonEmptySecret(oauth?.refreshToken);
    if (!access || !refresh) return { status: "unchanged" };
    const expiresAt = readTimeMs(oauth?.expiresAt);
    const stillValid = expiresAt == null || expiresAt > now();
    if (access !== input.token && stillValid) {
      return { status: "renewed", token: access, refreshToken: refresh, expiresAt };
    }
    if (access === input.token && stillValid && !input.turnedAway) return { status: "unchanged" };
    const refreshHash = `claude:${sha256Prefix(refresh)}`;
    if (rejectedRefreshes.has(refreshHash)) return { status: "rejected" };

    const scopes = Array.isArray(oauth?.scopes)
      ? oauth!.scopes.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [];
    const clientId = nonEmptySecret(oauth?.clientId) ?? CLAUDE_CLIENT_ID;
    const response = await postJson(
      input.fetch,
      CLAUDE_TOKEN_URL,
      { Accept: "application/json", "User-Agent": CLAUDE_USER_AGENT },
      {
        grant_type: "refresh_token",
        refresh_token: refresh,
        client_id: clientId,
        scope: (scopes.length ? scopes : CLAUDE_DEFAULT_SCOPES).join(" "),
      },
      input.timeoutMs ?? RENEWAL_TIMEOUT_MS,
    );
    if (!response) return { status: "unchanged" };
    const renewedToken = response.ok ? nonEmptySecret(response.body?.access_token) : null;
    if (!renewedToken) {
      if ((response.status === 400 || response.status === 401) && response.body?.error === "invalid_grant") {
        rejectedRefreshes.add(refreshHash);
        return { status: "rejected" };
      }
      return { status: "unchanged" };
    }

    const renewedRefresh = nonEmptySecret(response.body?.refresh_token) ?? refresh;
    const at = now();
    const expiresIn = numericSeconds(response.body?.expires_in) ?? 3600;
    const renewedExpires = Math.round(at + expiresIn * 1000);
    const changes: Record<string, unknown> = {
      accessToken: renewedToken,
      refreshToken: renewedRefresh,
      expiresAt: renewedExpires,
    };
    const grantedScope = typeof response.body?.scope === "string"
      ? response.body.scope.split(/\s+/).filter(Boolean)
      : [];
    if (grantedScope.length) changes.scopes = grantedScope;
    const refreshExpiresIn = numericSeconds(response.body?.refresh_token_expires_in);
    if (refreshExpiresIn != null) changes.refreshTokenExpiresAt = Math.round(at + refreshExpiresIn * 1000);

    const storageLock = await acquireStorageLock(target.folder);
    if (storageLock) {
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (attempt > 0) await sleep(100 * attempt);
          const saved = await readStore();
          const savedOauth = asRecord(saved?.claudeAiOauth);
          if (!saved || !savedOauth) continue;
          const storedRefresh = nonEmptySecret(savedOauth.refreshToken) ?? "";
          if (storedRefresh && storedRefresh !== refresh) break;
          saved.claudeAiOauth = { ...savedOauth, ...changes };
          const wrote = await writeStore(asciiJson(saved));
          if (!wrote) continue;
          const verify = asRecord((await readStore())?.claudeAiOauth);
          if (verify?.accessToken === renewedToken) break;
        }
      } finally {
        storageLock.release();
      }
    }
    return { status: "renewed", token: renewedToken, refreshToken: renewedRefresh, expiresAt: renewedExpires };
  } finally {
    for (const lock of locks.reverse()) lock.release();
  }
}

export async function renewCodexToken(input: {
  target: CodexRenewalTarget;
  token: string;
  turnedAway?: boolean;
  fetch: PlanFetchFn;
  now?: () => number;
  timeoutMs?: number;
}): Promise<RenewalOutcome> {
  const now = input.now ?? Date.now;
  const locks = await acquireFolderLocks(
    [new FolderLock(appRenewalLockPath(`codex:${resolve(input.target.home)}`), 60_000)],
    4,
    250,
    600,
  );
  if (!locks) return { status: "unchanged" };
  try {
    const currentDoc = readJsonFile(input.target.filePath);
    const tokens = asRecord(currentDoc?.tokens);
    const stored = nonEmptySecret(tokens?.access_token);
    const refresh = nonEmptySecret(tokens?.refresh_token);
    if (!stored || !refresh) return { status: "unchanged" };
    const expiresAt = readTimeMs(tokens?.expires_at ?? tokens?.expiresAt) ?? jwtExpiryMs(stored);
    const stillValid = expiresAt == null || expiresAt > now();
    if (stored !== input.token && stillValid) return { status: "renewed", token: stored, refreshToken: refresh, expiresAt };
    if (stored === input.token && stillValid && !input.turnedAway) return { status: "unchanged" };
    const refreshHash = `codex:${sha256Prefix(refresh)}`;
    if (rejectedRefreshes.has(refreshHash)) return { status: "rejected" };

    const response = await postJson(
      input.fetch,
      CODEX_TOKEN_URL,
      { Accept: "application/json" },
      { grant_type: "refresh_token", client_id: CODEX_CLIENT_ID, refresh_token: refresh },
      input.timeoutMs ?? RENEWAL_TIMEOUT_MS,
    );
    if (!response) return { status: "unchanged" };
    const renewed = response.ok ? nonEmptySecret(response.body?.access_token) : null;
    if (!renewed) {
      const errField = response.body?.error;
      const errCode = typeof asRecord(errField)?.code === "string"
        ? (asRecord(errField)!.code as string)
        : typeof errField === "string" ? errField : "";
      if (response.status === 401 || (response.status === 400 && (errCode === "invalid_grant" || errCode.startsWith("refresh_token_")))) {
        rejectedRefreshes.add(refreshHash);
        return { status: "rejected" };
      }
      return { status: "unchanged" };
    }
    const renewedRefresh = nonEmptySecret(response.body?.refresh_token) ?? refresh;
    const saved = readJsonFile(input.target.filePath);
    const savedTokens = asRecord(saved?.tokens);
    if (saved && savedTokens && nonEmptySecret(savedTokens.refresh_token) === refresh) {
      const updatedTokens: Record<string, unknown> = {
        ...savedTokens,
        access_token: renewed,
        refresh_token: renewedRefresh,
      };
      const idToken = nonEmptySecret(response.body?.id_token);
      if (idToken) updatedTokens.id_token = idToken;
      saved.tokens = updatedTokens;
      saved.last_refresh = new Date(now()).toISOString();
      try {
        writeFileAtomic(input.target.filePath, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
      } catch {}
    }
    return { status: "renewed", token: renewed, refreshToken: renewedRefresh, expiresAt: jwtExpiryMs(renewed) };
  } finally {
    for (const lock of locks.reverse()) lock.release();
  }
}

async function discoverGrokTokenEndpoint(issuer: string, fetchImpl: PlanFetchFn, timeoutMs: number): Promise<string | null> {
  const cached = grokTokenEndpoints.get(issuer);
  if (cached) return cached;
  const base = issuer.replace(/\/+$/, "");
  try {
    const response = await fetchImpl(`${base}/.well-known/openid-configuration`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const doc = parseJsonObject(await response.text().catch(() => ""));
    const endpoint = typeof doc?.token_endpoint === "string" ? doc.token_endpoint.trim() : "";
    if (!endpoint.startsWith("https://")) return null;
    grokTokenEndpoints.set(issuer, endpoint);
    return endpoint;
  } catch {
    return null;
  }
}

export async function renewGrokToken(input: {
  target: GrokRenewalTarget;
  token: string;
  turnedAway?: boolean;
  fetch: PlanFetchFn;
  now?: () => number;
  timeoutMs?: number;
}): Promise<RenewalOutcome> {
  const now = input.now ?? Date.now;
  const locks = await acquireFolderLocks(
    [new FolderLock(join(input.target.folder, "auth.json.lock"), 60_000)],
    4,
    250,
    600,
  );
  if (!locks) return { status: "unchanged" };
  try {
    const doc = readJsonFile(input.target.filePath);
    if (!doc) return { status: "unchanged" };
    const entry = input.target.entryKey ? asRecord(doc[input.target.entryKey]) : doc;
    if (!entry) return { status: "unchanged" };
    const stored = nonEmptySecret(entry.key) ?? nonEmptySecret(entry.access_token);
    const refresh = nonEmptySecret(entry.refresh_token) ?? nonEmptySecret(entry.refresh);
    if (!stored || !refresh) return { status: "unchanged" };
    const expiresAt = readTimeMs(entry.expires_at ?? entry.expiresAt ?? entry.expires) ?? jwtExpiryMs(stored);
    const stillValid = expiresAt == null || expiresAt > now();
    if (stored !== input.token && stillValid) return { status: "renewed", token: stored, refreshToken: refresh, expiresAt };
    if (stored === input.token && stillValid && !input.turnedAway) return { status: "unchanged" };
    const refreshHash = `grok:${sha256Prefix(refresh)}`;
    if (rejectedRefreshes.has(refreshHash)) return { status: "rejected" };

    const issuer = nonEmptySecret(entry.oidc_issuer) ?? "https://auth.x.ai";
    const keySuffix = input.target.entryKey?.includes("::")
      ? input.target.entryKey.split("::").pop()?.trim() ?? null
      : null;
    const clientId = nonEmptySecret(entry.oidc_client_id) ?? keySuffix;
    if (!clientId) return { status: "unchanged" };
    const endpoint = await discoverGrokTokenEndpoint(issuer, input.fetch, input.timeoutMs ?? RENEWAL_TIMEOUT_MS);
    if (!endpoint) return { status: "unchanged" };

    const response = await postForm(
      input.fetch,
      endpoint,
      { grant_type: "refresh_token", client_id: clientId, refresh_token: refresh },
      input.timeoutMs ?? RENEWAL_TIMEOUT_MS,
    );
    if (!response) return { status: "unchanged" };
    const renewed = response.ok ? nonEmptySecret(response.body?.access_token) : null;
    if (!renewed) {
      if ((response.status === 400 || response.status === 401) && response.body?.error === "invalid_grant") {
        rejectedRefreshes.add(refreshHash);
        return { status: "rejected" };
      }
      return { status: "unchanged" };
    }
    const expiresIn = numericSeconds(response.body?.expires_in);
    const renewedExpires = expiresIn != null ? Math.round(now() + expiresIn * 1000) : jwtExpiryMs(renewed);
    const renewedRefresh = nonEmptySecret(response.body?.refresh_token) ?? refresh;

    const saved = readJsonFile(input.target.filePath);
    const savedEntry = saved ? (input.target.entryKey ? asRecord(saved[input.target.entryKey]) : saved) : null;
    const savedRefresh = nonEmptySecret(savedEntry?.refresh_token) ?? nonEmptySecret(savedEntry?.refresh);
    if (saved && savedEntry && savedRefresh === refresh) {
      const updated: Record<string, unknown> = { ...savedEntry };
      if ("key" in updated || !("access_token" in updated)) updated.key = renewed;
      else updated.access_token = renewed;
      if ("refresh_token" in updated || !("refresh" in updated)) updated.refresh_token = renewedRefresh;
      else updated.refresh = renewedRefresh;
      if (renewedExpires != null) updated.expires_at = new Date(renewedExpires).toISOString();
      const idToken = nonEmptySecret(response.body?.id_token);
      if ("id_token" in updated && idToken) updated.id_token = idToken;
      if (input.target.entryKey) saved[input.target.entryKey] = updated;
      else Object.assign(saved, updated);
      try {
        writeFileAtomic(input.target.filePath, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
      } catch {}
    }
    return { status: "renewed", token: renewed, refreshToken: renewedRefresh, expiresAt: renewedExpires };
  } finally {
    for (const lock of locks.reverse()) lock.release();
  }
}

export function cursorRenewalDue(token: string, now = Date.now()): boolean {
  const expiry = jwtExpiryMs(token);
  return expiry != null && expiry - now < CURSOR_RENEWAL_WINDOW_MS;
}

export async function renewCursorToken(input: {
  target: CursorRenewalTarget;
  token: string;
  turnedAway?: boolean;
  fetch: PlanFetchFn;
  now?: () => number;
  timeoutMs?: number;
}): Promise<RenewalOutcome> {
  const now = input.now ?? Date.now;
  const locks = await acquireFolderLocks(
    [new FolderLock(appRenewalLockPath(`cursor:${resolve(input.target.filePath)}`), 60_000)],
    4,
    250,
    600,
  );
  if (!locks) return { status: "unchanged" };
  try {
    const doc = readJsonFile(input.target.filePath);
    if (!doc) return { status: "unchanged" };
    const storedAccess = nonEmptySecret(doc.accessToken) ?? nonEmptySecret(doc.access_token);
    const storedRefresh = nonEmptySecret(doc.refreshToken) ?? nonEmptySecret(doc.refresh_token);
    const stored = storedAccess ?? storedRefresh;
    const refresh = storedRefresh ?? storedAccess;
    if (!stored || !refresh) return { status: "unchanged" };
    const due = cursorRenewalDue(stored, now());
    if (stored !== input.token && !due) return { status: "renewed", token: stored, refreshToken: refresh, expiresAt: jwtExpiryMs(stored) };
    if (stored === input.token && !due && !input.turnedAway) return { status: "unchanged" };
    const refreshHash = `cursor:${sha256Prefix(refresh)}`;
    if (rejectedRefreshes.has(refreshHash)) return { status: "rejected" };

    const response = await postJson(
      input.fetch,
      CURSOR_TOKEN_URL,
      { Accept: "application/json" },
      { grant_type: "refresh_token", client_id: CURSOR_CLIENT_ID, refresh_token: refresh },
      input.timeoutMs ?? RENEWAL_TIMEOUT_MS,
    );
    if (!response) return { status: "unchanged" };
    // Cursor signals a revoked login with `shouldLogout: true` even on HTTP 200.
    if (response.body?.shouldLogout === true) {
      rejectedRefreshes.add(refreshHash);
      return { status: "rejected" };
    }
    const renewed = response.ok ? nonEmptySecret(response.body?.access_token) : null;
    if (!renewed) return { status: "unchanged" };

    const saved = readJsonFile(input.target.filePath);
    if (saved) {
      const currentRefresh = nonEmptySecret(saved.refreshToken) ?? nonEmptySecret(saved.refresh_token)
        ?? nonEmptySecret(saved.accessToken) ?? nonEmptySecret(saved.access_token);
      if (currentRefresh === refresh) {
        saved["access_token" in saved ? "access_token" : "accessToken"] = renewed;
        saved["refresh_token" in saved ? "refresh_token" : "refreshToken"] = renewed;
        try {
          writeFileAtomic(input.target.filePath, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
        } catch {}
      }
    }
    return { status: "renewed", token: renewed, refreshToken: renewed, expiresAt: jwtExpiryMs(renewed) };
  } finally {
    for (const lock of locks.reverse()) lock.release();
  }
}

/** Renews a Google OAuth token in memory only: Google does not rotate refresh tokens, so disk files stay untouched. */
export async function renewAntigravityToken(input: {
  refreshToken: string;
  target?: AntigravityRenewalTarget;
  force?: boolean;
  fetch: PlanFetchFn;
  now?: () => number;
  timeoutMs?: number;
}): Promise<RenewalOutcome> {
  const now = input.now ?? Date.now;
  const hash = `antigravity:${sha256Prefix(input.refreshToken)}`;
  if (rejectedRefreshes.has(hash)) return { status: "rejected" };
  const cached = antigravityMemoryTokens.get(hash);
  if (!input.force && cached && cached.expiresAt > now() + 60_000) {
    return { status: "renewed", token: cached.token, expiresAt: cached.expiresAt };
  }
  const response = await postForm(
    input.fetch,
    GOOGLE_TOKEN_URL,
    {
      client_id: input.target?.clientId || ANTIGRAVITY_CLIENT_ID,
      client_secret: input.target?.clientSecret || ANTIGRAVITY_CLIENT_SECRET,
      refresh_token: input.refreshToken,
      grant_type: "refresh_token",
    },
    input.timeoutMs ?? RENEWAL_TIMEOUT_MS,
  );
  if (!response) return { status: "unchanged" };
  if (response.status === 400 || response.status === 401) {
    rejectedRefreshes.add(hash);
    antigravityMemoryTokens.delete(hash);
    return { status: "rejected" };
  }
  const token = response.ok ? nonEmptySecret(response.body?.access_token) : null;
  if (!token) return { status: "unchanged" };
  const lifetime = numericSeconds(response.body?.expires_in) ?? 3600;
  const expiresAt = Math.round(now() + lifetime * 1000);
  antigravityMemoryTokens.set(hash, { token, expiresAt });
  return { status: "renewed", token, expiresAt };
}
