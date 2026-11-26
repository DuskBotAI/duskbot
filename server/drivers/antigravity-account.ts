import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

type Identity = { email: string; method: "login" } | undefined;
const identities = new Map<string, { fingerprint: string; expires: number; result: Promise<Identity> }>();
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validEmail(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 254 && EMAIL_PATTERN.test(value) ? value : undefined;
}

export function clearAntigravityAccountCache(...paths: Array<string | undefined>): void {
  for (const path of paths) {
    if (path) identities.delete(path);
  }
}

/** Read the display email stored by Antigravity CLI 1.5+ (`id_token_email`), or resolve it
 * through Google for token files that omit it; never expose or rewrite tokens. */
export async function antigravityAccount(tokenPath: string, fallbackTokenPath?: string): Promise<Identity> {
  const primary = await lookupFromFile(tokenPath);
  if (primary !== undefined || !fallbackTokenPath) return primary;
  return lookupFromFile(fallbackTokenPath);
}

async function lookupFromFile(tokenPath: string): Promise<Identity> {
  try {
    const info = await stat(tokenPath);
    if (!info.isFile() || info.size > 1024 * 1024) return undefined;
    const raw = await readFile(tokenPath, "utf8");
    const fingerprint = createHash("sha256").update(raw).digest("hex");
    const cached = identities.get(tokenPath);
    if (cached?.fingerprint === fingerprint && cached.expires > Date.now()) return cached.result;
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return undefined;

    let loader: (() => Promise<Identity>) | null = null;
    const cliToken = parsed.token as Record<string, unknown> | undefined;
    const hasCliToken = Boolean(
      cliToken && typeof cliToken === "object"
      && ((typeof cliToken.access_token === "string" && cliToken.access_token.length > 0)
        || (typeof cliToken.refresh_token === "string" && cliToken.refresh_token.length > 0)),
    );
    if (hasCliToken) {
      const storedEmail = validEmail(parsed.id_token_email);
      if (storedEmail) return { email: storedEmail, method: "login" };
    }
    if (cliToken && typeof cliToken === "object" && typeof cliToken.access_token === "string" && cliToken.access_token.length > 0) {
      const expiry = typeof cliToken.expiry === "string" ? Date.parse(cliToken.expiry) : Number.NaN;
      if (Number.isFinite(expiry) && expiry <= Date.now()) return undefined;
      const accessToken = cliToken.access_token;
      loader = () => lookupWithAccessToken(accessToken);
    } else if (["client_id", "client_secret", "refresh_token"].every((key) => typeof parsed[key] === "string" && (parsed[key] as string).length > 0)) {
      const credentials = {
        client_id: parsed.client_id as string,
        client_secret: parsed.client_secret as string,
        refresh_token: parsed.refresh_token as string,
      };
      loader = () => lookupWithRefreshCredentials(credentials);
    }
    if (!loader) return undefined;

    const entry = { fingerprint, expires: Date.now() + 60_000, result: Promise.resolve<Identity>(undefined) };
    entry.result = loader().then((account) => {
      if (account) entry.expires = Date.now() + 60 * 60_000;
      return account;
    });
    if (identities.size >= 128) identities.delete(identities.keys().next().value!);
    identities.set(tokenPath, entry);
    return entry.result;
  } catch {
    identities.delete(tokenPath);
    return undefined;
  }
}

async function lookupWithAccessToken(accessToken: string, signal = AbortSignal.timeout(3_000)): Promise<Identity> {
  try {
    const identity = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` }, redirect: "error", signal,
    });
    if (!identity.ok) return undefined;
    const user = await identity.json() as { email?: unknown };
    const email = validEmail(user.email);
    if (!email) return undefined;
    return { email, method: "login" };
  } catch {
    // Identity lookup failure must not mark a working engine as signed out.
    return undefined;
  }
}

async function lookupWithRefreshCredentials(credentials: { client_id: string; client_secret: string; refresh_token: string }): Promise<Identity> {
  try {
    const signal = AbortSignal.timeout(3_000);
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", redirect: "error", signal,
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
        refresh_token: credentials.refresh_token,
      }),
    });
    if (!response.ok) return undefined;
    const token = await response.json() as { access_token?: unknown };
    if (typeof token.access_token !== "string" || !token.access_token) return undefined;
    return lookupWithAccessToken(token.access_token, signal);
  } catch {
    return undefined;
  }
}
