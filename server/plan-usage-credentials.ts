import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import {
  ANTIGRAVITY_APP_DATA_DIR,
  ANTIGRAVITY_CLI_TOKEN_FILE,
  ANTIGRAVITY_LEGACY_TOKEN_FILE,
  antigravityProfileDirectory,
} from "./drivers/antigravity-acp.ts";
import { resolveClaudeConfigDir } from "./drivers/claude.ts";
import { codexHome } from "./drivers/codex-identity.ts";
import { harnessHome, sealedFixture, userHome } from "./env-path.ts";
import {
  codexJwtAccountId,
  codexKeychainItem,
  codexUsesKeyring,
  decodeKeychainSecret,
  jwtExpiryMs,
  jwtSubject,
  readCursorStateDb,
  readDarwinKeychain,
  readOpenCodeGoDbKey,
  type AntigravityRenewalTarget,
  type ClaudeRenewalTarget,
  type CodexRenewalTarget,
  type CursorRenewalTarget,
  type GrokRenewalTarget,
} from "./plan-usage-renewal.ts";
import {
  asRecord,
  claudePlanName,
  expiredCredential,
  missingCredential,
  parseJson,
  planLabel,
  secretString,
  timeMs,
  titleWords,
  type CredentialReader,
  type CredentialSource,
  type PlanAccount,
  type PlanCredential,
} from "./plan-usage-types.ts";

const CREDENTIAL_READ_MAX_BYTES = 1_000_000;
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

export function fileCredentialReader(source: CredentialSource): CredentialReader {
  const env = source.env ?? process.env;
  const now = source.now ?? Date.now;
  const dataDir = source.dataDir ?? DATA_DIR;
  return {
    async read(account) {
      const merged: NodeJS.ProcessEnv = { ...env, ...account.environment };
      const at = now();
      if (account.driver === "claude") return readClaudeCredential(account, merged, source, at);
      if (account.driver === "codex") return readCodexCredential(merged, source, at);
      if (account.driver === "grok") return readGrokCredential(merged, source, at);
      if (account.driver === "antigravity") return readAntigravityCredential(account, merged, source, at, dataDir);
      if (account.driver === "cursor") return readCursorCredential(merged, source, at);
      return readOpenCodeCredential(merged, source);
    },
  };
}

export function defaultCredentialReader(env: NodeJS.ProcessEnv = process.env, dataDir = DATA_DIR): CredentialReader {
  const allowHostStores = !sealedFixture();
  const isDarwin = process.platform === "darwin";
  return fileCredentialReader({
    env,
    dataDir,
    writable: true,
    readText(path) {
      try {
        const stat = statSync(path);
        if (!stat.isFile() || stat.size > CREDENTIAL_READ_MAX_BYTES) return null;
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    ...(isDarwin && allowHostStores ? {
      readClaudeKeychain: (service) => readDarwinKeychain(service),
      readClaudeKeychainWithAccount: async (service, account) => {
        if (account) {
          const named = await readDarwinKeychain(service, account);
          if (named) return { raw: named, account };
        }
        return { raw: await readDarwinKeychain(service) };
      },
      readCodexKeychain: (service, account) => readDarwinKeychain(service, account),
      readCursorKeychain: async () => {
        const accessToken = secretString(decodeKeychainSecret(await readDarwinKeychain("cursor-access-token")));
        const refreshToken = secretString(decodeKeychainSecret(await readDarwinKeychain("cursor-refresh-token")));
        return { accessToken, refreshToken };
      },
    } : {}),
    ...(allowHostStores ? {
      readCursorIdeDb: readCursorStateDb,
      readOpenCodeDbKey: readOpenCodeGoDbKey,
    } : {}),
  });
}

function claudeCredentialFromText(text: string | null, now: number, store?: ClaudeRenewalTarget): PlanCredential {
  const oauth = asRecord(asRecord(parseJson(text))?.claudeAiOauth);
  const token = secretString(oauth?.accessToken);
  if (!token) return missingCredential();
  const refreshToken = secretString(oauth?.refreshToken);
  const planHint = claudePlanName(oauth?.subscriptionType, oauth?.rateLimitTier);
  const expiry = timeMs(oauth?.expiresAt);
  if (expiry != null && expiry <= now) {
    if (refreshToken && store) {
      return { token, accountId: null, expired: true, refreshToken, planHint, store };
    }
    return expiredCredential();
  }
  return { token, accountId: null, expired: false, refreshToken, planHint, store };
}

function claudeKeychainServices(account: PlanAccount, env: NodeJS.ProcessEnv, resolvedDir: string): string[] {
  const written = account.configDir?.trim() || env.CLAUDE_CONFIG_DIR?.trim() || "";
  if (!written) return [CLAUDE_KEYCHAIN_SERVICE];
  let defaultDir: string | null = null;
  try {
    const withoutConfig = { ...env };
    delete withoutConfig.CLAUDE_CONFIG_DIR;
    defaultDir = resolveClaudeConfigDir(undefined, withoutConfig);
  } catch {
    defaultDir = null;
  }
  if (defaultDir != null && resolvedDir === defaultDir) return [CLAUDE_KEYCHAIN_SERVICE];
  const spellings = [resolvedDir];
  if (written !== resolvedDir) spellings.push(written);
  const seen = new Set<string>();
  const services: string[] = [];
  for (const spelling of spellings) {
    const suffix = createHash("sha256").update(spelling).digest("hex").slice(0, 8);
    const service = `${CLAUDE_KEYCHAIN_SERVICE}-${suffix}`;
    if (seen.has(service)) continue;
    seen.add(service);
    services.push(service);
  }
  return services;
}

async function readClaudeCredential(
  account: PlanAccount,
  env: NodeJS.ProcessEnv,
  source: CredentialSource,
  now: number,
): Promise<PlanCredential> {
  let resolvedDir: string;
  try {
    resolvedDir = resolveClaudeConfigDir(account.configDir, env);
  } catch {
    return missingCredential();
  }
  const filePath = join(resolvedDir, ".credentials.json");
  const fileStore: ClaudeRenewalTarget | undefined = source.writable
    ? { kind: "claude-file", folder: resolvedDir, filePath }
    : undefined;
  const file = claudeCredentialFromText(source.readText(filePath), now, fileStore);
  if (file.token && !file.expired) return file;
  if (!source.readClaudeKeychain && !source.readClaudeKeychainWithAccount) return file;

  let sawExpired: PlanCredential | null = file.expired ? file : null;
  const user = env.USER?.trim() || undefined;
  for (const service of claudeKeychainServices(account, env, resolvedDir)) {
    let raw: string | null = null;
    let matchedAccount: string | undefined;
    try {
      if (source.readClaudeKeychainWithAccount) {
        const result = await source.readClaudeKeychainWithAccount(service, user);
        raw = result.raw;
        matchedAccount = result.account;
      } else if (source.readClaudeKeychain) {
        raw = (await source.readClaudeKeychain(service)) ?? null;
      }
    } catch {
      raw = null;
    }
    const keychainStore: ClaudeRenewalTarget | undefined = source.writable && matchedAccount
      ? { kind: "claude-keychain", folder: resolvedDir, service, account: matchedAccount }
      : undefined;
    const parsed = claudeCredentialFromText(decodeKeychainSecret(raw), now, keychainStore);
    if (parsed.token && !parsed.expired) return parsed;
    if (parsed.expired && (!sawExpired || (!sawExpired.refreshToken && parsed.refreshToken))) {
      sawExpired = parsed;
    }
  }
  return sawExpired ?? missingCredential();
}

function codexCredentialFromRecord(
  root: Record<string, unknown> | null,
  now: number,
  store?: CodexRenewalTarget,
): PlanCredential {
  if (!root) return missingCredential();
  const tokens = asRecord(root.tokens);
  const token = secretString(tokens?.access_token) ?? secretString(root.access_token);
  if (!token) return missingCredential();
  const refreshToken = secretString(tokens?.refresh_token) ?? secretString(root.refresh_token);
  const accountId = secretString(tokens?.account_id) ?? secretString(root.account_id) ?? codexJwtAccountId(token);
  const expiry = timeMs(tokens?.expires_at ?? tokens?.expiresAt ?? root.expires_at ?? root.expiresAt) ?? jwtExpiryMs(token);
  if (expiry != null && expiry <= now) {
    if (refreshToken && store) return { token, accountId, expired: true, refreshToken, store };
    return expiredCredential();
  }
  return { token, accountId, expired: false, refreshToken, store };
}

async function readCodexCredential(
  env: NodeJS.ProcessEnv,
  source: CredentialSource,
  now: number,
): Promise<PlanCredential> {
  const home = codexHome(env);
  if (!home) return missingCredential();
  const filePath = join(home, "auth.json");
  const fileStore: CodexRenewalTarget | undefined = source.writable
    ? { kind: "codex-file", home, filePath }
    : undefined;
  const fromFile = codexCredentialFromRecord(asRecord(parseJson(source.readText(filePath))), now, fileStore);
  if (fromFile.token || fromFile.expired) return fromFile;
  if (!source.readCodexKeychain) return missingCredential();
  if (!codexUsesKeyring(source.readText(join(home, "config.toml")))) return missingCredential();
  const item = codexKeychainItem(home);
  let raw: string | null = null;
  try {
    raw = (await source.readCodexKeychain(item.service, item.account)) ?? null;
  } catch {
    raw = null;
  }
  return codexCredentialFromRecord(asRecord(parseJson(decodeKeychainSecret(raw))), now);
}

interface GrokCandidate {
  token: string;
  refreshToken: string | null;
  expiresAt: number | null;
  entryKey: string | null;
}

function grokCandidate(record: Record<string, unknown>, entryKey: string | null): GrokCandidate | null {
  const token = secretString(record.access_token) ?? secretString(record.key);
  if (!token) return null;
  const refreshToken = secretString(record.refresh_token) ?? secretString(record.refresh);
  const expiresAt = timeMs(record.expires_at ?? record.expiresAt ?? record.expires) ?? jwtExpiryMs(token);
  return { token, refreshToken, expiresAt, entryKey };
}

function readGrokCredential(
  env: NodeJS.ProcessEnv,
  source: CredentialSource,
  now: number,
): PlanCredential {
  const rootDir = env.GROK_HOME?.trim() || harnessHome("grok", env);
  const filePath = join(rootDir, "auth.json");
  const root = asRecord(parseJson(source.readText(filePath)));
  if (!root) return missingCredential();
  const makeStore = (entryKey: string | null): GrokRenewalTarget | undefined =>
    source.writable ? { kind: "grok-file", folder: rootDir, filePath, entryKey } : undefined;
  const direct = grokCandidate(root, null);
  if (direct) {
    const store = makeStore(null);
    if (direct.expiresAt != null && direct.expiresAt <= now) {
      if (direct.refreshToken && store) {
        return { token: direct.token, accountId: null, expired: true, refreshToken: direct.refreshToken, store };
      }
      return expiredCredential();
    }
    return { token: direct.token, accountId: null, expired: false, refreshToken: direct.refreshToken, store };
  }
  let best: GrokCandidate | null = null;
  let bestExpired: GrokCandidate | null = null;
  for (const [key, value] of Object.entries(root)) {
    const record = asRecord(value);
    if (!record) continue;
    const candidate = grokCandidate(record, key);
    if (!candidate) continue;
    if (candidate.expiresAt != null && candidate.expiresAt <= now) {
      if (
        !bestExpired ||
        (!bestExpired.refreshToken && candidate.refreshToken) ||
        (Boolean(bestExpired.refreshToken) === Boolean(candidate.refreshToken) &&
          (candidate.expiresAt ?? Number.NEGATIVE_INFINITY) >= (bestExpired.expiresAt ?? Number.NEGATIVE_INFINITY))
      ) {
        bestExpired = candidate;
      }
      continue;
    }
    const bestStamp = best?.expiresAt ?? Number.NEGATIVE_INFINITY;
    const stamp = candidate.expiresAt ?? Number.NEGATIVE_INFINITY;
    if (!best || stamp >= bestStamp) best = candidate;
  }
  if (best) {
    return {
      token: best.token,
      accountId: null,
      expired: false,
      refreshToken: best.refreshToken,
      store: makeStore(best.entryKey),
    };
  }
  if (bestExpired) {
    const store = makeStore(bestExpired.entryKey);
    if (bestExpired.refreshToken && store) {
      return { token: bestExpired.token, accountId: null, expired: true, refreshToken: bestExpired.refreshToken, store };
    }
    return expiredCredential();
  }
  return missingCredential();
}

function parseAntigravityTokenFile(raw: string | null, now: number): PlanCredential {
  if (!raw) return missingCredential();
  let text = raw.trim();
  if (!text) return missingCredential();
  if (text.startsWith("go-keyring-base64:")) {
    try {
      text = Buffer.from(text.slice("go-keyring-base64:".length), "base64").toString("utf8").trim();
    } catch {
      return missingCredential();
    }
  }
  const parsed = asRecord(parseJson(text));
  if (!parsed) return missingCredential();
  const tokenObj = asRecord(parsed.token) ?? parsed;
  const token = secretString(tokenObj.access_token);
  const refreshToken = secretString(tokenObj.refresh_token) ?? secretString(parsed.refresh_token);
  if (!token && !refreshToken) return missingCredential();
  const clientId = secretString(parsed.client_id) ?? undefined;
  const clientSecret = secretString(parsed.client_secret) ?? undefined;
  const store: AntigravityRenewalTarget = {
    kind: "antigravity-memory",
    ...(clientId ? { clientId } : {}),
    ...(clientSecret ? { clientSecret } : {}),
  };
  const expiry = timeMs(tokenObj.expiry ?? tokenObj.expires_at ?? tokenObj.expiresAt);
  const expired = !token || (expiry != null && expiry <= now + 60_000);
  if (expired && !refreshToken) return expiredCredential();
  return { token, accountId: null, expired, refreshToken, store };
}

function readAntigravityCredential(
  account: PlanAccount,
  _env: NodeJS.ProcessEnv,
  source: CredentialSource,
  now: number,
  dataDir: string,
): PlanCredential {
  // Antigravity strips inherited host GEMINI_HOME; only an instance's own environment overrides its Dusk profile dir.
  const customHome = account.environment.GEMINI_HOME?.trim();
  const paths = customHome
    ? [
        join(customHome, ANTIGRAVITY_APP_DATA_DIR, ANTIGRAVITY_CLI_TOKEN_FILE),
        join(customHome, ANTIGRAVITY_APP_DATA_DIR, ANTIGRAVITY_LEGACY_TOKEN_FILE),
        join(customHome, "jetski-standalone-oauth-token"),
      ]
    : [
        join(antigravityProfileDirectory(account.id, dataDir), ANTIGRAVITY_APP_DATA_DIR, ANTIGRAVITY_CLI_TOKEN_FILE),
        join(antigravityProfileDirectory(account.id, dataDir), ANTIGRAVITY_APP_DATA_DIR, ANTIGRAVITY_LEGACY_TOKEN_FILE),
      ];
  let sawExpired: PlanCredential | null = null;
  for (const path of paths) {
    const parsed = parseAntigravityTokenFile(source.readText(path), now);
    if ((parsed.token && !parsed.expired) || parsed.refreshToken) return parsed;
    if (parsed.expired && !sawExpired) sawExpired = parsed;
  }
  return sawExpired ?? missingCredential();
}

function formatCursorMembership(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value.trim().replace(/^unified_/i, "");
  return cleaned ? planLabel(titleWords(cleaned)) : null;
}

function cursorStateDbPath(env: NodeJS.ProcessEnv): string {
  const home = userHome(env);
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  if (process.platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "Cursor", "User", "globalStorage", "state.vscdb");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "Cursor", "User", "globalStorage", "state.vscdb");
}

function cursorCredentialFromTokens(
  access: string | null,
  refresh: string | null,
  now: number,
  options: { planHint?: string | null; store?: CursorRenewalTarget } = {},
): PlanCredential {
  const token = access ?? refresh;
  if (!token) return missingCredential();
  const expiry = jwtExpiryMs(token);
  const expired = expiry != null && expiry <= now;
  const effectiveRefresh = refresh ?? access;
  if (expired && !(effectiveRefresh && options.store)) return expiredCredential();
  return {
    token,
    accountId: jwtSubject(token),
    expired,
    refreshToken: effectiveRefresh,
    planHint: options.planHint ?? null,
    store: options.store,
  };
}

function cursorCredentialFromFile(filePath: string, source: CredentialSource, now: number): PlanCredential {
  const doc = asRecord(parseJson(source.readText(filePath)));
  if (!doc) return missingCredential();
  const access = secretString(doc.accessToken) ?? secretString(doc.access_token);
  const refresh = secretString(doc.refreshToken) ?? secretString(doc.refresh_token);
  const store: CursorRenewalTarget | undefined = source.writable ? { kind: "cursor-file", filePath } : undefined;
  return cursorCredentialFromTokens(access, refresh, now, { store });
}

async function readCursorCredential(
  env: NodeJS.ProcessEnv,
  source: CredentialSource,
  now: number,
): Promise<PlanCredential> {
  const envToken = secretString(env.CURSOR_AUTH_TOKEN);
  if (envToken) return cursorCredentialFromTokens(envToken, null, now);

  const customDir = env.CURSOR_CONFIG_DIR?.trim();
  if (customDir) {
    return cursorCredentialFromFile(join(customDir, "auth.json"), source, now);
  }

  const home = userHome(env);
  const xdgConfig = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  const filePaths = [join(home, ".cursor", "auth.json"), join(xdgConfig, "cursor", "auth.json")];
  let sawExpired: PlanCredential | null = null;
  for (const filePath of filePaths) {
    const parsed = cursorCredentialFromFile(filePath, source, now);
    if ((parsed.token && !parsed.expired) || (parsed.expired && parsed.refreshToken && parsed.store)) return parsed;
    if (parsed.expired && !sawExpired) sawExpired = parsed;
  }

  if (source.readCursorKeychain) {
    try {
      const kc = await source.readCursorKeychain();
      const parsed = cursorCredentialFromTokens(kc.accessToken, kc.refreshToken, now);
      if (parsed.token && !parsed.expired) return parsed;
      if (parsed.expired && !sawExpired) sawExpired = parsed;
    } catch {}
  }

  if (source.readCursorIdeDb) {
    try {
      const ide = source.readCursorIdeDb(cursorStateDbPath(env));
      if (ide) {
        const parsed = cursorCredentialFromTokens(ide.accessToken, ide.refreshToken, now, {
          planHint: formatCursorMembership(ide.membership),
        });
        if (parsed.token && !parsed.expired) return parsed;
        if (parsed.expired && !sawExpired) sawExpired = parsed;
      }
    } catch {}
  }

  return sawExpired ?? missingCredential();
}

function openCodeDataDirs(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME || env.USERPROFILE || homedir();
  const roots = [
    env.XDG_DATA_HOME || join(home, ".local", "share"),
    process.platform === "darwin"
      ? join(home, "Library", "Application Support")
      : process.platform === "win32"
        ? env.LOCALAPPDATA || join(home, "AppData", "Local")
        : "",
  ].filter(Boolean);
  return [...new Set(roots)].map((root) => join(root, "opencode"));
}

function openCodeGoKeyFromJson(text: string | null): string | null {
  const parsed = asRecord(parseJson(text));
  const entry = asRecord(parsed?.["opencode-go"]);
  return secretString(entry?.key);
}

function readOpenCodeCredential(env: NodeJS.ProcessEnv, source: CredentialSource): PlanCredential {
  const dirs = openCodeDataDirs(env);
  if (source.readOpenCodeDbKey) {
    for (const dir of dirs) {
      try {
        const key = secretString(source.readOpenCodeDbKey(dir));
        if (key) return { token: key, accountId: null, expired: false };
      } catch {}
    }
  }
  for (const dir of dirs) {
    const key = openCodeGoKeyFromJson(source.readText(join(dir, "auth.json")));
    if (key) return { token: key, accountId: null, expired: false };
  }
  const fromEnv = openCodeGoKeyFromJson(env.OPENCODE_AUTH_CONTENT ?? null);
  if (fromEnv) return { token: fromEnv, accountId: null, expired: false };
  return missingCredential();
}
