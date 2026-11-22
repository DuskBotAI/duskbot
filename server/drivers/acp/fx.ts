// Stock fx engine ("fx acp", Vercel Labs fx). DuskBot runs fx in its own FX_HOME folder so
// sessions and settings never touch ~/.fx, while sharing sign-in files from ~/.fx.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import type { ApprovalMode } from "../../../shared/approval-mode.ts";
import { writeFileAtomicIfChanged } from "../../atomic.ts";
import { DATA_DIR } from "../../config.ts";
import type { ModelCatalog, SendTurnInput } from "../../contracts.ts";
import { syncSignIn } from "../../engine-homes/sign-ins.ts";
import { userHome } from "../../env-path.ts";
import { decodeInjectId, hostApiKey, injectedContextWindow, localHost, mergeLocalInject } from "../local-inject.ts";
import { acpVariantOption } from "./config-options.ts";
import { createAcpDriver, type AcpConfig, type AcpSupport } from "./core.ts";
import { discoverAcpModels } from "./custom-model-catalog.ts";

export const FX_AGENT_DEFAULT = "agent-default";
const AGENT_DEFAULT = FX_AGENT_DEFAULT;

// Stock fx enforces a 64 KiB cap and append-only mode for ACP client system prompts
// (src/acp/client_instructions.zig).
export const FX_SYSTEM_PROMPT_MAX_BYTES = 64 * 1024;

// Built-in provider names that stock fx reserves in settings.json (configured_provider.zig).
const RESERVED_PROVIDER_IDS = new Set(["gateway", "codex", "grok"]);

const EMPTY: ModelCatalog = {
  default: AGENT_DEFAULT,
  options: [{ id: AGENT_DEFAULT, label: "Agent default", custom: true }],
};

/** Maps DuskBot approval levels to stock fx's ACP mode IDs (`ask`, `auto`, `full-access`). */
export function fxApprovalMode(mode: ApprovalMode | undefined, fullAuto: boolean): "ask" | "auto" | "full-access" {
  if (mode === "full") return "full-access";
  if (mode === "auto") return "auto";
  if (mode === "ask" || mode === "edits" || mode === "custom") return "ask";
  return fullAuto ? "full-access" : "ask";
}

/** Sign-in files written by `fx login` / `fx login vercel --api-key` in `~/.fx`. */
export const FX_SIGN_IN_FILES = ["auth.json", "chatgpt-auth.json", "grok-auth.json", "api-key"] as const;

/** Environment credentials recognized by stock fx for Vercel AI Gateway. */
export const FX_CREDENTIAL_ENV = ["AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN"] as const;

/** Isolated FX_HOME for DuskBot: uses explicit FX_HOME when valid for stock fx (absolute,
 * not `/` and not `HOME`), otherwise `<dataDir>/engines/fx`. */
export function fxHomeDir(env: Record<string, string | undefined> = process.env, dataDir: string = DATA_DIR): string {
  const explicit = env.FX_HOME?.trim();
  if (explicit && isAbsolute(explicit)) {
    const normalized = resolve(explicit);
    const home = userHome(env);
    if (normalized !== resolve("/") && (!home || normalized !== resolve(home))) {
      return normalized;
    }
  }
  return join(dataDir, "engines", "fx");
}

/** Syncs `fx login` credentials between the user's `~/.fx` and DuskBot's isolated `FX_HOME`. */
export function shareFxSignIns(fxHome: string, home: string): void {
  const own = join(home, ".fx");
  if (resolve(own) === resolve(fxHome)) return;
  for (const file of FX_SIGN_IN_FILES) {
    const source = join(own, file);
    if (!existsSync(source)) continue;
    try { syncSignIn({ source, target: join(fxHome, file) }); } catch {}
  }
}

/** Converts a DuskBot local host id into a valid, non-reserved stock fx provider id
 * (`^[a-z][a-z0-9_-]*$`, max 64 bytes, never `gateway`, `codex`, or `grok`). */
export function fxProviderId(raw: string): string {
  let cleaned = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!cleaned) cleaned = "custom";
  if (!/^[a-z]/.test(cleaned) || RESERVED_PROVIDER_IDS.has(cleaned)) {
    cleaned = `dusk-${cleaned}`;
  }
  return cleaned.slice(0, 64);
}

function providerAuthEnvKey(providerId: string): string {
  const slug = providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return `FX_DUSK_PROVIDER_${slug}_KEY`;
}

export interface FxInjectBinding {
  providerId: string;
  modelId: string;
  envKey?: string;
  apiKey?: string;
}

function objectField(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function readSettings(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Merges one custom provider connection into DuskBot's fx `settings.json` using only fields
 * accepted by stock fx (`configured_provider.zig`), preserving other saved providers and models. */
export function writeFxProvider(fxHome: string, id: string, entry: Record<string, unknown>, options: {
  model?: string;
  keepModel?: boolean;
  mergeModelMetadata?: boolean;
} = {}): boolean {
  mkdirSync(fxHome, { recursive: true, mode: 0o700 });
  const settingsPath = join(fxHome, "settings.json");
  const settings = readSettings(settingsPath);
  if (!settings) {
    console.warn("[fx] settings.json is not valid JSON; its providers were left unchanged");
    return false;
  }
  const providers = objectField(settings.providers);
  const models = objectField(settings.models);
  const saved = objectField(objectField(providers[id]).model_metadata);
  const metadata = { ...(options.mergeModelMetadata ? saved : {}), ...objectField(entry.model_metadata) };
  providers[id] = Object.keys(metadata).length ? { ...entry, model_metadata: metadata } : entry;
  if (options.model && !(options.keepModel && typeof models[id] === "string")) models[id] = options.model;
  const next = { ...settings, providers, models };
  writeFileAtomicIfChanged(settingsPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return true;
}

/** Registers a DuskBot local or gateway model as a configured OpenAI-compatible provider in FX_HOME. */
export function ensureFxInjectProvider(
  modelId: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
  dataDir: string = DATA_DIR,
): FxInjectBinding | null {
  const inject = decodeInjectId(modelId);
  if (!inject) return null;
  const host = localHost(inject.host);
  if (!host) return null;

  const providerId = fxProviderId(inject.host);
  const apiKey = hostApiKey(host, env)?.trim() || "";
  const envKey = apiKey ? providerAuthEnvKey(providerId) : undefined;
  const window = injectedContextWindow(modelId);
  writeFxProvider(fxHomeDir(env, dataDir), providerId, {
    protocol: "openai-chat-completions",
    base_url: host.baseUrl,
    auth: envKey ? { type: "bearer", env: envKey } : { type: "none" },
    ...(window ? { model_metadata: { [inject.model]: { context_window: window } } } : {}),
  }, { model: inject.model, mergeModelMetadata: true });
  return { providerId, modelId: inject.model, ...(envKey ? { envKey, apiKey } : {}) };
}

/** Prepares each fx child environment with an isolated `FX_HOME` and synced sign-in files. */
export function prepareFxEnv(env: Record<string, string | undefined>, dataDir: string = DATA_DIR): void {
  env.FX_HOME = fxHomeDir(env, dataDir);
  mkdirSync(env.FX_HOME, { recursive: true, mode: 0o700 });
  shareFxSignIns(env.FX_HOME, userHome(env));
}

function stableSystemPromptForSession(turn: SendTurnInput): string | null {
  const system = (typeof turn.systemStable === "string" ? turn.systemStable : turn.system)?.trim() ?? "";
  if (!system || system.includes("\0")) return null;
  if (Buffer.byteLength(system, "utf8") > FX_SYSTEM_PROMPT_MAX_BYTES) return null;
  return system;
}

/** `session/new` params for stock fx: passes the bot's standing instructions via the ACP client
 * system prompt RFD (`append` mode, <= 64 KiB). Stock fx persists the prompt with the session and
 * restores it on `session/load`. */
export function fxSessionNewParams(turn: SendTurnInput): Record<string, unknown> {
  const system = stableSystemPromptForSession(turn);
  if (!system) return {};
  return {
    systemPrompt: [{ type: "text", text: system }],
    systemPromptMode: "append",
  };
}

/** Composes the prompt text for stock fx. Strips the leading standing instructions only when they
 * fit into `session/new`'s `systemPrompt` field; oversized prompts keep them inline. */
export function fxPromptText(turn: SendTurnInput): string {
  const stable = stableSystemPromptForSession(turn);
  if (stable) {
    return turn.text.startsWith(stable) ? turn.text.slice(stable.length).replace(/^\s+/, "") : turn.text;
  }
  return turn.system ? `${turn.system}\n\n${turn.text}` : turn.text;
}

async function resolveModels(
  env: Record<string, string | undefined>,
  config: AcpConfig,
): Promise<ModelCatalog> {
  const injected = await mergeLocalInject(EMPTY, env);
  const cli = config.cli?.trim() || "fx";
  let remote: ModelCatalog = EMPTY;
  try {
    remote = await discoverAcpModels(env, cli, ["acp"], {
      passthrough: { id: AGENT_DEFAULT, label: "Agent default" },
      custom: true,
    });
  } catch {
    remote = EMPTY;
  }
  const seen = new Set<string>();
  const options = [...remote.options, ...injected.options].filter((opt) => {
    if (seen.has(opt.id)) return false;
    seen.add(opt.id);
    return true;
  });
  return { default: options[0]?.id ?? AGENT_DEFAULT, options };
}

/** Selects a local/gateway provider at launch; stock fx's own providers switch via ACP config options. */
export function fxSpawnArgs(turn: Pick<SendTurnInput, "model">): string[] {
  const inject = decodeInjectId(turn.model);
  return inject ? ["acp", "--provider", fxProviderId(inject.host), "--model", inject.model] : ["acp"];
}

/** Applies the turn's approval mode, model, and advertised reasoning effort over stock fx ACP. */
export async function fxConfigureSession(ctx: {
  request: (method: string, params: unknown) => Promise<unknown>;
  sessionId: string;
  turn: Pick<SendTurnInput, "model" | "effort" | "approvalMode">;
  config: Pick<AcpConfig, "fullAuto">;
  configOptions?: unknown[];
}): Promise<void> {
  const { request, sessionId, turn, config } = ctx;
  await request("session/set_mode", { sessionId, modeId: fxApprovalMode(turn.approvalMode, config.fullAuto === true) });
  let options: unknown = { configOptions: ctx.configOptions ?? [] };
  if (turn.model && turn.model !== AGENT_DEFAULT && !decodeInjectId(turn.model)) {
    const picked = await request("session/set_config_option", { sessionId, configId: "model", value: turn.model });
    if (Array.isArray((picked as { configOptions?: unknown } | null)?.configOptions)) options = picked;
  }
  const effort = acpVariantOption(options);
  if (turn.effort && effort?.options.some((option) => option.id === turn.effort)) {
    await request("session/set_config_option", { sessionId, configId: effort.configId, value: turn.effort });
  }
}

const support: AcpSupport = {
  driverKind: "fxAgent",
  displayName: "fx",
  access: "custom",
  models: EMPTY,
  defaultCli: "fx",
  nativeSource: "fx.acp",
  images: true,
  credentialEnv: FX_CREDENTIAL_ENV,
  ownMcpOverHttp: true,
  sessionScopedApproval: true,
  effortLevels: ["low", "medium", "high", "xhigh"],
  loginNote: "Install fx (https://fx.sh) and sign in with fx login, or pick a local or gateway model.",
  install: {
    command: {
      darwin: "curl -fsSL https://fx.sh/setup.sh | bash",
      linux: "curl -fsSL https://fx.sh/setup.sh | bash",
    },
    docsUrl: "https://fx.sh/docs",
    signInCommand: "fx login",
  },
  transformEnv: (env) => prepareFxEnv(env),
  spawnArgs: (_config, turn) => fxSpawnArgs(turn),
  applyTurnEnv: (env, ctx) => {
    const binding = ensureFxInjectProvider(ctx.requestedModel ?? ctx.model, env);
    if (binding?.envKey && binding.apiKey) env[binding.envKey] = binding.apiKey;
  },
  resolveModels,
  resolveModelsOnCreate: false,
  sessionNewParams: (turn) => fxSessionNewParams(turn),
  buildPromptText: fxPromptText,
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: () => true,
  configureSession: (ctx) => fxConfigureSession(ctx),
};

export const FxAgentDriver = createAcpDriver(support);
