// What the ACP driver keeps for each thread: its session on an agent process (alone or shared with other threads'
// sessions) and the turn running in it.
import type { ProviderErrorCode, RequestOutcome, SendTurnInput } from "../../contracts.ts";
import type { spawnCli } from "../../procs.ts";
import { errorReplyFailure, type ErrorReplyFailure } from "../engine-errors.ts";
import { decodeInjectId } from "../local-inject.ts";
import type { AcpHost, AcpLink } from "./host.ts";

/** Failures fixed on the provider account, not by retrying; the reporting process stays pooled. */
export type AccountErrorCode = Extract<ProviderErrorCode,
  "invalid_credentials" | "inactive_subscription" | "insufficient_funds" | "quota_or_region_restriction">;

const ACCOUNT_ERROR_CODES: ReadonlySet<ProviderErrorCode> = new Set<AccountErrorCode>([
  "invalid_credentials", "inactive_subscription", "insufficient_funds", "quota_or_region_restriction",
]);

export const isAccountError = (code: ProviderErrorCode | undefined): code is AccountErrorCode =>
  code !== undefined && ACCOUNT_ERROR_CODES.has(code);

export interface AcpConfig {
  cli: string;
  fullAuto: boolean;
  workspace?: string;
}

export function skipSubscriptionAuthForLocalInject(model: string | undefined): boolean {
  return Boolean(decodeInjectId(model));
}

export type AcpAskFinish = (
  behavior: string,
  source?: "user" | "timeout" | "system",
  message?: string,
  always?: boolean,
) => RequestOutcome;

export interface AcpTurn {
  turnId: string;
  turn: SendTurnInput;
  turnConfig: AcpConfig;
  controlsHost: boolean;
  state: {
    settled: boolean; promptSent: boolean; text: string; textMessageId: string | null; producedItem: boolean; repliedText: boolean; startupActivity: boolean; stopped: boolean;
    usagePeak: number | null;
    usageLast: number | null;
    usageCompacted: boolean;
    /** Stop went unanswered: only the cancel timeout settles the turn, once its session is closed or its process gone. */
    cancelling: boolean;
  };
  acknowledge: () => void;
  asks: Map<string, AcpAskFinish>;
  /** Tool calls started and not yet finished: a tool such as `sleep` sends nothing while it runs. */
  runningTools: Set<string>;
  unkeyedToolIds: string[];
  endedToolIds: Set<string>;
  /** Calls that only look something up (`read`, `search`): they have no live output, so their result ends them. */
  lookupTools: Set<string>;
  interruptTimer: ReturnType<typeof setTimeout> | null;
  stopQuietWatch: (() => void) | null;
  pushAssistantDelta: (delta: string) => string;
  flushAssistantText: () => void;
  receiveModelVariants: (result: any) => void;
}

export interface AcpSession {
  child: ReturnType<typeof spawnCli>;
  host: AcpHost;
  acp: AcpLink;
  launch: { command: string; args?: string[] };
  env: Record<string, string | undefined>;
  cwd: string;
  contractKey: string;
  /** mcpServers the native session was built with. They ride session/new and session/load, not argv,
   *  and bearer tokens rotate every turn, so a change re-establishes the session on the same child. */
  sessionKey: string | null;
  sessionId: string | null;
  sessionConfigResult: any;
  availableCommands: string[];
  initResult: any;
  authenticated: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  closing: boolean;
  /** Set when a shared process's session closes through `session/close`: true once the agent confirms it. */
  closeConfirmed?: Promise<boolean>;
  dead: boolean;
  readonly stderr: string;
  current: AcpTurn | null;
  fallbackNotice?: string;
  launchModel?: string;
}

/** Extracts command names from an ACP `available_commands_update` notification. */
export function availableCommandNames(update: unknown): string[] | null {
  if (!update || typeof update !== "object") return null;
  const record = update as { sessionUpdate?: unknown; availableCommands?: unknown };
  if (record.sessionUpdate !== "available_commands_update" || !Array.isArray(record.availableCommands)) return null;
  const names: string[] = [];
  for (const entry of record.availableCommands) {
    const raw = typeof (entry as { name?: unknown })?.name === "string"
      ? (entry as { name: string }).name.trim().replace(/^\/+/u, "")
      : "";
    if (raw) names.push(raw);
  }
  return names;
}

/** A `tool_call` without a status is pending (ACP's default); a `tool_call_update` without one leaves the call as it was. */
export function trackRunningTool(current: AcpTurn, update: { toolCallId?: unknown; status?: unknown }, defaultStatus?: "pending"): void {
  if (typeof update.toolCallId !== "string" || !update.toolCallId) return;
  const status = update.status ?? defaultStatus;
  if (status === "completed" || status === "failed") current.runningTools.delete(update.toolCallId);
  else if (status === "pending" || status === "in_progress") current.runningTools.add(update.toolCallId);
}

/**
 * A lookup's update that carries its result, though no terminal status: the call is done. Antigravity sends
 * `view_file`'s result at once but its status only when the step or the turn ends, so it would show running for minutes.
 */
export function lookupResultArrived(current: AcpTurn, update: { sessionUpdate?: unknown; toolCallId?: unknown; kind?: unknown; status?: unknown; rawOutput?: unknown; content?: unknown }): boolean {
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return false;
  if (typeof update.toolCallId !== "string" || !update.toolCallId) return false;
  if (update.kind === "read" || update.kind === "search") current.lookupTools.add(update.toolCallId);
  if (update.status === "completed" || update.status === "failed" || !current.lookupTools.has(update.toolCallId)) return false;
  return (update.rawOutput !== undefined && update.rawOutput !== null) || (Array.isArray(update.content) && update.content.length > 0);
}

export interface AcpTurnEnd {
  ok: boolean;
  stopReason: string | null;
  error?: Omit<ErrorReplyFailure, "stopReason">;
}

/** How a settling turn ends, once its last text is out. A Stop the agent answers with end_turn (OpenCode does) is the
 * person's stop. A reply that is only a provider's error body fails the turn in plain words. Otherwise `end_turn` with
 * nothing to show is a lost turn: a provider may cut a reasoning-only stream and still answer end_turn. */
export function endTurn(current: AcpTurn, ok: boolean, stopReason: string | null, ai: string): AcpTurnEnd {
  const ended = ok && stopReason === null;
  const errorReply = ended && !current.state.stopped && !current.state.repliedText ? errorReplyFailure(ai, current.state.text) : null;
  if (!errorReply) current.flushAssistantText();
  if (ended && current.state.stopped) return { ok, stopReason: "cancelled" };
  if (errorReply) {
    const { stopReason: failed, ...error } = errorReply;
    return { ok: false, stopReason: failed, error };
  }
  if (ended && !current.state.producedItem) return { ok: false, stopReason: "empty_turn", error: { message: `${ai} finished without replying.` } };
  return { ok, stopReason };
}
