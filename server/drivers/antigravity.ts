// Google Antigravity through its official CLI ACP server (`agy acp`): managed runtime,
// isolated Google profile, model/mode configuration, `--login` OAuth, and ACP `logout`.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalMode } from "../../shared/approval-mode.ts";
import { antigravityAccount, clearAntigravityAccountCache } from "./antigravity-account.ts";
import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  SendTurnInput,
} from "../contracts.ts";
import { createAcpDriver, type AcpConfig, type AcpSupport } from "./acp/core.ts";
import { AntigravityAuthController } from "./antigravity-auth.ts";
import {
  antigravityAcpArgs,
  antigravityProfileAuthenticated,
  logoutAntigravity,
  prepareAntigravityProfile,
  probeAntigravityModels,
  validateAntigravityRuntime,
} from "./antigravity-acp.ts";
import {
  antigravityManagedInstallAvailable,
  installAntigravityRuntime,
  resolveAntigravityRuntime,
} from "./antigravity-runtime.ts";
import { resolveAntigravityReleaseAsset } from "./antigravity-release.ts";
import { VERIFICATION_TEMP_KEY, scheduleAntigravityTempSweep } from "./antigravity-temp.ts";
import { augmentedPath } from "../env-path.ts";

export const STATIC_ANTIGRAVITY_MODELS: ModelCatalog = {
  default: "gemini-3.8-flash",
  options: [
    {
      id: "gemini-3.8-flash",
      label: "Gemini 3.8 Flash",
      variants: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
      ],
    },
  ],
};

/** Bots saved before the thinking-level option hold ids like `gemini-3.8-flash-medium` or `gemini-4-argon-high`;
 * the official runtime offers only the base model with that option, so run the base at the saved level. A runtime
 * that still offers the suffixed id, or lacks the base, or a turn that chose its own level, keeps its selection. */
export function normalizeAntigravityTurn(turn: SendTurnInput, offeredModels: readonly string[]): SendTurnInput {
  if (turn.variant !== undefined) return turn;
  const match = turn.model?.match(/^(.+)-(low|medium|high)$/u);
  return match && offeredModels.includes(match[1]) && !offeredModels.includes(match[0])
    ? { ...turn, model: match[1], variant: match[2] }
    : turn;
}

function advertisedModeValues(configOptions: readonly any[]): string[] | undefined {
  const modeOption = configOptions.find((option) => option?.id === "mode");
  if (!Array.isArray(modeOption?.options)) return undefined;
  const values: string[] = [];
  const visit = (entry: any) => {
    if (Array.isArray(entry?.options)) entry.options.forEach(visit);
    else if (typeof entry?.value === "string" && entry.value) values.push(entry.value);
  };
  modeOption.options.forEach(visit);
  return values.length ? values : undefined;
}

/** Antigravity CLI 1.5+ rejects legacy `yolo` and `auto_edit` modes, staying in `default` while the
 * harness answers permission requests; when the session advertises `auto` or `accept-edits` (or legacy
 * `yolo` / `auto_edit`), select the matching offered mode. */
export function antigravityPermissionMode(
  fullAuto: boolean,
  approvalMode?: ApprovalMode,
  offeredModes?: readonly string[],
): string {
  if (fullAuto || approvalMode === "full") {
    return !offeredModes || offeredModes.includes("yolo") ? "yolo" : "default";
  }
  if (approvalMode === "edits") {
    if (!offeredModes || offeredModes.includes("auto_edit")) return "auto_edit";
    if (offeredModes.includes("accept-edits")) return "accept-edits";
    return "default";
  }
  if (approvalMode === "auto") {
    return offeredModes?.includes("auto") ? "auto" : "default";
  }
  return "default";
}

// Antigravity CLI 1.5+ parses slash commands anywhere in `session/prompt` text
// (not only at column 0), injecting built-in workflows such as `/learn` -> `learning_proposal.md`.
export const ANTIGRAVITY_SLASH_COMMANDS: readonly string[] = [
  "learn",
  "goal",
  "compact",
  "schedule",
  "browser",
  "plan",
  "grill-me",
  "teamwork",
  "teamwork-preview",
  "boost",
  "swarm",
  "btw",
  "side",
  "fork",
  "rewind",
  "init",
  "review",
  "remote-control",
  "add-dir",
  "codesearch",
  "statusline",
  "keybindings",
  "changelog",
  "permissions",
  "hooks",
  "plugins",
  "plugin",
  "artifact",
  "mcp",
  "skills",
  "agents",
  "context",
  "usage",
  "credits",
  "automation",
  "generative_ui",
  "agy-customizations",
  "antigravity-guide",
  "mcp-app-development",
  "run-workflow",
  "swarm_monitor",
  "swarm_pane",
];

const SLASH_COMMAND_NAME = /^[a-z0-9][a-z0-9_-]*$/iu;
const WORKSPACE_COMMAND_DIRS = [
  { relative: join(".agents", "skills"), stripExtension: false },
  { relative: join(".agents", "workflows"), stripExtension: true },
  { relative: join(".agent", "workflows"), stripExtension: true },
  { relative: join(".gemini", "skills"), stripExtension: false },
  { relative: join(".gemini", "commands"), stripExtension: true },
] as const;
const MAX_WORKSPACE_COMMANDS = 200;

function workspaceAntigravitySlashCommands(cwd?: string): string[] {
  if (!cwd) return [];
  const names: string[] = [];
  for (const { relative, stripExtension } of WORKSPACE_COMMAND_DIRS) {
    let entries: string[];
    try {
      entries = readdirSync(join(cwd, relative));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (names.length >= MAX_WORKSPACE_COMMANDS) return names;
      const name = stripExtension ? entry.replace(/\.(?:md|toml)$/iu, "") : entry;
      if (SLASH_COMMAND_NAME.test(name)) names.push(name);
    }
  }
  return names;
}

export function neutralizeAntigravitySlashCommands(
  text: string,
  availableCommands: readonly string[] = [],
  cwd?: string,
): string {
  if (!text.includes("/")) return text;
  const seen = new Set<string>();
  for (const raw of [...ANTIGRAVITY_SLASH_COMMANDS, ...availableCommands, ...workspaceAntigravitySlashCommands(cwd)]) {
    const name = raw.trim().replace(/^\/+/u, "").toLowerCase();
    if (SLASH_COMMAND_NAME.test(name)) seen.add(name);
  }
  if (!seen.size) return text;
  const alternatives = [...seen].sort((a, b) => b.length - a.length).join("|");
  const pattern = new RegExp(
    `(^|[^A-Za-z0-9_./:~-])\\/(${alternatives})(?![A-Za-z0-9_/-]|\\.[A-Za-z0-9_])`,
    "gi",
  );
  return text.replace(pattern, "$1/ $2");
}

// Antigravity CLI 1.5.18 reports a Google account its Code Assist backend refuses with these tier reason codes
// (INELIGIBLE_ACCOUNT, UNSUPPORTED_LOCATION, RESTRICTED_AGE, ...) or its own onboarding failures; a network failure
// worded the same way is not the account's fault.
const INELIGIBLE_ACCOUNT = /\b(?:INELIGIBLE_ACCOUNT|UNSUPPORTED_LOCATION|UNKNOWN_LOCATION|RESTRICTED_AGE|RESTRICTED_NETWORK|RESTRICTED_DASHER_USER|NON_USER_ACCOUNT)\b|\bnot (?:currently )?eligible\b|failed to get user's project|OnboardUser operation failed|Failed to select license|verify your account in your browser/iu;
const NETWORK_CAUSE = /\b(?:dial tcp|i\/o timeout|connection (?:refused|reset)|no such host|ENOTFOUND|ECONNRESET|ETIMEDOUT|TLS handshake|context deadline exceeded)\b/iu;

export const ANTIGRAVITY_INELIGIBLE_ACCOUNT =
  "Google won't let this account use Antigravity. Sign in at antigravity.google with it to see why, or add another Google account in Settings › Models.";

export function antigravityAccountIneligible(message: string): boolean {
  return INELIGIBLE_ACCOUNT.test(message) && !NETWORK_CAUSE.test(message);
}

export const ANTIGRAVITY_LOST_HISTORY = "Antigravity lost this chat's history on its side. Start a new chat to keep going.";
export const ANTIGRAVITY_INTERNAL_ERROR =
  "Antigravity hit an internal error and couldn't answer, even after trying again. Send your message again, or switch this bot to another AI if it keeps happening.";

/** Antigravity CLI 1.5 answers a failed turn with JSON-RPC -32603 "Internal error", or ends `session/prompt` with the
 * non-standard stop reason `error` and nothing said; `trajectory not found` means its own copy of the chat is gone. */
export function describeAntigravityFailure(message: string): string | undefined {
  if (/\btrajectory not found\b/iu.test(message)) return ANTIGRAVITY_LOST_HISTORY;
  if (/^Internal error\b|\(stop reason: error\)/iu.test(message)) return ANTIGRAVITY_INTERNAL_ERROR;
  return undefined;
}

const managedAsset = resolveAntigravityReleaseAsset();

const support: AcpSupport = {
  driverKind: "antigravityAgent",
  displayName: "Antigravity",
  models: STATIC_ANTIGRAVITY_MODELS,
  defaultCli: "agy",
  nativeSource: "antigravity.acp",
  loginNote: "Antigravity needs a Google account: choose Sign in with Google in engine setup",
  install: {
    docsUrl: "https://antigravity.google/docs/getting-started",
    ...(managedAsset
      ? { managed: { label: "Install official Antigravity", downloadBytes: managedAsset.archiveBytes ?? 90_000_000 } }
      : {}),
  },
  images: true,
  spawnArgs: () => [],
  selectModel: { configId: "model" },
  modelVariants: true,
  normalizeSessionSelection: normalizeAntigravityTurn,
  // Google's server reads its new-session default from this variable when present; a later switch re-fetches models.
  sessionModelEnv: "AGY_ACP_DEFAULT_MODEL",
  sessionScopedApproval: true,
  backgroundWakes: true,
  retryUntouchedFailureOnce: true,
  describeFailure: describeAntigravityFailure,
  resumeMethod: "resume",
  clientFileSystem: true,
  sanitizeToolPayload: true,
  sanitizePromptText: neutralizeAntigravitySlashCommands,

  resolveCommand: async (env, config, instanceId) => {
    const runtime = await resolveAntigravityRuntime(config.cli, env);
    const profile = await prepareAntigravityProfile({ instanceId, runtime, baseEnv: env });
    if (profile.tempDirectory) scheduleAntigravityTempSweep(instanceId);
    return {
      command: runtime.executablePath,
      args: antigravityAcpArgs(profile.directory),
      env: profile.environment,
    };
  },

  resolveModels: async (env, config, instanceId) => {
    const runtime = await resolveAntigravityRuntime(config.cli, env);
    const profile = await prepareAntigravityProfile({ instanceId, runtime, baseEnv: env });
    if (!(await antigravityProfileAuthenticated(profile))) throw new Error(support.loginNote);
    return probeAntigravityModels({
      runtime,
      profile,
      fallbackDefault: STATIC_ANTIGRAVITY_MODELS.default,
    });
  },

  pickAuthMethod: (methods) => methods.some((method) => method.id === "oauth-personal")
    ? "oauth-personal"
    : null,
  authFailure: "fail",
  requireAuthenticationBeforeSpawn: true,
  classifyError: (error) => {
    const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
    const message = error instanceof Error ? error.message : String(error ?? "");
    // Antigravity CLI 1.5+ answers `authenticate` with -32603 "No browser is available here" when signed out without a display.
    if (code === -32000 || (code === -32603 && message.startsWith("No browser is available here"))) {
      return "invalid_credentials";
    }
    if (antigravityAccountIneligible(message)) return "quota_or_region_restriction";
    return undefined;
  },
  describeAccountError: (code) => code === "invalid_credentials" ? support.loginNote
    : code === "quota_or_region_restriction" ? ANTIGRAVITY_INELIGIBLE_ACCOUNT
      : undefined,
  isAuthenticated: async (env, config, instanceId) => {
    try {
      const runtime = await resolveAntigravityRuntime(config.cli, env);
      const profile = await prepareAntigravityProfile({ instanceId, runtime, baseEnv: env });
      return antigravityProfileAuthenticated(profile);
    } catch {
      return false;
    }
  },
  snapshot: async (env, config, instanceId): Promise<ProviderSnapshot> => {
    try {
      const runtime = await resolveAntigravityRuntime(config.cli, env);
      const profile = await prepareAntigravityProfile({ instanceId, runtime, baseEnv: env });
      return {
        state: "available",
        version: runtime.version,
        authenticated: await antigravityProfileAuthenticated(profile),
        account: await antigravityAccount(profile.tokenPath),
      };
    } catch (error) {
      return { state: "unavailable", reason: error instanceof Error ? error.message : String(error) };
    }
  },

  configureSession: async ({ request, sessionId, config, turn, configOptions }) => {
    if (!Array.isArray(configOptions) || !configOptions.some((option) => option?.id === "mode")) {
      return;
    }
    const offered = advertisedModeValues(configOptions);
    const wanted = antigravityPermissionMode(config.fullAuto, turn.approvalMode, offered);
    const result = await request("session/set_config_option", {
      sessionId,
      configId: "mode",
      value: wanted,
    });
    const mode = Array.isArray(result?.configOptions)
      ? result.configOptions.find((option: any) => option?.id === "mode")?.currentValue
      : undefined;
    if (mode !== wanted) throw new Error(`Antigravity did not apply ${wanted} permission mode.`);
  },
};

const AcpAntigravityDriver = createAcpDriver(support);

export const AntigravityDriver: ProviderDriver<AcpConfig> = {
  ...AcpAntigravityDriver,
  async create(input: DriverCreateInput<AcpConfig>): Promise<ProviderInstance> {
    const base = await AcpAntigravityDriver.create(input);
    scheduleAntigravityTempSweep(input.instanceId);
    scheduleAntigravityTempSweep(VERIFICATION_TEMP_KEY);
    let lastProfilePaths: { tokenPath: string; legacyTokenPath: string } | null = null;
    const auth = new AntigravityAuthController(() => {
      if (lastProfilePaths) clearAntigravityAccountCache(lastProfilePaths.tokenPath, lastProfilePaths.legacyTokenPath);
      void base.refreshModels?.();
    });
    let installFailure: string | undefined;
    let signingOut = false;
    const runtimeAndProfile = async () => {
      // A GUI launch's raw PATH may omit the official runtime the model picker found.
      const environment = { ...process.env, ...input.environment, PATH: augmentedPath() };
      const runtime = await resolveAntigravityRuntime(input.config.cli, environment);
      const profile = await prepareAntigravityProfile({
        instanceId: input.instanceId,
        runtime,
        baseEnv: environment,
      });
      lastProfilePaths = { tokenPath: profile.tokenPath, legacyTokenPath: profile.legacyTokenPath };
      return { runtime, profile };
    };
    return {
      ...base,
      authenticationMethod: "paste-code",
      get models() {
        return base.models;
      },
      get modelsUnconfirmed() {
        return base.modelsUnconfirmed;
      },
      snapshot: async () => {
        const snapshot = await base.snapshot();
        if (snapshot.state === "available") installFailure = undefined;
        return snapshot.state === "unavailable" && installFailure
          ? { ...snapshot, reason: installFailure }
          : snapshot;
      },
      ...(antigravityManagedInstallAvailable()
        ? {
            installRuntime: async (onProgress) => {
              installFailure = undefined;
              try {
                await installAntigravityRuntime({ validate: validateAntigravityRuntime, onProgress });
              } catch (error) {
                installFailure = error instanceof Error ? error.message : String(error);
                throw error;
              }
            },
          }
        : {}),
      startAuthentication: async () => {
        if (signingOut) {
          throw Object.assign(new Error("Antigravity sign-out is already in progress."), { status: 409 });
        }
        await base.adapter.stopAll();
        const { runtime, profile } = await runtimeAndProfile();
        return auth.start(runtime, profile);
      },
      completeAuthentication: async (flowId, response) => auth.complete(flowId, response),
      cancelAuthentication: async () => auth.cancelAndWait(),
      signOut: async () => {
        if (signingOut) {
          throw Object.assign(new Error("Antigravity sign-out is already in progress."), { status: 409 });
        }
        signingOut = true;
        try {
          await auth.cancelAndWait();
          await base.adapter.stopAll();
          const { runtime, profile } = await runtimeAndProfile();
          await logoutAntigravity(runtime, profile);
          clearAntigravityAccountCache(profile.tokenPath, profile.legacyTokenPath);
          base.resetModels?.();
        } finally {
          signingOut = false;
        }
      },
      dispose: async () => {
        await auth.cancelAndWait();
        await base.dispose();
      },
    };
  },
};
