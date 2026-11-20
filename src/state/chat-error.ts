import { useEffect } from "react";
import { ApiError } from "./api";

export const CHAT_ERROR_CLEAR_MS = 6_000;

/** The server's answer to a Send with no AI on a team: news for the person, not a failure of theirs. */
export function isNoAiRefusal(error: unknown): error is ApiError {
  return error instanceof ApiError && error.body?.code === "no_ai";
}

/** The AI a no-AI refusal names: found on this computer, ready, and waiting for the person's Use it. */
export function refusalFoundAi(error: ApiError): { instanceId: string; name: string } | undefined {
  const found = error.body?.found as { instanceId?: unknown; name?: unknown } | undefined;
  return typeof found?.instanceId === "string" && typeof found.name === "string" ? { instanceId: found.instanceId, name: found.name } : undefined;
}

/** A no-AI refusal the person can fix here by connecting one (never a team member's, whose owner connects it). */
export function refusalConnects(error: ApiError): boolean {
  return error.body?.connect === true;
}

export function useChatErrorClear(error: string | null, clear: () => void): void {
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(clear, CHAT_ERROR_CLEAR_MS);
    return () => clearTimeout(timer);
  }, [error, clear]);
}
