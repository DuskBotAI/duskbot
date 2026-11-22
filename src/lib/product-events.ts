import { feature } from "./product-analytics";
import { track } from "@/lib/analytics";
import { noteNudgeMessage } from "@/lib/cloud-nudge";
import {
  allow, APP, BOT_SOURCE, BOT_TEMPLATE, CALL_MODE, CONNECTOR_RESULT, engineSlug, KEY_PROVIDER, KEY_RESULT, KEY_VIA, ROOM_MODE,
  SIGN_IN_ENGINE, SIGN_IN_METHOD,
  type BotSource, type ConnectorResult, type KeyProvider, type KeyResult, type KeyVia, type SignInMethod,
} from "@/lib/analytics-allowlist";
import { ACCOUNT_SIGN_IN_ERRORS, ACCOUNT_SIGN_IN_METHODS, type ACCOUNT_SIGN_IN_STEPS } from "../../shared/product-signals";

type Instances = ReadonlyArray<{ instanceId: string; driverKind: string }>;

const CHECKED_BEFORE_SAVE = new Set<string>(["composio", "elevenlabs", "fish_audio"]);

/** The server saves these keys only after their provider accepted them; every other key is unverified until tested. */
export function savedKeyResult(provider: KeyProvider | "other"): KeyResult {
  return CHECKED_BEFORE_SAVE.has(provider) ? "ok" : "unverified";
}

// Electron 43 rejects ipcRenderer.invoke with "Error invoking remote method '<channel>': " and the toString() of what main threw.
const IPC_KEY_REJECTED = /^Error invoking remote method '[^']*': KeyRejected: /;

export function keySaveFailure(cause: unknown): "rejected" | "error" {
  if ((cause as { body?: { code?: unknown } } | null | undefined)?.body?.code === "key_rejected") return "rejected";
  return cause instanceof Error && IPC_KEY_REJECTED.test(cause.message) ? "rejected" : "error";
}

/** `answer` is what POST /api/keys/test returned, or null when that request failed. */
export function keyTestResult(answer: { ok?: unknown; reason?: unknown } | null | undefined): KeyResult {
  if (answer?.ok === true) return "ok";
  return answer?.reason === "rejected" ? "rejected" : "unverified";
}

export function keySaved(provider: KeyProvider | "other", via: KeyVia, result: KeyResult): void {
  track("api_key_saved", { provider: allow(provider, KEY_PROVIDER), via: allow(via, KEY_VIA), result: allow(result, KEY_RESULT) });
}

export function keyRemoved(provider: KeyProvider | "other", via: KeyVia): void {
  track("api_key_removed", { provider: allow(provider, KEY_PROVIDER), via: allow(via, KEY_VIA) });
}

// a connect card's name as the engine it signs in to: ChatGPT is the codex engine, as its own sign-in panel records it
const TILE_ENGINE: Readonly<Record<string, (typeof SIGN_IN_ENGINE)[number]>> = { chatgpt: "codex", claude: "claude", grok: "grok", antigravity: "antigravity", cursor: "cursor", copilot: "copilot" };
export const tileSignInEngine = (tile: string | undefined): string => (tile && Object.hasOwn(TILE_ENGINE, tile) ? TILE_ENGINE[tile]! : "");

export function engineSignedIn(engine: string, method: SignInMethod): void {
  track("engine_signed_in", { engine: allow(engine, SIGN_IN_ENGINE), method: allow(method, SIGN_IN_METHOD) });
}

export function botCreated(source: BotSource, template?: string): void {
  feature("bot_created");
  track("bot_created", source === "template"
    ? { source, template: allow(template, BOT_TEMPLATE) }
    : { source: allow(source, BOT_SOURCE) });
}

export function connectorConnect(app: string, result: ConnectorResult): void {
  if (result === "connected") feature("app_connected");
  track("connector_connect", { app: allow(app, APP), result: allow(result, CONNECTOR_RESULT) });
}

export function directMessageSent(instances: Instances, instanceId: unknown, queued: boolean): void {
  noteNudgeMessage();
  track("message_sent", { driver: engineSlug(instances, instanceId), queued });
}

export function roomMessageSent(mode: string, queued: boolean): void {
  noteNudgeMessage();
  track("message_sent", { room: true, mode: allow(mode, ROOM_MODE), queued });
}

export function callStarted(instances: Instances, instanceId: unknown, mode: string): void {
  feature("call_started");
  track("call_started", { driver: engineSlug(instances, instanceId), mode: allow(mode, CALL_MODE) });
}

type AccountSignInStep = (typeof ACCOUNT_SIGN_IN_STEPS)[number];
export type AccountSignInMethod = (typeof ACCOUNT_SIGN_IN_METHODS)[number];
export type AccountSignInVia = "browser" | "code" | "link";

/** a step of the first run's account sign-in; an error is a fixed code ("wrong-code" -> "wrong_code"), never what was typed */
export function accountSignIn(step: AccountSignInStep, detail: { method?: AccountSignInMethod; via?: AccountSignInVia; problem?: string } = {}): void {
  const code = detail.problem === undefined ? undefined : detail.problem.replace(/-/g, "_");
  track("account_sign_in", {
    step,
    ...(detail.method && ACCOUNT_SIGN_IN_METHODS.includes(detail.method) ? { method: detail.method } : {}),
    ...(detail.via ? { via: detail.via } : {}),
    ...(code === undefined ? {} : { code: (ACCOUNT_SIGN_IN_ERRORS as readonly string[]).includes(code) ? code : "other" }),
  });
}
