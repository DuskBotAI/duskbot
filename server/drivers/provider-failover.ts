import type { RuntimeEvent } from "../contracts.ts";
import { failureOf } from "../../shared/usage-signals.ts";
import { classifyError } from "./retry.ts";

/** A model whose provider failed a turn before it did anything is skipped this long, unless a turn on it works first. */
export const PROVIDER_FAILURE_HOLD_MS = 10 * 60_000;

/** What another AI cannot fix: a usage limit (its own takeover), the person's Stop, a safety block. */
const NOT_FOR_BACKUP: ReadonlySet<string> = new Set(["quota", "interrupted", "provider_safety"]);
/** What a fresh conversation on another AI does not fix either: a chat too long, a refusal, a tool's own failure. */
const OWN_FIX: ReadonlySet<string> = new Set(["context", "refused", "tool"]);

/** The turn failed before it did anything, for a reason another AI the person chose can get past: an outage, overload,
 * rate limit, dropped connection or timeout after the engine's own retries, a model or key the provider refuses, a
 * request it turned down, or an error nobody could read. Never a usage limit, a Stop, a safety block, a chat too long,
 * a refusal or a tool's own failure. */
export function providerFailure(cause: string | undefined, stopReason?: string | null): boolean {
  if (!cause || stopReason === "tool_error" || stopReason === "provider_safety" || stopReason === "cancelled" || stopReason === "interrupted") return false;
  if (NOT_FOR_BACKUP.has(classifyError({ text: cause }).reason)) return false;
  return !OWN_FIX.has(failureOf(cause).reason);
}

/** Something the person could see or that may have changed something: words of the reply, a tool, an ask. */
export function turnActed(event: RuntimeEvent): boolean {
  switch (event.type) {
    case "content.delta":
      return event.streamKind === "assistant_text" && Boolean(event.delta);
    case "item.started":
      return event.itemType === "tool";
    case "item.completed":
      return (event.itemType === "assistant_text" && !event.synthetic && Boolean(event.text?.trim())) || event.itemType === "assistant_image" || event.itemType === "tool";
    case "request.opened":
      return true;
    default:
      return false;
  }
}

/** "Claude did not answer, so Codex took over." */
export function providerFailoverLine(from: string, to: string): string {
  return `${from} did not answer, so ${to} took over.`;
}

export function providerBackLine(engine: string): string {
  return `${engine} gets another try, so this conversation is back on ${engine}.`;
}
