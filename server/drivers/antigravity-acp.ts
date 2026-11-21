// Antigravity CLI 1.5+ ACP client, profile isolation, `--login` code flow, and ACP `logout`.
//
// `--login` code validation and `SSH_CONNECTION` per-profile storage behavior adapted from
// pingdotgg/t3code (MIT License, Copyright (c) 2026 T3 Tools Inc., full text in
// third_party/t3-code/LICENSE): apps/server/src/provider/antigravityAuthSupport.ts,
// AntigravityAuth.ts, and Drivers/AntigravityDriver.ts.
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { DATA_DIR, stripWorkspaceCredentialEnv } from "../config.ts";
import { writeFileAtomic } from "../atomic.ts";
import { killCliTree, spawnCli } from "../procs.ts";
import type { ModelCatalog } from "../contracts.ts";
import type { ChildProcess } from "node:child_process";
import type { AntigravityRuntime } from "./antigravity-runtime.ts";
import { acpVariantOption, surveyModelVariants } from "./acp/config-options.ts";
import { StderrTail, exitDetail } from "./acp/exit-report.ts";
import {
  VERIFICATION_TEMP_KEY,
  antigravityTempDir,
  folderBytes,
  setAntigravityTempEnvironment,
  sweepAntigravityTemp,
} from "./antigravity-temp.ts";

// Legacy 1.4 standalone server printed this prefix on stderr.
export const ANTIGRAVITY_AUTH_PREFIX = "Open the following link to authenticate the ACP server: ";
export const ANTIGRAVITY_CODE_REDIRECT_URI = "https://antigravity.google/oauth-callback";
const AUTH_TIMEOUT_MS = 5 * 60_000;
const COMPLETE_TIMEOUT_MS = 90_000;
const LOGOUT_TIMEOUT_MS = 90_000;
// Cold start can take tens of seconds, especially on Windows.
const STARTUP_TIMEOUT_MS = 90_000;
const STARTUP_CAP_MS = 5 * 60_000;
const UNPACK_COUNT_BUDGET_MS = 5_000;
// A new session names thinking levels only for its current model, so discovery switches through the rest (~1.5 s each).
const VARIANT_SURVEY_MS = 15_000;
const MAX_PROTOCOL_LINE_BYTES = 16 * 1024 * 1024;
const MAX_DIAGNOSTIC_LINE_CHARS = 64 * 1024;
const GRACEFUL_EXIT_MS = 5_000;

export const ANTIGRAVITY_APP_DATA_DIR = "antigravity-acp";
export const ANTIGRAVITY_CLI_TOKEN_FILE = "antigravity-oauth-token";
export const ANTIGRAVITY_LEGACY_TOKEN_FILE = "acp_token.json";

export interface AntigravityProfile {
  directory: string;
  tokenPath: string;
  legacyTokenPath: string;
  environment: NodeJS.ProcessEnv;
  tempDirectory?: string;
}

const REMOVED_ENVIRONMENT_KEYS = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "AGY_ACP_CCPA_PROJECT",
  "AGY_ACP_ENABLE_OAUTH",
  "AGY_ACP_DEFAULT_MODEL",
  "GEMINI_HOME",
  "AGY_ACP_FORCE_FILE_STORAGE",
  "AGY_CLI_DISABLE_AUTO_UPDATE",
  "ANTIGRAVITY_HARNESS_PATH",
  "BROWSER",
  "PYTHONUNBUFFERED",
  "ELECTRON_RUN_AS_NODE",
  // An inherited pipe whose owner exited makes Electron-as-Node print Crashpad errors to stderr.
  "CHROME_CRASHPAD_PIPE_NAME",
]);

const BROWSER_MARKER = "__DUSK_ANTIGRAVITY_AUTH_URL__";
const browserHelperSource =
  `process.stderr.on("error",()=>process.exit(0)).write(` +
  `"${BROWSER_MARKER}"+JSON.stringify(process.argv[1])+"\\n",` +
  `()=>process.exit(0))`;

function quoteBrowserArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function takeLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.map((line) => line.replace(/\r$/u, "")), rest };
}

export function antigravityAcpArgs(profileDirectory: string): string[] {
  return ["acp", "--gemini-dir", profileDirectory, "--app-data-dir", ANTIGRAVITY_APP_DATA_DIR];
}

/** Only fixed, allowlisted hints leave stderr: native output can carry OAuth codes in any format. */
function startupHint(line: string): string | undefined {
  if (/no space left|not enough (?:space|disk)|disk (?:is )?full|winerror\s*112/iu.test(line)) {
    return "The runtime reported insufficient disk space while starting.";
  }
  if (/failed to (?:extract|load (?:python|embedded python))|could not load python/iu.test(line)) {
    return "The runtime reported a problem unpacking or loading its bundled Python runtime.";
  }
  if (/permission denied|access is denied|winerror\s*5\b/iu.test(line)) {
    return "The runtime reported a file or process permission failure.";
  }
  if (/address family not supported|failed to create.*(?:socket|listener)|failed to bind|AF_INET6|enforce_kernel_ipv6_support/iu.test(line)) {
    return "The runtime reported a local network listener or IPv6 failure.";
  }
  if (/page-size\.cc|Compile-time page size does not match/iu.test(line)) {
    return "Google's linux-arm64 Antigravity runtime requires a kernel with 4 KiB memory pages.";
  }
  return undefined;
}

export function authorizationUrlFromLine(line: string): string | null {
  if (line.startsWith(ANTIGRAVITY_AUTH_PREFIX)) return line.slice(ANTIGRAVITY_AUTH_PREFIX.length).trim();
  if (!line.startsWith(BROWSER_MARKER)) return null;
  try {
    const url = JSON.parse(line.slice(BROWSER_MARKER.length));
    return typeof url === "string" ? url : null;
  } catch {
    return null;
  }
}

export function antigravityProfileDirectory(instanceId: string, baseDir = DATA_DIR): string {
  return join(baseDir, "providers", "antigravity", createHash("sha256").update(instanceId).digest("hex"));
}

/** A removed account's Google sign-in goes with its profile, so no refresh token outlives the account. Best effort:
 * the account is already gone from the config, and Windows refuses while a retiring process still holds a file. */
export async function removeAntigravityProfile(instanceId: string, baseDir = DATA_DIR): Promise<void> {
  await rm(antigravityProfileDirectory(instanceId, baseDir), { recursive: true, force: true, maxRetries: 4, retryDelay: 250 })
    .catch((error) => {
      console.warn(`antigravity: could not remove a removed account's profile: ${error instanceof Error ? error.message : String(error)}`);
    });
}

export async function removeAntigravitySignIn(instanceId: string, baseDir = DATA_DIR): Promise<void> {
  const acpDirectory = join(antigravityProfileDirectory(instanceId, baseDir), ANTIGRAVITY_APP_DATA_DIR);
  await Promise.all([
    rm(join(acpDirectory, ANTIGRAVITY_CLI_TOKEN_FILE), { force: true, maxRetries: 4, retryDelay: 250 }),
    rm(join(acpDirectory, ANTIGRAVITY_LEGACY_TOKEN_FILE), { force: true, maxRetries: 4, retryDelay: 250 }),
  ]);
}

function resolveLinuxCaBundle(baseEnv: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  if (platform !== "linux" || baseEnv.SSL_CERT_FILE !== undefined || baseEnv.SSL_CERT_DIR !== undefined) {
    return undefined;
  }
  for (const candidate of [
    baseEnv.NIX_SSL_CERT_FILE,
    "/etc/ssl/certs/ca-bundle.crt",
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/ssl/cert.pem",
  ]) {
    if (candidate && candidate.startsWith("/") && existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** An isolated Google profile per instance; foreign Google credentials are stripped so the account
 * and billing never change silently. */
export async function prepareAntigravityProfile(input: {
  instanceId: string;
  runtime: AntigravityRuntime;
  baseEnv?: NodeJS.ProcessEnv;
  baseDir?: string;
  profileDirectory?: string;
  tempDirectory?: string;
  platform?: NodeJS.Platform;
}): Promise<AntigravityProfile> {
  const platform = input.platform ?? process.platform;
  const directory = resolve(input.profileDirectory ?? antigravityProfileDirectory(input.instanceId, input.baseDir));
  const acpDirectory = join(directory, ANTIGRAVITY_APP_DATA_DIR);
  await mkdir(acpDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    const { chmod } = await import("node:fs/promises");
    await chmod(directory, 0o700);
    await chmod(acpDirectory, 0o700);
  }
  writeFileAtomic(
    join(acpDirectory, "settings.json"),
    `${JSON.stringify({ auth: { type: "oauth-personal" } })}\n`,
    { mode: 0o600 },
  );

  const executable = process.platform === "win32" ? process.execPath.replaceAll("\\", "/") : process.execPath;
  if (/\r|\n|\0|%s/u.test(executable) || executable.includes(delimiter)) {
    throw new Error("The dusk bot runtime path cannot safely suppress Antigravity browser launches.");
  }
  const browserCommand = [executable, "-e", browserHelperSource, "--", "%s"]
    .map(quoteBrowserArgument)
    .join(" ");
  const sourceEnv = input.baseEnv ?? process.env;
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (!REMOVED_ENVIRONMENT_KEYS.has(key.toUpperCase())) environment[key] = value;
  }
  stripWorkspaceCredentialEnv(environment);
  const caBundlePath = resolveLinuxCaBundle(sourceEnv, platform);
  Object.assign(environment, {
    ...(caBundlePath ? { SSL_CERT_FILE: caBundlePath } : {}),
    // Antigravity CLI 1.5+ stores personal Google sign-ins in a single OS keyring entry shared by
    // every profile unless it sees SSH_CONNECTION, in which case it stores per-profile files.
    SSH_CONNECTION: sourceEnv.SSH_CONNECTION || "127.0.0.1 0 127.0.0.1 0",
    GEMINI_HOME: directory,
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    AGY_CLI_DISABLE_AUTO_UPDATE: "1",
    BROWSER: browserCommand,
    PYTHONUNBUFFERED: "1",
    ELECTRON_RUN_AS_NODE: "1",
  });
  let tempDirectory: string | undefined;
  if (platform === "win32") {
    tempDirectory = resolve(input.tempDirectory ?? antigravityTempDir(input.baseDir ?? DATA_DIR, input.instanceId));
    await mkdir(tempDirectory, { recursive: true });
    setAntigravityTempEnvironment(environment, tempDirectory, "win32");
  }
  return {
    directory,
    tokenPath: join(acpDirectory, ANTIGRAVITY_CLI_TOKEN_FILE),
    legacyTokenPath: join(acpDirectory, ANTIGRAVITY_LEGACY_TOKEN_FILE),
    environment,
    ...(tempDirectory ? { tempDirectory } : {}),
  };
}

async function readableTokenFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size <= 0 || info.size > 1024 * 1024) return false;
    await readFile(path, { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

export async function antigravityProfileAuthenticated(profile: Pick<AntigravityProfile, "tokenPath">): Promise<boolean> {
  return readableTokenFile(profile.tokenPath);
}

interface PendingRpc {
  resolve(value: any): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface AntigravityAcpClientOptions {
  onAuthorizationUrl?: (url: string) => void;
  sharedNetwork?: boolean;
}

export class AntigravityAcpClient {
  readonly child: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, PendingRpc>();
  private buffer = "";
  private diagnosticBuffer = "";
  private initializationComplete = false;
  private startupOutputBytes = 0;
  private startupDiagnosticBytes = 0;
  private nativeStartupHint?: string;
  private readonly stderrTail = new StderrTail();
  private closed = false;
  private stopping?: Promise<boolean>;
  private readonly onAuthorizationUrl?: (url: string) => void;
  private readonly tempDirectory?: string;
  readonly exited: Promise<void>;

  constructor(
    runtime: AntigravityRuntime,
    profile: Pick<AntigravityProfile, "directory" | "environment" | "tempDirectory">,
    cwd: string,
    onAuthorizationUrlOrOptions?: ((url: string) => void) | AntigravityAcpClientOptions,
  ) {
    const options: AntigravityAcpClientOptions = typeof onAuthorizationUrlOrOptions === "function"
      ? { onAuthorizationUrl: onAuthorizationUrlOrOptions, sharedNetwork: true }
      : onAuthorizationUrlOrOptions ?? {};
    this.onAuthorizationUrl = options.onAuthorizationUrl;
    this.tempDirectory = profile.tempDirectory;
    this.child = spawnCli(
      runtime.executablePath,
      antigravityAcpArgs(profile.directory),
      {
        cwd,
        env: profile.environment,
        stdio: ["pipe", "pipe", "pipe"],
        ...(options.sharedNetwork ? { box: { net: "shared" as const } } : {}),
      },
      "bot",
    );
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => this.consume(chunk));
    // Never surface raw stderr: it can contain authorization codes. Only masked last lines reach the exit message.
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (chunk: string) => this.consumeDiagnostics(chunk));
    this.child.once("error", (error) => this.failAll(error));
    this.exited = new Promise((resolveExit) => {
      this.child.once("close", (code, signal) => {
        if (authorizationUrlFromLine(this.diagnosticBuffer) === null) this.noteDiagnostic(this.diagnosticBuffer);
        this.diagnosticBuffer = "";
        if (!this.closed) this.failAll(new Error(
          `Antigravity ACP exited ${code ?? signal ?? "unexpectedly"}${exitDetail(code, signal, this.stderrTail.text)}.${this.nativeStartupHint ? ` ${this.nativeStartupHint}` : ""}`,
        ));
        resolveExit();
      });
    });
  }

  private consume(chunk: string) {
    if (this.closed) return;
    if (!this.initializationComplete) this.startupOutputBytes += Buffer.byteLength(chunk);
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_PROTOCOL_LINE_BYTES) {
      this.failAll(new Error("Antigravity sent a protocol line that is too large."));
      this.close();
      return;
    }
    const { lines, rest } = takeLines(this.buffer);
    this.buffer = rest;
    for (const line of lines) {
      if (this.announceAuthorizationUrl(line)) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof message?.id !== "number") continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message ?? "Antigravity ACP request failed.");
        Object.assign(error, { code: message.error.code, data: message.error.data });
        pending.reject(error);
      } else pending.resolve(message.result);
    }
  }

  private announceAuthorizationUrl(line: string): boolean {
    const raw = authorizationUrlFromLine(line);
    if (raw === null) return false;
    try {
      this.onAuthorizationUrl?.(parseAntigravityAuthorizationUrl(raw).authorizationUrl);
    } catch (error) {
      this.failAll(error instanceof Error ? error : new Error(String(error)));
    }
    return true;
  }

  private consumeDiagnostics(chunk: string) {
    if (!this.initializationComplete) this.startupDiagnosticBytes += Buffer.byteLength(chunk);
    const { lines, rest } = takeLines(this.diagnosticBuffer + chunk);
    this.diagnosticBuffer = rest.length > MAX_DIAGNOSTIC_LINE_CHARS ? "" : rest;
    for (const line of lines) {
      if (!this.announceAuthorizationUrl(line)) this.noteDiagnostic(line);
    }
  }

  private noteDiagnostic(line: string) {
    this.noteStartupDiagnostic(line);
    this.stderrTail.note(line);
  }

  private noteStartupDiagnostic(line: string) {
    if (!this.initializationComplete) this.nativeStartupHint ??= startupHint(line);
  }

  private failAll(error: Error) {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(
    method: string,
    params: unknown,
    timeoutMs = 30_000,
    expired: () => Promise<number | Error> = async () => new Error(`${method} timed out.`),
  ): Promise<any> {
    if (this.closed) return Promise.reject(new Error("Antigravity ACP is closed."));
    const id = this.nextId++;
    return new Promise((resolveRequest, reject) => {
      const arm = (milliseconds: number) => {
        const timer = setTimeout(async () => {
          const outcome = await expired();
          const pending = this.pending.get(id);
          if (!pending) return;
          if (typeof outcome === "number") {
            pending.timer = arm(outcome);
            return;
          }
          this.pending.delete(id);
          reject(outcome);
        }, milliseconds);
        timer.unref?.();
        return timer;
      };
      this.pending.set(id, { resolve: resolveRequest, reject, timer: arm(timeoutMs) });
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private async unpackedBytes(): Promise<{ bytes: number; complete: boolean }> {
    if (!this.tempDirectory) return { bytes: 0, complete: true };
    return folderBytes(this.tempDirectory, Date.now() + UNPACK_COUNT_BUDGET_MS);
  }

  async initialize(windowMs = STARTUP_TIMEOUT_MS, deadline = Date.now() + STARTUP_CAP_MS): Promise<any> {
    const started = Date.now();
    const counting = this.unpackedBytes();
    let unpacked: number | undefined;
    const expired = async (): Promise<number | Error> => {
      const before = (await counting).bytes;
      const count = await this.unpackedBytes();
      const now = count.bytes;
      const progressing = !count.complete || now > (unpacked ?? before);
      if (count.complete) unpacked = now;
      const left = deadline - Date.now();
      if (progressing && left > 0) return Math.min(windowMs, left);
      this.noteStartupDiagnostic(this.diagnosticBuffer);
      return new Error(
        `Antigravity initialization timed out after ${Math.ceil((Date.now() - started) / 1_000)} seconds (${process.platform}-${process.arch}). ` +
        "The executable was found, but did not finish starting. " +
        (this.nativeStartupHint ? `${this.nativeStartupHint} ` : "") +
        `Startup output: ${this.startupOutputBytes} bytes; diagnostic output: ${this.startupDiagnosticBytes} bytes. ` +
        (this.tempDirectory ? `Unpacked into temp: ${Math.round(Math.max(0, now - before) / 1_000_000)} MB. ` : "") +
        "Retry setup. If it still fails, share this error and your dusk bot version; do not paste Google sign-in links or tokens.",
      );
    };
    const initialized = await this.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "duskbot", version: "0.0.0" },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    }, Math.min(windowMs, Math.max(0, deadline - Date.now())), expired);
    this.initializationComplete = true;
    this.nativeStartupHint = undefined;
    this.stderrTail.clear();
    return initialized;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error("Antigravity ACP was closed."));
    this.stopping = this.stopGracefully();
  }

  private async stopGracefully(): Promise<boolean> {
    try {
      this.child.stdin?.end();
    } catch {}
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.exited,
      new Promise<void>((resolveWait) => {
        timer = setTimeout(resolveWait, GRACEFUL_EXIT_MS);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    return killCliTree(this.child);
  }

  async closeAndWait(timeoutMs = 12_000): Promise<boolean> {
    this.close();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(false), timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.stopping!, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface AntigravityAuthorizationUrl {
  authorizationUrl: string;
  redirectUri: string;
  state: string;
}

export function parseAntigravityAuthorizationUrl(
  authorizationUrl: string,
  kind: "loopback" | "code" = "loopback",
): AntigravityAuthorizationUrl {
  if (authorizationUrl.length > 16_384 || /\s/u.test(authorizationUrl)) {
    throw new Error("Antigravity returned an invalid Google sign-in URL.");
  }
  const url = new URL(authorizationUrl);
  const state = url.searchParams.get("state");
  const redirectUri = url.searchParams.get("redirect_uri");
  const validPath = kind === "loopback"
    ? url.pathname === "/o/oauth2/v2/auth"
    : url.pathname === "/o/oauth2/auth" || url.pathname === "/o/oauth2/v2/auth";
  const validRedirect = kind === "loopback"
    ? Boolean(redirectUri && /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/u.test(redirectUri))
    : redirectUri === ANTIGRAVITY_CODE_REDIRECT_URI;
  if (
    url.origin !== "https://accounts.google.com" ||
    !validPath ||
    url.username || url.password || url.hash ||
    url.searchParams.getAll("state").length !== 1 ||
    url.searchParams.getAll("redirect_uri").length !== 1 ||
    url.searchParams.getAll("response_type").length !== 1 ||
    url.searchParams.get("response_type") !== "code" ||
    !state || state.length > 512 || /\s/u.test(state) ||
    !redirectUri || !validRedirect
  ) {
    throw new Error("Antigravity returned an invalid Google sign-in URL.");
  }
  if (kind === "loopback") {
    const redirect = new URL(redirectUri);
    if (Number(redirect.port) < 1024 || Number(redirect.port) > 65535) {
      throw new Error("Antigravity returned an invalid Google sign-in URL.");
    }
  }
  return { authorizationUrl, redirectUri, state };
}

/** Validates what `agy acp --login` accepts on stdin: the code from the Antigravity page or that page's full URL. */
export function antigravityLoginResponse(
  pending: Pick<AntigravityAuthorizationUrl, "redirectUri" | "state">,
  response: string,
): string | undefined {
  const value = response.trim();
  if (/^[\w./~-]{1,2048}$/u.test(value)) return value;
  if (value.length > 16_384 || /\s/u.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    `${url.origin}${url.pathname}` !== pending.redirectUri ||
    url.username !== "" ||
    url.password !== "" ||
    url.searchParams.getAll("state").length !== 1 ||
    url.searchParams.get("state") !== pending.state ||
    url.searchParams.getAll("code").length !== 1 ||
    !url.searchParams.get("code")
  ) {
    return undefined;
  }
  return value;
}

export function validateAntigravityCallbackUrl(
  pending: { redirectUri: string; state: string },
  callbackUrl: string,
): URL {
  if (callbackUrl.length > 16_384) throw new Error("The sign-in response URL is too long.");
  let callback: URL;
  try { callback = new URL(callbackUrl); }
  catch { throw new Error("Paste the complete redirect URL from Google."); }
  const expected = new URL(pending.redirectUri);
  const states = callback.searchParams.getAll("state");
  const codes = callback.searchParams.getAll("code");
  const errors = callback.searchParams.getAll("error");
  const issuers = callback.searchParams.getAll("iss");
  if (
    callback.protocol !== "http:" || callback.hostname !== "127.0.0.1" ||
    callback.origin !== expected.origin || callback.pathname !== expected.pathname ||
    callback.username || callback.password || callback.hash ||
    states.length !== 1 || states[0] !== pending.state ||
    !((codes.length === 1 && codes[0] && errors.length === 0) ||
      (errors.length === 1 && errors[0] && codes.length === 0)) ||
    issuers.length > 1 || (issuers.length === 1 && issuers[0] !== "https://accounts.google.com")
  ) throw new Error("This redirect URL does not belong to the current sign-in.");
  return callback;
}

export function forwardAntigravityCallback(callback: URL): Promise<void> {
  return new Promise((resolveForward, reject) => {
    const req = httpRequest({
      protocol: "http:",
      hostname: "127.0.0.1",
      port: callback.port,
      path: `${callback.pathname}${callback.search}`,
      method: "GET",
      agent: false,
      timeout: 10_000,
    }, (response) => {
      response.resume();
      response.once("end", () => {
        const status = response.statusCode ?? 0;
        if (status >= 200 && status < 300) resolveForward();
        else reject(new Error("Could not deliver the Google sign-in response."));
      });
      response.once("error", reject);
    });
    req.once("timeout", () => req.destroy(new Error("The Google sign-in response timed out.")));
    req.once("error", reject);
    req.end();
  });
}

function modelOptions(value: unknown): ModelCatalog["options"] {
  if (!Array.isArray(value)) return [];
  const result: ModelCatalog["options"] = [];
  const seen = new Set<string>();
  const visit = (entry: any) => {
    if (Array.isArray(entry?.options)) return entry.options.forEach(visit);
    const id = typeof entry?.value === "string" ? entry.value : "";
    if (!id || seen.has(id)) return;
    seen.add(id);
    result.push({ id, label: typeof entry?.name === "string" && entry.name.trim() ? entry.name.trim() : id });
  };
  value.forEach(visit);
  return result;
}

export function catalogFromAntigravityConfigOptions(
  configOptions: unknown,
  fallbackDefault: string,
): ModelCatalog | null {
  const model = Array.isArray(configOptions)
    ? configOptions.find((option: any) => option?.id === "model" && option?.type === "select")
    : null;
  const options = modelOptions(model?.options);
  if (!options.length) return null;
  const current = typeof model?.currentValue === "string" ? model.currentValue : "";
  const defaultModel = options.some((option) => option.id === fallbackDefault) ? fallbackDefault : current || options[0]!.id;
  const selectedModel = current || defaultModel;
  const variants = acpVariantOption({ configOptions })?.options;
  return {
    default: defaultModel,
    options: options.map((option) => option.id === selectedModel && variants?.length ? { ...option, variants } : option),
  };
}

export async function probeAntigravityModels(input: {
  runtime: AntigravityRuntime;
  profile: AntigravityProfile;
  cwd?: string;
  fallbackDefault: string;
  timeoutMs?: number;
}): Promise<ModelCatalog> {
  const deadline = Date.now() + (input.timeoutMs ?? STARTUP_CAP_MS);
  const remaining = () => {
    const milliseconds = deadline - Date.now();
    if (milliseconds <= 0) throw new Error("Antigravity model discovery timed out.");
    return Math.min(milliseconds, STARTUP_TIMEOUT_MS);
  };
  const client = new AntigravityAcpClient(input.runtime, input.profile, input.cwd ?? input.profile.directory);
  try {
    await client.initialize(remaining(), deadline);
    await client.request("authenticate", { methodId: "oauth-personal" }, remaining());
    const session = await client.request(
      "session/new",
      { cwd: input.cwd ?? input.profile.directory, mcpServers: [] },
      remaining(),
    );
    const catalog = catalogFromAntigravityConfigOptions(session?.configOptions, input.fallbackDefault);
    if (!catalog) throw new Error("Antigravity did not return a model catalog for this Google account.");
    const budget = Math.min(VARIANT_SURVEY_MS, deadline - Date.now());
    if (budget <= 0) return catalog;
    const surveyed = await surveyModelVariants((method, params) => client.request(method, params, budget), session, budget);
    return {
      ...catalog,
      options: catalog.options.map((option) => {
        const variants = surveyed.get(option.id);
        return !option.variants?.length && variants?.length ? { ...option, variants } : option;
      }),
    };
  } finally {
    client.close();
  }
}

// ACP advertises optional operations as capability objects (even empty); older runtimes send booleans.
function capabilityAdvertised(value: unknown): boolean {
  return value === true || (typeof value === "object" && value !== null && !Array.isArray(value));
}

export function antigravitySupportsLogout(initialized: any): boolean {
  return capabilityAdvertised(initialized?.agentCapabilities?.auth?.logout);
}

const VALID_AGENT_NAMES = new Set(["Antigravity ACP Server", "antigravity-acp", "Google Antigravity"]);

export function isValidAntigravityInitializeResult(
  initialized: any,
  expectedVersion: string,
): boolean {
  if (!initialized || (initialized.protocolVersion !== 1 && initialized.protocolVersion !== 2)) return false;
  const name = initialized.agentInfo?.name;
  if (typeof name !== "string" || !VALID_AGENT_NAMES.has(name)) return false;
  const actualVersion = initialized.agentInfo?.version;
  if (typeof actualVersion !== "string") return false;
  const normalizedActual = actualVersion.replace(/^agy_acp_server_/u, "").trim();
  const normalizedExpected = expectedVersion.replace(/^agy_acp_server_/u, "").trim();
  if (actualVersion !== expectedVersion && normalizedActual !== normalizedExpected) return false;
  if (
    initialized.agentCapabilities?.loadSession !== true ||
    !capabilityAdvertised(initialized.agentCapabilities?.sessionCapabilities?.resume) ||
    !antigravitySupportsLogout(initialized)
  ) {
    return false;
  }
  if (!Array.isArray(initialized.authMethods) || !initialized.authMethods.some((method: any) => method?.id === "oauth-personal")) {
    return false;
  }
  return true;
}

export async function validateAntigravityRuntime(runtime: AntigravityRuntime, expectedVersion: string): Promise<void> {
  const profileDirectory = await mkdtemp(join(tmpdir(), "dusk-antigravity-verify-"));
  let client: AntigravityAcpClient | undefined;
  let tempDirectory: string | undefined;
  let failed = false;
  let failure: unknown;
  try {
    const profile = await prepareAntigravityProfile({
      instanceId: `verify-${randomUUID()}`,
      runtime,
      profileDirectory,
      tempDirectory: antigravityTempDir(DATA_DIR, VERIFICATION_TEMP_KEY),
    });
    tempDirectory = profile.tempDirectory;
    client = new AntigravityAcpClient(runtime, profile, profileDirectory);
    const initialized = await client.initialize();
    if (!isValidAntigravityInitializeResult(initialized, expectedVersion)) {
      throw new Error("The download did not identify as the expected Google Antigravity ACP release.");
    }
  } catch (error) {
    failed = true;
    failure = error;
  }
  // The caller is about to rename this executable's directory: touch nothing before a confirmed close.
  let stopped = !client;
  try {
    if (client) {
      stopped = await client.closeAndWait();
      if (!stopped) throw new Error("Antigravity did not shut down after runtime verification.");
    }
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  if (stopped) {
    await rm(profileDirectory, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 })
      .catch((error) => {
        console.warn(`antigravity: could not remove verification files ${profileDirectory}: ${error instanceof Error ? error.message : String(error)}`);
      });
    if (tempDirectory) {
      await sweepAntigravityTemp(VERIFICATION_TEMP_KEY).catch((error) => {
        console.warn(`antigravity: could not clear verification files: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }
  if (failed) throw failure;
}

export async function logoutAntigravity(
  runtime: AntigravityRuntime,
  profile: AntigravityProfile,
  timeoutMs = LOGOUT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    const milliseconds = deadline - Date.now();
    if (milliseconds <= 0) throw new Error("Antigravity sign-out timed out.");
    return milliseconds;
  };
  const client = new AntigravityAcpClient(runtime, profile, profile.directory, { sharedNetwork: true });
  try {
    const initialized = await client.initialize(remaining(), deadline);
    if (!antigravitySupportsLogout(initialized)) {
      throw new Error("This Antigravity version does not support sign-out. Update the provider.");
    }
    await client.request("logout", {}, remaining(), async () => new Error("Antigravity sign-out timed out."));
  } finally {
    await client.closeAndWait();
  }
  // Antigravity CLI 1.5+ logout clears only antigravity-oauth-token, leaving any 1.4 acp_token.json behind.
  await rm(profile.legacyTokenPath, { force: true, maxRetries: 4, retryDelay: 250 }).catch(() => {});
}

export interface AntigravityAuthStart {
  phase: "waiting" | "succeeded";
  flowId: string | null;
  authorizationUrl: string | null;
  expiresAt: string | null;
}

interface LoginFlow {
  id: string;
  child: ChildProcess;
  profile: AntigravityProfile;
  completed: Promise<void>;
  exited: Promise<void>;
  pending: AntigravityAuthorizationUrl;
  expiresAt: number;
  expiryTimer: ReturnType<typeof setTimeout>;
  submitted: boolean;
  stop: () => Promise<boolean>;
}

function loginEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    const upper = key.toUpperCase();
    // Without a display, `agy acp --login` prints the link instead of opening a browser on the server.
    if (upper === "DISPLAY" || upper === "WAYLAND_DISPLAY") continue;
    env[key] = value;
  }
  return env;
}

export class AntigravityAuthController {
  private flow: LoginFlow | null = null;
  private startingStop: (() => Promise<boolean>) | null = null;
  private readonly onSignedIn: () => void;

  constructor(onSignedIn: () => void = () => {}) {
    this.onSignedIn = onSignedIn;
  }

  async start(runtime: AntigravityRuntime, profile: AntigravityProfile): Promise<AntigravityAuthStart> {
    await this.cancelAndWait();
    const child = spawnCli(
      runtime.executablePath,
      [...antigravityAcpArgs(profile.directory), "--login"],
      {
        cwd: profile.directory,
        env: loginEnvironment(profile.environment),
        stdio: ["pipe", "pipe", "pipe"],
        box: { net: "shared" as const },
      },
      "bot",
    );

    let closed = false;
    let stopping: Promise<boolean> | undefined;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    const stderrTail = new StderrTail();
    let settledUrl = false;
    let foundUrl!: (value: AntigravityAuthorizationUrl) => void;
    let failUrl!: (error: Error) => void;
    const urlPromise = new Promise<AntigravityAuthorizationUrl>((resolveUrl, reject) => {
      foundUrl = (value) => { if (!settledUrl) { settledUrl = true; resolveUrl(value); } };
      failUrl = (error) => { if (!settledUrl) { settledUrl = true; reject(error); } };
    });

    let resolveExited!: () => void;
    const exited = new Promise<void>((resolveExit) => { resolveExited = resolveExit; });

    let resolveCompleted!: () => void;
    let rejectCompleted!: (error: Error) => void;
    const completed = new Promise<void>((resolveDone, rejectDone) => {
      resolveCompleted = resolveDone;
      rejectCompleted = rejectDone;
    });
    completed.catch(() => {});

    const stop = (): Promise<boolean> => {
      if (stopping) return stopping;
      closed = true;
      stopping = (async () => {
        try { child.stdin?.end(); } catch {}
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          exited,
          new Promise<void>((resolveWait) => {
            timer = setTimeout(resolveWait, GRACEFUL_EXIT_MS);
            timer.unref?.();
          }),
        ]);
        clearTimeout(timer);
        return killCliTree(child);
      })();
      return stopping;
    };
    this.startingStop = stop;

    const handleStdoutLine = (raw: string) => {
      const trimmed = raw.trim();
      const index = trimmed.indexOf("https://accounts.google.com/");
      if (index === -1) return;
      try {
        foundUrl(parseAntigravityAuthorizationUrl(trimmed.slice(index), "code"));
      } catch (error) {
        failUrl(error instanceof Error ? error : new Error(String(error)));
      }
    };

    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      const { lines, rest } = takeLines(stdoutBuffer + chunk);
      stdoutBuffer = rest.length > MAX_DIAGNOSTIC_LINE_CHARS ? "" : rest;
      for (const line of lines) handleStdoutLine(line);
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      const { lines, rest } = takeLines(stderrBuffer + chunk);
      stderrBuffer = rest.length > MAX_DIAGNOSTIC_LINE_CHARS ? "" : rest;
      for (const line of lines) stderrTail.note(line);
    });
    child.once("error", (error) => {
      failUrl(error);
      rejectCompleted(error);
    });
    child.once("close", (code, signal) => {
      if (stdoutBuffer.trim()) handleStdoutLine(stdoutBuffer);
      stdoutBuffer = "";
      if (stderrBuffer.trim()) stderrTail.note(stderrBuffer);
      stderrBuffer = "";
      resolveExited();
      if (code === 0) {
        resolveCompleted();
      } else if (closed) {
        const error = new Error("Google sign-in was cancelled.");
        failUrl(error);
        rejectCompleted(error);
      } else {
        const detail = exitDetail(code, signal, stderrTail.text);
        const error = new Error(`Antigravity could not finish Google sign-in${detail}. Start sign-in again.`);
        failUrl(error);
        rejectCompleted(error);
      }
    });

    try {
      let startupTimer: ReturnType<typeof setTimeout> | undefined;
      const startupTimeout = new Promise<never>((_resolve, reject) => {
        startupTimer = setTimeout(() => reject(new Error("Google sign-in did not start in time.")), STARTUP_TIMEOUT_MS);
        startupTimer.unref?.();
      });
      const outcome = await Promise.race([
        urlPromise.then((request) => ({ kind: "url" as const, request })),
        completed.then(() => ({ kind: "done" as const })),
        startupTimeout,
      ]).finally(() => {
        if (startupTimer) clearTimeout(startupTimer);
      });

      if (this.startingStop === stop) this.startingStop = null;
      if (closed) {
        await stop();
        throw new Error("Google sign-in was cancelled.");
      }

      if (outcome.kind === "done") {
        await stop();
        if (await antigravityProfileAuthenticated(profile)) {
          await rm(profile.legacyTokenPath, { force: true, maxRetries: 4, retryDelay: 250 }).catch(() => {});
          this.onSignedIn();
          return { phase: "succeeded", flowId: null, authorizationUrl: null, expiresAt: null };
        }
        throw new Error("Antigravity sign-in exited without returning a Google sign-in link.");
      }

      const flowId = randomUUID();
      const expiresAt = Date.now() + AUTH_TIMEOUT_MS;
      const expiryTimer = setTimeout(() => {
        if (this.flow?.id === flowId && !this.flow.submitted) {
          this.flow = null;
          void stop();
        }
      }, AUTH_TIMEOUT_MS);
      expiryTimer.unref?.();

      const flow: LoginFlow = {
        id: flowId,
        child,
        profile,
        completed,
        exited,
        pending: outcome.request,
        expiresAt,
        expiryTimer,
        submitted: false,
        stop,
      };
      this.flow = flow;
      void exited.then(() => {
        clearTimeout(expiryTimer);
        if (this.flow === flow) this.flow = null;
      });
      return {
        phase: "waiting",
        flowId,
        authorizationUrl: outcome.request.authorizationUrl,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    } catch (error) {
      if (this.startingStop === stop) this.startingStop = null;
      await stop();
      throw error;
    }
  }

  async complete(flowId: string, response: string): Promise<void> {
    const flow = this.flow;
    if (!flow || flow.id !== flowId || Date.now() >= flow.expiresAt) {
      throw new Error("This Google sign-in is no longer active. Start again.");
    }
    if (flow.submitted) {
      throw Object.assign(new Error("The sign-in code was already sent. Wait for Google to finish."), { status: 409 });
    }
    const validated = antigravityLoginResponse(flow.pending, response);
    if (!validated) {
      throw Object.assign(
        new Error("Paste the code from the Antigravity page, or that page's full URL."),
        { status: 400 },
      );
    }
    flow.submitted = true;
    clearTimeout(flow.expiryTimer);
    let completeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const completeTimeout = new Promise<never>((_resolve, reject) => {
        completeTimer = setTimeout(() => reject(new Error("Google sign-in timed out while finishing.")), COMPLETE_TIMEOUT_MS);
        completeTimer.unref?.();
      });
      flow.child.stdin!.write(`${validated}\n`);
      flow.child.stdin!.end();
      await Promise.race([flow.completed, completeTimeout]);
      if (!(await antigravityProfileAuthenticated(flow.profile))) {
        throw new Error("Antigravity finished without saving a Google sign-in. Start sign-in again.");
      }
      await rm(flow.profile.legacyTokenPath, { force: true, maxRetries: 4, retryDelay: 250 }).catch(() => {});
      this.onSignedIn();
    } finally {
      if (completeTimer) clearTimeout(completeTimer);
      clearTimeout(flow.expiryTimer);
      if (this.flow === flow) this.flow = null;
      await flow.stop();
    }
  }

  cancel(): void {
    const starting = this.startingStop;
    this.startingStop = null;
    if (starting) void starting();
    const flow = this.flow;
    if (!flow) return;
    this.flow = null;
    clearTimeout(flow.expiryTimer);
    void flow.stop();
  }

  async cancelAndWait(): Promise<void> {
    const starting = this.startingStop;
    this.startingStop = null;
    const flow = this.flow;
    this.flow = null;
    if (flow) clearTimeout(flow.expiryTimer);
    await Promise.all([
      starting ? starting() : Promise.resolve(true),
      flow ? flow.stop() : Promise.resolve(true),
    ]);
  }
}
