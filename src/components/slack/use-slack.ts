import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/state/store";
import { ApiError } from "@/state/api";
import { t } from "@/lib/i18n";
import { completeSlackOAuth, useSlackOAuthResult } from "@/lib/slack-oauth-link";
import type { SlackOAuthResult } from "@/lib/slack-oauth-link";
import type { SlackBotState, SlackBotStatus, SlackProvisionResponse, SlackWorkspaceStatus } from "../../../shared/slack.ts";

const workspacePath = "/api/slack/workspace";
const oauthError = (error: string) => error === "failed" ? t("slack.error.generic") : error;
const botPath = (id: string) => `/api/slack/bots/${encodeURIComponent(id)}`;
const errorText = (cause: unknown): string => cause instanceof ApiError && typeof cause.body?.error === "string"
  ? cause.body.error : t("slack.error.generic");

function useSlackResource<T>(path: string) {
  const scope = useMemo(() => ({ active: true, reading: 0, busy: false }), [path]);
  const current = useRef(scope);
  current.current = scope;
  const [view, setView] = useState<{ scope: typeof scope; status: T | null; available: boolean; error: string | null; busy: boolean }>({ scope, status: null, available: true, error: null, busy: false });
  const valid = useCallback(() => scope.active && current.current === scope, [scope]);
  const patch = useCallback((next: Partial<Omit<typeof view, "scope">>) => {
    if (valid()) setView((old) => ({ ...(old.scope === scope ? old : { status: null, available: true, error: null, busy: false }), scope, ...next }));
  }, [scope, valid]);
  const reload = useCallback(async () => {
    const reading = ++scope.reading;
    try {
      const status = await api<T>(path, { background: true });
      if (reading === scope.reading) patch({ status, available: true, error: null });
    } catch (cause) {
      if (reading === scope.reading) patch(cause instanceof ApiError && cause.status === 404
        ? { available: false, status: null, error: null } : { error: errorText(cause) });
    }
  }, [path, scope, patch]);
  useEffect(() => {
    scope.active = true;
    void reload();
    return () => { scope.active = false; scope.reading += 1; };
  }, [reload, scope]);
  const perform = useCallback(async <R,>(request: () => Promise<R>, statusOf: (answer: R) => T): Promise<R | null> => {
    if (scope.busy || !valid()) return null;
    scope.busy = true;
    scope.reading += 1;
    patch({ busy: true, error: null });
    try {
      const answer = await request();
      if (!valid()) return null;
      scope.reading += 1;
      patch({ status: statusOf(answer), available: true });
      return answer;
    } catch (cause) {
      patch({ error: errorText(cause) });
      return null;
    } finally {
      scope.busy = false;
      patch({ busy: false });
    }
  }, [scope, valid, patch]);
  const shown = view.scope === scope ? view : { status: null, available: true, error: null, busy: false };
  return { ...shown, reload, perform, patch };
}

export function useSlackWorkspace() {
  const { status, available, error, busy, reload, perform } = useSlackResource<SlackWorkspaceStatus>(workspacePath);
  const connect = async (access: string, refresh: string): Promise<boolean> => Boolean(await perform(
    () => api<SlackWorkspaceStatus>(workspacePath, { method: "PUT", body: JSON.stringify({ accessToken: access.trim(), refreshToken: refresh.trim() }) }),
    (answer) => answer,
  ));
  const disconnect = async (): Promise<void> => { await perform(() => api<SlackWorkspaceStatus>(workspacePath, { method: "DELETE" }), (answer) => answer); };
  return { status, available, error, busy, connect, disconnect, reload };
}

export function useSlackBot(botId: string) {
  const path = botPath(botId);
  const { status: answer, available, error, busy, reload, perform, patch } = useSlackResource<SlackBotStatus>(path);
  const status = answer?.botId === botId ? answer : null;
  const [waitingFor, setWaitingFor] = useState<{ botId: string } | null>(null);
  const waiting = waitingFor?.botId === botId;
  const receive = useCallback((result: SlackOAuthResult) => {
    if (result.ok && result.status.botId !== botId) return;
    void reload().then(() => { if (!result.ok) patch({ error: oauthError(result.error) }); });
    if (!result.ok) patch({ error: oauthError(result.error) });
  }, [botId, reload, patch]);
  useSlackOAuthResult(receive);
  const poll = status?.state === "offline" || (status?.state === "provisioned" && waiting);
  useEffect(() => {
    if (!poll) return;
    const interval = window.setInterval(() => void reload(), 4000);
    const timeout = window.setTimeout(() => window.clearInterval(interval), 10 * 60 * 1000);
    return () => { window.clearInterval(interval); window.clearTimeout(timeout); };
  }, [poll, botId, reload, waitingFor]);
  const provision = async (): Promise<string | null> => {
    const response = await perform(() => api<SlackProvisionResponse>(`${path}/provision`, { method: "POST" }), (answer) => answer.status);
    if (!response) return null;
    setWaitingFor({ botId });
    return response.authorizeUrl;
  };
  const finishWithLink = async (link: string): Promise<boolean> => {
    const response = await perform(async () => {
      const result = await completeSlackOAuth(link);
      if (!result || !result.ok || result.status.botId !== botId) throw new ApiError("Slack OAuth failed", 400, { error: result && !result.ok ? oauthError(result.error) : t("slack.error.generic") });
      return result.status;
    }, (answer) => answer);
    return response !== null;
  };
  const setAppToken = async (token: string): Promise<boolean> => Boolean(await perform(
    () => api<{ status: SlackBotStatus }>(`${path}/app-token`, { method: "POST", body: JSON.stringify({ token: token.trim() }) }),
    (answer) => answer.status,
  ));
  const remove = async (): Promise<void> => { await perform(() => api<SlackBotStatus>(path, { method: "DELETE" }), (answer) => answer); };
  return { status, available, error, busy, provision, finishWithLink, setAppToken, remove, reload };
}

let availability: { value: boolean; expires: number } | null = null;
let availabilityRead: Promise<boolean> | null = null;

export function useSlackAvailable(): boolean {
  const [available, setAvailable] = useState(() => availability?.value ?? false);
  useEffect(() => {
    let active = true;
    if (availability && availability.expires > Date.now()) { setAvailable(availability.value); return; }
    availabilityRead ??= api<SlackWorkspaceStatus>(workspacePath, { background: true })
      .then(() => true, (cause: unknown) => !(cause instanceof ApiError && cause.status === 404))
      .then((value) => { availability = { value, expires: Date.now() + 60_000 }; availabilityRead = null; return value; });
    void availabilityRead.then((value) => { if (active) setAvailable(value); });
    return () => { active = false; };
  }, []);
  return available;
}

export function useSlackBotState(botId: string): SlackBotState | null {
  const { status } = useSlackResource<SlackBotStatus>(botPath(botId));
  return status?.botId === botId ? status.state : null;
}
