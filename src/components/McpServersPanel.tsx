import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Art } from "./ui/Art";
import {
  CheckCircle2,
  FlaskConical,
  Globe,
  Loader2,
  LogIn,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  ServerCog,
  Trash2,
} from "../icons";

import { openExternalLink } from "@/lib/app-links";
import { cn } from "@/lib/cn";
import { activeLocale, t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { updateMcpServers } from "@/lib/mcp-servers";
import { completeMcpSignIn, mcpSignInLink, runMcpSignIn, type McpSignInStatus } from "@/lib/mcp-sign-in";
import { listenLiveFrames } from "@/lib/live-events";
import { api, useStore } from "@/state/store";

import { askConfirm } from "./ConfirmDialog";
import { McpAppsSwitch } from "./McpAppsSwitch";
import { SettingsRows, Switch } from "./SettingsPrimitives";
import { Card as RowsCard, ItemRow, NoteRow } from "./ListRows";
import { textFieldCls } from "./ui/GrokDialog";
import { ClaudeCodeSwitches } from "./ClaudeCodeSwitches";
import { HostedMcpIcon } from "./HostedMcpIcon";
import type { McpMessage } from "./McpResultBudgetField";
import { McpServerEditor, type McpServerSubmission } from "./McpServerEditor";
import { isRemoteMcpListing, type McpServerListing } from "./mcp-draft";
import { HOSTED_MCP_APPS, hostedConnections, hostedMcpApp, hostedServerName, type HostedApp, type HostedConnections, type HostedMcpAppId } from "@/lib/hosted-mcp-apps";
import { CHAT_TOOL_LIMIT, chatToolBudgetFit } from "../../shared/tool-budget";
import { openBotSettings } from "./bot-panel/panel-link";
import { closeConnectApps } from "./connect-apps/open";
import { KitActions, KitBody, KitButton, KitStatus, KitText } from "./connect-apps/detail-kit";
import { friendlyError } from "@/lib/plain-error";

export interface ProbeResult {
  ok: boolean;
  tools?: Array<{ name: string; description?: string }>;
  total?: number;
  error?: string;
  auth?: "required";
  /** `keys`: the server refused the headers it was sent; `unreachable` and `timeout` may pass on a second try. */
  reason?: "keys" | "unreachable" | "timeout";
  status?: number;
  /** This panel's own note: the test ran right after the server was saved, so a failure means it was saved but off. */
  saved?: boolean;
}

/** A passing test after a save switches the server on by itself. A click on its switch this soon after was aimed at the
 * Off the person saw, so it keeps the server on instead of switching it straight back off. */
export const SWITCH_SETTLE_MS = 1_500;

async function toolsCheck(
  name: string,
  request: (path: string, init?: RequestInit) => Promise<ProbeResult>,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  try {
    return await request(`/api/mcp/servers/${encodeURIComponent(name)}/test`, { method: "POST", signal });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    return { ok: false, error: friendlyError(cause), reason: "unreachable" };
  }
}

export async function signedInToolsCheck(
  name: string,
  request: (path: string, init?: RequestInit) => Promise<ProbeResult>,
  signal: AbortSignal,
  service: string,
): Promise<ProbeResult> {
  const tested = await toolsCheck(name, request, signal);
  if (tested.ok) return tested;
  const reason = (tested.error ?? "").trim();
  return { ...tested, error: t("hostedMcp.testFailed", { service, reason: reason && !/[.!?]$/.test(reason) ? `${reason}.` : reason }) };
}

/** Security: names the headers, never their values. */
function failureReason(server: McpServerListing, result: ProbeResult): string {
  if (result.reason !== "keys" || !isRemoteMcpListing(server)) return result.error ?? "";
  const reason = result.status ? `HTTP ${result.status}` : "unauthorized";
  if (!server.headerKeys.length) return t("mcp.check.keysNeeded", { reason });
  return t("mcp.check.keysRefused", { reason, names: new Intl.ListFormat(activeLocale(), { style: "long", type: "conjunction" }).format(server.headerKeys) });
}

/** The test's answer, with what the server's tool count alone does to an AI that takes a limited number of tools. */
export function connectedLabel(result: Pick<ProbeResult, "tools" | "total">): string {
  const count = Math.max(result.total ?? 0, result.tools?.length ?? 0);
  if (!count) return t("mcp.check.connectedNone");
  const connected = count === 1 ? t("mcp.check.connectedOne") : t("mcp.check.connectedMany", { count });
  const fit = chatToolBudgetFit(count);
  return fit === "fits" ? connected : `${connected}. ${t(fit === "exceeds" ? "mcp.check.overLimit" : "mcp.check.crowdsLimit", { count, limit: CHAT_TOOL_LIMIT })}`;
}

export interface HostedCardsProps {
  /** Whether this app's card shows now (search, filter, category view). A hidden card stays mounted. */
  shown(id: HostedMcpAppId): boolean;
  onConnections(connected: HostedConnections): void;
}

/** `hostedCards`: render the one-click card of each hosted MCP app (one instance, one server load, one sign-in at a time)
 * instead of the server list. `hideHosted`: leave hosted apps' servers out of the list, since their cards show them. */
export function McpServersPanel({ embedded = false, rows = false, hostedCards, hideHosted = false, refreshKey = 0 }: {
  embedded?: boolean;
  /** Settings: Grok's card of rows, each server one row with its pills and switch. */
  rows?: boolean;
  hostedCards?: HostedCardsProps;
  hideHosted?: boolean;
  refreshKey?: number;
} = {}) {
  const { state: store, dispatch } = useStore();
  const botName = (id: string) => store.bots?.find((bot) => bot.id === id)?.name ?? id;
  const policy = store.config?.managedPolicy;
  const restricted = Boolean(policy && !policy.mcp.allowCustom);
  const [servers, setServers] = useState<McpServerListing[] | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | McpMessage | null>(null);
  const [notice, setNotice] = useState<(McpMessage & { stateKey?: LocaleKey }) | null>(null);
  const [probe, setProbe] = useState<Record<string, ProbeResult>>({});
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const signInAbort = useRef<AbortController | null>(null);
  const signInComplete = useRef<((result: McpSignInStatus) => void) | null>(null);
  const [signInFlow, setSignInFlow] = useState<McpSignInStatus | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [callbackError, setCallbackError] = useState<string | null>(null);
  const [completingSignIn, setCompletingSignIn] = useState(false);
  const [fixingKeys, setFixingKeys] = useState(false);
  /** Each server a passing test just switched on, and when. */
  const switchedOn = useRef<Record<string, number>>({});
  const tests = useRef(new Map<string, { controller: AbortController; switchesOn: boolean }>());
  /** The servers being tested, each with whether a pass switches it on. */
  const [testing, setTesting] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  /** A failed card action belongs to that card alone: the cards share one instance, and `error` shows on every one. */
  const [cardFailure, setCardFailure] = useState<{ id: HostedMcpAppId; message: string } | null>(null);
  const loadGeneration = useRef(0);
  const mounted = useRef(true);
  const hostedOf = (server: McpServerListing) => isRemoteMcpListing(server) ? hostedMcpApp(server) : undefined;
  const connections = useMemo(() => servers && hostedConnections(servers), [servers]);
  const onConnections = hostedCards?.onConnections;
  useEffect(() => { if (connections) onConnections?.(connections); }, [connections, onConnections]);

  const listed = (next: McpServerListing[] | undefined) => {
    setServers(next ?? []);
    updateMcpServers(next ?? []);
    return next ?? [];
  };
  const forgetProbe = (name: string) => setProbe((current) => {
    const next = { ...current };
    delete next[name];
    return next;
  });

  const load = useCallback(() => {
    const generation = ++loadGeneration.current;
    setBusy("load");
    setError(null);
    return api("/api/mcp/servers")
      .then((result) => {
        if (generation === loadGeneration.current) {
          setServers(result.servers ?? []);
          updateMcpServers(result.servers ?? []);
        }
      })
      .catch((cause) => {
        if (generation === loadGeneration.current) setError(friendlyError(cause));
      })
      .finally(() => {
        if (generation === loadGeneration.current) setBusy(null);
      });
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; loadGeneration.current += 1; };
  }, [load, refreshKey]);

  const busyNow = useRef<string | null>(null);
  busyNow.current = busy;
  useEffect(() => {
    const refresh = () => {
      if (busyNow.current !== null) return;
      const generation = loadGeneration.current;
      void api("/api/mcp/servers").then((result) => {
        if (!mounted.current || busyNow.current !== null || generation !== loadGeneration.current) return;
        setServers(result.servers ?? []);
        updateMcpServers(result.servers ?? []);
      }).catch(() => {});
    };
    return listenLiveFrames({
      onFrame: (frame) => { if (frame.kind === "mcp.changed") refresh(); },
      onMissedFrames: refresh,
    });
  }, []);

  const closeEditor = () => { setEditing(null); setFixingKeys(false); };
  const openEditor = (name: string | "new", keys = false) => {
    setEditing(name);
    setFixingKeys(keys);
    setError(null);
    setNotice(null);
  };

  const syncTesting = () => setTesting(new Map([...tests.current].map(([name, test]) => [name, test.switchesOn])));
  /** Runs one server's test, holding only that server's row; null when it was cancelled or the panel closed. */
  const runTest = async (name: string, switchesOn: boolean, work: (signal: AbortSignal) => Promise<ProbeResult>): Promise<ProbeResult | null> => {
    tests.current.get(name)?.controller.abort();
    const controller = new AbortController();
    tests.current.set(name, { controller, switchesOn });
    syncTesting();
    loadGeneration.current += 1;
    setError(null);
    forgetProbe(name);
    try {
      const result = await work(controller.signal);
      return controller.signal.aborted || !mounted.current ? null : result;
    } catch (cause) {
      if (controller.signal.aborted) return null;
      throw cause;
    } finally {
      if (tests.current.get(name)?.controller === controller) {
        tests.current.delete(name);
        if (mounted.current) syncTesting();
      }
    }
  };
  const cancelTest = (name: string) => tests.current.get(name)?.controller.abort();
  useEffect(() => () => { for (const test of tests.current.values()) test.controller.abort(); }, []);

  /** Tests a server and turns it on when it answers; what it said stays on its row. `saved`: it was just saved. */
  const connect = async (name: string, saved = false): Promise<ProbeResult | null> => {
    let result = await runTest(name, true, async (signal) => {
      const tested = await toolsCheck(name, api, signal);
      if (!tested.ok) return tested;
      try {
        listed((await api(`/api/mcp/servers/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify({ enabled: true }), signal })).servers);
        switchedOn.current[name] = Date.now();
        return tested;
      } catch (cause) {
        if (signal.aborted) throw cause;
        return { ok: false, error: friendlyError(cause) };
      }
    });
    if (!result) return null;
    if (saved) result = { ...result, saved: true };
    const settled = result;
    setProbe((current) => ({ ...current, [name]: settled }));
    return result;
  };

  const addServers = async (items: McpServerSubmission[]) => {
    setBusy("save");
    loadGeneration.current += 1;
    setError(null);
    setNotice(null);
    const added: string[] = [];
    let latest = servers ?? [];
    try {
      for (const item of items) {
        const body = item.ownKey
          ? { ...item.body, headers: Object.fromEntries(Object.keys(item.body.headers ?? {}).map((name) => [name, ""])) }
          : item.body;
        latest = listed((await api("/api/mcp/servers", { method: "POST", body: JSON.stringify({ name: item.name, ...body }) })).servers);
        if (item.ownKey) {
          await api("/api/team/connection-scopes", { method: "PUT", body: JSON.stringify({ kind: "mcp", id: item.name, scope: "person" }) });
          await api(`/api/team/my-connections/mcp/${encodeURIComponent(item.name)}/key`, { method: "PUT", body: JSON.stringify({ value: item.ownKey, url: body.url }) });
          latest = listed((await api(`/api/mcp/servers/${encodeURIComponent(item.name)}`, {
            method: "PUT", body: JSON.stringify({ ...body, enabled: false }),
          })).servers);
        }
        added.push(item.name);
      }
    } catch (cause) {
      setError(friendlyError(cause));
    }
    setBusy(null);
    if (added.length) closeEditor();
    for (const name of added) {
      const result = await connect(name, true);
      const server = latest.find((each) => each.name === name);
      if (result?.auth === "required" && server && added.length === 1 && mounted.current) await signIn(server);
    }
  };

  const saveEdit = async ([item]: McpServerSubmission[]) => {
    const existing = servers?.find((server) => server.name === editing);
    if (!item || !existing) return;
    setBusy("save");
    loadGeneration.current += 1;
    setError(null);
    setNotice(null);
    try {
      let body = item.body;
      let ownKey: string | undefined;
      if (store.config?.team && existing.scope !== "team" && typeof body.url === "string" && !body.oauth) {
        const connections = await api("/api/team/my-connections");
        if (connections.mcp.some((connection: { name: string }) => connection.name === item.name)) {
          const headers = (body.headers ?? {}) as Record<string, string | true>;
          if (Object.keys(headers).length > 1) {
            throw new Error("Personal MCP connections support one header. Remove the extra headers before saving.");
          }
          const value = Object.values(headers)[0];
          ownKey = typeof value === "string" ? value : undefined;
          body = { ...body, headers: Object.fromEntries(Object.keys(headers).map((name) => [name, ""])) };
        }
      }
      listed((await api(`/api/mcp/servers/${encodeURIComponent(item.name)}`, { method: "PUT", body: JSON.stringify({ ...body, enabled: existing.enabled }) })).servers);
      if (ownKey) await api(`/api/team/my-connections/mcp/${encodeURIComponent(item.name)}/key`, { method: "PUT", body: JSON.stringify({ value: ownKey, url: body.url }) });
      closeEditor();
    } catch (cause) {
      setError(friendlyError(cause));
      setBusy(null);
      return;
    }
    setBusy(null);
    if (!existing.runsOn) await connect(item.name, true);
  };

  const toggle = async (server: McpServerListing) => {
    if (server.enabled && Date.now() - (switchedOn.current[server.name] ?? 0) < SWITCH_SETTLE_MS) {
      setNotice({ key: "mcp.switchedOnByTest", params: { name: server.name } });
      return;
    }
    setBusy(`toggle:${server.name}`);
    loadGeneration.current += 1;
    setError(null);
    try {
      listed((await api(`/api/mcp/servers/${server.name}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !server.enabled }),
      })).servers);
      setNotice({
        key: "mcp.toggled",
        params: { name: server.name },
        stateKey: server.enabled ? "mcp.state.off" : "mcp.state.on",
      });
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(null);
    }
  };

  const test = async (server: McpServerListing) => {
    const result = await runTest(server.name, false, (signal) => toolsCheck(server.name, api, signal));
    if (result) setProbe((current) => ({ ...current, [server.name]: result }));
  };

  async function signIn(server: McpServerListing) {
    const controller = new AbortController();
    signInAbort.current = controller;
    setSigningIn(server.name);
    setSignInFlow(null);
    setCallbackUrl("");
    setCallbackError(null);
    setError(null);
    setCardFailure(null);
    setNotice(null);
    forgetProbe(server.name);
    const hosted = hostedOf(server);
    try {
      const result = await runMcpSignIn(server.name, { api, open: openExternalLink, signal: controller.signal, onStarted: (status, complete) => {
        setSignInFlow(status);
        signInComplete.current = complete;
      } });
      if (!mounted.current || controller.signal.aborted) return;
      if (result.phase === "succeeded") {
        setSignInFlow({ ...result, flowId: null, authorizationUrl: null });
        const tested = hosted ? await signedInToolsCheck(server.name, api, controller.signal, hosted.label) : await toolsCheck(server.name, api, controller.signal);
        if (controller.signal.aborted || !mounted.current) return;
        setProbe((current) => ({ ...current, [server.name]: tested }));
        if (!tested.ok) return;
        const enabled = await api(`/api/mcp/servers/${server.name}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) });
        if (!mounted.current) return;
        listed(enabled.servers);
        if (hosted) setNotice({ key: "hostedMcp.connected", params: { service: hosted.label } });
      } else if (result.phase !== "cancelled") {
        setProbe((current) => ({ ...current, [server.name]: { ok: false, error: result.message || t("mcp.auth.failed") } }));
      }
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) setProbe((current) => ({ ...current, [server.name]: { ok: false, error: friendlyError(cause) } }));
    } finally {
      if (signInAbort.current === controller) {
        signInAbort.current = null;
        signInComplete.current = null;
        setCompletingSignIn(false);
        setSigningIn(null);
        setSignInFlow(null);
        setCallbackUrl("");
        setCallbackError(null);
        if (mounted.current) void load();
      }
    }
  }

  const connectHosted = async (app: HostedApp) => {
    if (!servers || busy !== null || signingIn !== null) return;
    const existing = servers.find((server) => hostedOf(server) === app);
    if (existing) { await signIn(existing); return; }
    setBusy(`hosted:${app.id}`);
    loadGeneration.current += 1;
    setError(null);
    setCardFailure(null);
    setNotice(null);
    let added: McpServerListing | undefined;
    try {
      const name = hostedServerName(app, servers);
      const result = await api("/api/mcp/servers", { method: "POST", body: JSON.stringify({ name, type: "http", url: app.url, enabled: false }) });
      if (!mounted.current) return;
      added = listed(result.servers).find((server: McpServerListing) => server.name === name && hostedOf(server) === app);
      if (!added) throw new Error(t("hostedMcp.setupFailed", { service: app.label }));
    } catch (cause) {
      if (mounted.current) setCardFailure({ id: app.id, message: friendlyError(cause) });
    } finally { if (mounted.current) setBusy(null); }
    if (added && mounted.current) await signIn(added);
  };

  const completeSignIn = async () => {
    if (!signingIn || !signInFlow?.flowId || completingSignIn) return;
    const controller = signInAbort.current;
    setCompletingSignIn(true);
    setCallbackError(null);
    try {
      const result = await completeMcpSignIn(signingIn, signInFlow.flowId, callbackUrl, api);
      if (signInAbort.current === controller) signInComplete.current?.(result);
    } catch (cause) {
      if (signInAbort.current === controller) setCallbackError(friendlyError(cause));
    } finally {
      if (signInAbort.current === controller) setCompletingSignIn(false);
    }
  };

  const signOut = async (server: McpServerListing, card?: HostedApp) => {
    setBusy(`signout:${server.name}`);
    loadGeneration.current += 1;
    setError(null);
    setCardFailure(null);
    setNotice(null);
    forgetProbe(server.name);
    try {
      if (hostedOf(server)) {
        listed((await api(`/api/mcp/servers/${server.name}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) })).servers);
      }
      listed((await api(`/api/mcp/servers/${server.name}/sign-out`, { method: "POST" })).servers);
    } catch (cause) {
      const message = friendlyError(cause);
      if (card) setCardFailure({ id: card.id, message }); else setError(message);
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => () => signInAbort.current?.abort(), []);

  const remove = async (server: McpServerListing) => {
    if (!(await askConfirm({ title: t("confirm.mcpRemoveTitle", { name: server.name }), body: t("confirm.mcpRemoveBody"), confirmLabel: t("confirm.remove") }))) return;
    setBusy(`delete:${server.name}`);
    loadGeneration.current += 1;
    setError(null);
    try {
      listed((await api(`/api/mcp/servers/${server.name}`, { method: "DELETE" })).servers);
      forgetProbe(server.name);
      if (editing === server.name) closeEditor();
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(null);
    }
  };

  const editingServer = editing && editing !== "new" ? servers?.find((server) => server.name === editing) : undefined;

  function renderPasteBack(server: McpServerListing) {
    return (
      <>
        <label className="mt-3 block" htmlFor={`mcp-callback-${server.name}`}>{t("mcp.auth.callbackUrl")}</label>
        <input id={`mcp-callback-${server.name}`} type="text" value={callbackUrl} disabled={completingSignIn} onChange={(event) => setCallbackUrl(event.target.value)}
          autoComplete="off" spellCheck={false} placeholder="http://127.0.0.1:…/mcp-oauth/callback?…"
          className={cn(textFieldCls, "mt-1")} />
        <button type="button" disabled={!callbackUrl.trim() || completingSignIn} aria-busy={completingSignIn} onClick={() => void completeSignIn()}
          className="ui-button ui-button-primary mt-2">
          {completingSignIn && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
          {t(completingSignIn ? "mcp.auth.completing" : "mcp.auth.complete")}
        </button>
      </>
    );
  }

  function renderSignIn(server: McpServerListing) {
    const hosted = hostedOf(server);
    return signingIn === server.name && (
      <div className={cn("space-y-2 text-[12px] leading-4 text-ink-secondary", rows ? "px-2 pb-1.5" : "mt-3")}>
        <div role="status" className="flex items-center gap-2">
          <Loader2 size={13} className="animate-spin" /> {signInFlow?.phase !== "succeeded" ? t("mcp.auth.waiting") : hosted ? t("hostedMcp.loadingTools", { service: hosted.label }) : t("mcp.auth.loadingTools")}
        </div>
        {signInFlow?.authorizationUrl && mcpSignInLink(signInFlow.authorizationUrl) && (
          <button type="button" onClick={() => void openExternalLink(signInFlow.authorizationUrl!).catch(() => setCallbackError(t("mcp.auth.openFailed")))} className="text-accent hover:underline">
            {t("mcp.auth.openAgain")}
          </button>
        )}
        {signInFlow?.flowId && (signInFlow.pasteBack
          ? <div>
              <p className="leading-relaxed text-ink">{t("mcp.auth.pasteBackHint")}</p>
              {renderPasteBack(server)}
            </div>
          : <details>
              <summary className="cursor-pointer font-medium text-ink">{t("mcp.auth.otherComputer")}</summary>
              <p className="mt-2 leading-relaxed">{t("mcp.auth.otherComputerHint")}</p>
              {renderPasteBack(server)}
            </details>)}
        {callbackError && <p role="alert" className="text-danger">{callbackError}</p>}
      </div>
    );
  }

  function renderHostedCard(app: HostedApp) {
    const server = servers?.find((listed) => hostedOf(listed) === app);
    const connected = Boolean(connections?.[app.id]);
    const result = server && probe[server.name];
    const failed = error || (cardFailure?.id === app.id ? cardFailure.message : null) || (result && !result.ok ? result.error : null);
    const pending = busy !== null || signingIn !== null;
    const mine = busy === `hosted:${app.id}` || (server !== undefined && (signingIn === server.name || busy === `signout:${server.name}`));
    const disabled = pending || (servers !== null && !connected && (Boolean(server?.managedBy) || (restricted && !policy?.mcp.allowlist.length)));
    return <KitBody data-app-tile={app.id}>
      <KitText>{t(app.notice)}</KitText>
      {connected && <KitStatus tone="ok">{t("apps.connected")}</KitStatus>}
      <KitActions>
        {server && signingIn === server.name
          ? <KitButton variant="secondary" onClick={() => signInAbort.current?.abort()}>{t("mcp.auth.cancel")}</KitButton>
          : <KitButton variant={connected ? "secondary" : "primary"} tone={connected ? "danger" : undefined} disabled={disabled}
            aria-label={t(connected ? "hostedMcp.disconnect" : "hostedMcp.connect", { service: app.label })}
            onClick={() => void (servers === null ? load() : connected && server ? signOut(server, app) : connectHosted(app))}>
            {pending && (mine || busy === "load") ? t("connectApps.connecting") : servers === null ? t("connectors.action.retry") : t(connected ? "connectors.disconnect" : "connectors.action.connect")}
          </KitButton>}
      </KitActions>
      {failed && <KitStatus tone="danger">{typeof failed === "string" ? failed : t(failed.key, failed.params)}</KitStatus>}
      {server && renderSignIn(server)}
      <div data-hosted-access="" className="ca-kit">
        <h3 className="ca-group-label" style={{ paddingInline: 0 }}>{t("hostedMcp.access")}</h3>
        <KitText>{t("hostedMcp.accessHint")}</KitText>
        <KitActions>{(store.bots ?? []).filter((bot) => !bot.hidden).map((bot) => (
          <KitButton key={bot.id} variant="secondary" onClick={() => { closeConnectApps(); openBotSettings(dispatch, "access", { botId: bot.id, page: "mcp" }); }}>{t("hostedMcp.botSettings", { name: bot.name })}</KitButton>
        ))}</KitActions>
      </div>
    </KitBody>;
  }

  if (hostedCards) {
    return <>{HOSTED_MCP_APPS.map((app) => <div key={app.id} className={hostedCards.shown(app.id) ? "contents" : "hidden"}>{renderHostedCard(app)}</div>)}</>;
  }

  const visibleServers = servers?.filter((server) => !hideHosted || !isRemoteMcpListing(server) || !hostedMcpApp(server));

  if (rows) {
    // one quiet line under a server's row
    const line = "px-2 pb-1.5 text-[12px] leading-4";
    const iconCls = "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-ink-secondary hover:bg-ink/[0.035] hover:text-ink outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus disabled:opacity-45";
    return (
      <section data-mcp-servers aria-labelledby="mcp-servers-title" className="flex flex-col gap-5">
        <RowsCard label={<span id="mcp-servers-title">{t("mcp.title")}</span>}
          footnote={restricted && policy ? <span role="status">{t("policy.mcpRestricted", { organization: policy.organizationName })}</span> : undefined}>
          <ItemRow title={t("settings.hint.mcp")} hint={servers === null ? t("mcp.loading") : visibleServers?.length === 0 ? t("mcp.empty.title") : undefined}>
            <button type="button" onClick={() => void load()} disabled={busy !== null} className={iconCls} aria-label={t("mcp.refreshAria")} title={t("mcp.refreshAria")}>
              <RefreshCw size={13} aria-hidden="true" />
            </button>
            <button type="button" className="ui-button"
              disabled={busy !== null || (restricted && !policy?.mcp.allowlist.length)}
              title={restricted && policy ? t("policy.managedBy", { organization: policy.organizationName }) : undefined}
              onClick={() => openEditor("new")}>
              {t("apps.mcp.add")}
            </button>
          </ItemRow>
          {visibleServers?.map((server) => {
            const hosted = hostedOf(server);
            const result = probe[server.name];
            const auth = isRemoteMcpListing(server) ? server.auth : undefined;
            const canSignIn = isRemoteMcpListing(server) && !server.runsOn
              && (auth === "needs-sign-in" || result?.auth === "required" || ((Boolean(hosted) || Boolean(server.oauth)) && auth !== "signed-in"));
            const where = server.runsOn ? t("mcp.runsOn", { computer: server.runsOn.label })
              : server.managedBy ? t("policy.mcpBlocked", { organization: server.managedBy })
                : isRemoteMcpListing(server) ? server.url : [server.command, ...server.args].join(" ");
            const underTest = testing.has(server.name);
            const locked = busy !== null || signingIn !== null || underTest;
            return (
              <div key={server.name} data-hosted-server={hosted?.id} className="contents">
                <ItemRow data-panel-row={`mcp:${server.name}`}
                  title={<>{hosted ? hosted.label : server.name}{auth && <span className="text-ink-secondary"> · {t(auth === "signed-in" ? "mcp.auth.signedIn" : "mcp.auth.needsSignIn")}</span>}</>}
                  hint={<span className="block truncate">{where}</span>}>
                  {signingIn === server.name ? (
                    <button type="button" onClick={() => signInAbort.current?.abort()} className="ui-button">{t("mcp.auth.cancel")}</button>
                  ) : canSignIn ? (
                    <button type="button" disabled={locked || Boolean(server.managedBy)} onClick={() => void signIn(server)} className="ui-button">
                      {hosted ? t("hostedMcp.connect", { service: hosted.label }) : t("mcp.auth.signIn")}
                    </button>
                  ) : auth === "signed-in" ? (
                    <button type="button" disabled={locked} onClick={() => void signOut(server)} className="ui-button">
                      {hosted ? t("hostedMcp.disconnect", { service: hosted.label }) : t("mcp.auth.signOut")}
                    </button>
                  ) : null}
                  {underTest
                    ? <button type="button" onClick={() => cancelTest(server.name)} className="ui-button">{t("common.cancel")}</button>
                    : <button type="button" disabled={locked} onClick={() => void test(server)} className="ui-button">{t("mcp.test")}</button>}
                  <button type="button" disabled={locked} onClick={() => openEditor(server.name)} className="ui-button" aria-label={t("mcp.editAria", { name: server.name })}>{t("settings.w6.mcp.edit")}</button>
                  <button type="button" disabled={locked} onClick={() => void remove(server)} className={iconCls} aria-label={t("mcp.removeAria", { name: server.name })} title={t("mcp.removeAria", { name: server.name })}>
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                  <Switch
                    checked={server.enabled}
                    disabled={locked}
                    onClick={() => void toggle(server)}
                    aria-label={t("mcp.toggleAria", { name: server.name, state: t(server.enabled ? "mcp.state.off" : "mcp.state.on") })}
                  />
                </ItemRow>
                <McpAppsSwitch<McpServerListing> server={server} disabled={locked} onSaved={(next) => { loadGeneration.current += 1; listed(next); }} />{renderSignIn(server)}
                {underTest && (
                  <div role="status" data-mcp-testing className={cn(line, "text-ink-secondary")}>{t(testing.get(server.name) && !server.enabled ? "mcp.check.testingOff" : "common.checking")}</div>
                )}
                {result && signingIn !== server.name && (
                  <div role="status" className={cn(line, "flex flex-wrap items-center gap-2", result.ok ? "text-ink-secondary" : "text-danger")}>
                    {result.auth === "required" ? t("mcp.auth.required") : result.ok ? connectedLabel(result) : (
                      <>
                        <span className="min-w-0 flex-1">{t(server.enabled ? "mcp.check.failed" : result.saved ? "mcp.check.savedOff" : "mcp.check.failedOff", { reason: failureReason(server, result) })}</span>
                        {(result.reason === "keys" && isRemoteMcpListing(server)) || result.reason === "unreachable" || result.reason === "timeout" ? (
                          <button type="button" disabled={locked} className="ui-button"
                            onClick={() => result.reason === "keys" ? openEditor(server.name, true) : void connect(server.name)}>
                            {t(result.reason === "keys" ? "mcp.check.fixKeys" : "mcp.check.tryAgain")}
                          </button>
                        ) : null}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {error && <NoteRow tone="danger">{typeof error === "string" ? error : t(error.key, error.params)}</NoteRow>}
          {notice && <NoteRow><span role="status">{t(notice.key, { ...notice.params, ...(notice.stateKey ? { state: t(notice.stateKey) } : {}) })}</span></NoteRow>}
        </RowsCard>
        {(editing === "new" || editingServer) && (
          <McpServerEditor key={`${editing}${fixingKeys ? ":keys" : ""}`} server={editingServer} fixKeys={fixingKeys} taken={(servers ?? []).map((server) => server.name)} team={Boolean(store.config?.team)}
            busy={busy !== null} onCancel={closeEditor} onSubmit={(items) => void (editing === "new" ? addServers(items) : saveEdit(items))} />
        )}
        <SettingsRows><ClaudeCodeSwitches /></SettingsRows>
      </section>
    );
  }

  return (
    <section
      data-mcp-servers
      aria-labelledby="mcp-servers-title"
      className={embedded ? "" : "min-h-0 flex-1 overflow-y-auto px-6 pb-7 pt-5 sm:px-8"}
    >
      <div className={embedded ? "" : "mx-auto max-w-[840px]"}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-[1_1_280px]">
            <h3 id="mcp-servers-title" className="text-[15px] font-semibold text-ink in-data-[settings-look=simple]:sr-only in-data-[connect-apps]:sr-only">{t("mcp.title")}</h3>
            <p className="mt-1 max-w-[610px] break-words text-[13px] leading-relaxed text-ink-secondary in-data-[settings-look=simple]:hidden in-data-[connect-apps]:mt-0 in-data-[connect-apps]:leading-[18px] in-data-[connect-apps]:text-ink/[0.68]">
              {t("mcp.subtitle")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void load()}
              disabled={busy !== null}
              className="rounded-lg p-2 text-ink-secondary transition-colors hover:bg-raised hover:text-ink in-data-[connect-apps]:rounded-full in-data-[connect-apps]:hover:bg-ink/[0.035] disabled:opacity-40 in-data-[connect-apps]:rounded-full in-data-[connect-apps]:p-1.5 in-data-[connect-apps]:transition-none in-data-[connect-apps]:hover:bg-ink/[0.035]"
              aria-label={t("mcp.refreshAria")}
            >
              <RefreshCw size={16} className={cn(busy === "load" && "animate-spin")} />
            </button>
            <button
              type="button"
              disabled={busy !== null || (restricted && !policy?.mcp.allowlist.length)}
              title={restricted && policy ? t("policy.managedBy", { organization: policy.organizationName }) : undefined}
              onClick={() => openEditor("new")}
              className="flex items-center gap-1.5 rounded-lg bg-ink px-3 py-2 text-[13px] font-medium text-app disabled:opacity-40 in-data-[connect-apps]:h-8 in-data-[connect-apps]:gap-1 in-data-[connect-apps]:rounded-full in-data-[connect-apps]:bg-ink in-data-[connect-apps]:py-0 in-data-[connect-apps]:text-[14px] in-data-[connect-apps]:font-normal in-data-[connect-apps]:text-app in-data-[connect-apps]:enabled:hover:bg-ink/[0.885]"
            >
              <Plus size={14} /> {t(embedded ? "apps.mcp.add" : "mcp.addServer")}
            </button>
          </div>
        </div>

        {restricted && policy && <p role="status" className="mt-3 text-[13px] leading-relaxed text-ink-secondary">{t("policy.mcpRestricted", { organization: policy.organizationName })}</p>}
        {(editing === "new" || editingServer) && (
          <McpServerEditor key={`${editing}${fixingKeys ? ":keys" : ""}`} server={editingServer} fixKeys={fixingKeys} taken={(servers ?? []).map((server) => server.name)} team={Boolean(store.config?.team)}
            busy={busy !== null} onCancel={closeEditor} onSubmit={(items) => void (editing === "new" ? addServers(items) : saveEdit(items))} />
        )}
        {error && <div role="alert" className="mt-3 text-[12px] text-danger">{typeof error === "string" ? error : t(error.key, error.params)}</div>}
        {notice && <div role="status" className="mt-3 text-[12px] text-success">{t(notice.key, {
          ...notice.params,
          ...(notice.stateKey ? { state: t(notice.stateKey) } : {}),
        })}</div>}
        <ClaudeCodeSwitches />

        <div className="mt-4 px-0.5 text-[12px] leading-relaxed text-ink-secondary in-data-[settings-look=simple]:hidden in-data-[connect-apps]:rounded-[14px] in-data-[connect-apps]:border-transparent in-data-[connect-apps]:bg-transparent in-data-[connect-apps]:px-0 in-data-[connect-apps]:py-2.5 in-data-[connect-apps]:leading-4 in-data-[connect-apps]:text-ink/[0.68]">
          {t("mcp.trustNotice")}
        </div>

        {servers === null ? (
          <div className="flex items-center justify-center gap-2 py-24 text-[13px] text-ink-secondary"><Loader2 size={14} className="animate-spin" /> {t("mcp.loading")}</div>
        ) : visibleServers?.length === 0 && !editing ? (
          <div className="mt-5 flex min-h-32 flex-col items-center justify-center rounded-2xl border border-dashed border-transparent text-center in-data-[settings-look=simple]:mt-3 in-data-[settings-look=simple]:min-h-16 in-data-[settings-look=simple]:rounded-[14px] in-data-[connect-apps]:mt-3 in-data-[connect-apps]:min-h-0 in-data-[connect-apps]:items-start in-data-[connect-apps]:border-0 in-data-[connect-apps]:px-0 in-data-[connect-apps]:text-start">
            <Art name="plug" size="lg" className="in-data-[connect-apps]:hidden" />
            <div className="mt-3 text-[14px] font-medium text-ink in-data-[settings-look=simple]:mt-3 in-data-[settings-look=simple]:text-[14px] in-data-[settings-look=simple]:font-semibold in-data-[connect-apps]:mt-0 in-data-[connect-apps]:text-[12px] in-data-[connect-apps]:font-normal in-data-[connect-apps]:leading-4 in-data-[connect-apps]:text-ink/[0.56]">{t("mcp.empty.title")}</div>
            <div className="mt-1 max-w-sm text-[13px] font-medium text-ink-secondary in-data-[connect-apps]:mt-0.5 in-data-[connect-apps]:max-w-none in-data-[connect-apps]:text-[12px] in-data-[connect-apps]:leading-4 in-data-[connect-apps]:text-ink/[0.56]">{t("mcp.empty.desc")}</div>
          </div>
        ) : (
          <div className="mt-5 space-y-3">
            {visibleServers?.map((server) => {
              const hosted = hostedOf(server);
              const result = probe[server.name];
              const auth = isRemoteMcpListing(server) ? server.auth : undefined;
              const canSignIn = isRemoteMcpListing(server) && !server.runsOn
                && (auth === "needs-sign-in" || result?.auth === "required" || ((Boolean(hosted) || Boolean(server.oauth)) && auth !== "signed-in"));
              const underTest = testing.has(server.name);
              const locked = busy !== null || signingIn !== null || underTest;
              return (
                <div key={server.name} data-hosted-server={hosted?.id} className="rounded-2xl border border-transparent bg-card px-4 py-4 sm:px-5 in-data-[connect-apps]:rounded-[14px] in-data-[connect-apps]:border-transparent in-data-[connect-apps]:bg-menu in-data-[connect-apps]:px-3.5 in-data-[connect-apps]:py-3 in-data-[connect-apps]:sm:px-3.5">
                  <div data-mcp-row className="flex flex-wrap items-center gap-3">
                    <div className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", server.enabled ? "bg-success/10 text-success" : "bg-raised text-ink-secondary")}>
                      {hosted ? <HostedMcpIcon app={hosted} /> : isRemoteMcpListing(server) ? <Globe size={19} /> : <ServerCog size={19} />}
                    </div>
                    <div className="min-w-0 flex-[1_1_220px]">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 truncate text-[14px] font-medium text-ink">{hosted ? hosted.label : server.name}</span>
                        <span className={cn("rounded-full px-2 py-0.5 text-[11px]", server.enabled ? "bg-success/10 text-success" : "bg-raised text-ink-secondary")}>{t(server.enabled ? "mcp.badge.on" : "mcp.badge.off")}</span>
                        {auth && <span className={cn("rounded-full px-2 py-0.5 text-[11px]", auth === "signed-in" ? "bg-success/10 text-success" : "bg-warning/10 text-warning")}>{t(auth === "signed-in" ? "mcp.auth.signedIn" : "mcp.auth.needsSignIn")}</span>}
                        {server.managedBy && <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] text-ink-secondary">{t("policy.managedBy", { organization: server.managedBy })}</span>}
                      </div>
                      {server.managedBy && <div className="mt-1 text-[12px] text-ink-secondary">{t("policy.mcpBlocked", { organization: server.managedBy })}</div>}
                      {server.runsOn && <div data-mcp-runs-on className="mt-1 text-[12px] text-ink-secondary">{t("mcp.runsOn", { computer: server.runsOn.label })}</div>}
                      {server.bot && <div data-mcp-own-bot className="mt-1 text-[12px] text-ink-secondary">{t("mcp.ownBot", { bot: botName(server.bot) })}</div>}
                      {server.offFor?.length ? <div data-mcp-off-for className="mt-1 text-[12px] text-ink-secondary">{t("mcp.offFor", { bots: server.offFor.map(botName).join(", ") })}</div> : null}
                      <div className="mt-1 truncate font-mono text-[12px] text-ink-secondary">{isRemoteMcpListing(server) ? server.url : [server.command, ...server.args].join(" ")}</div>
                      {isRemoteMcpListing(server)
                        ? server.headerKeys.length > 0 && <div className="mt-1 truncate text-[11px] text-ink-secondary">{t("mcp.headersSaved", { keys: server.headerKeys.join(", ") })}</div>
                        : server.envKeys.length > 0 && <div className="mt-1 truncate text-[11px] text-ink-secondary">{t("mcp.secretsSaved", { keys: server.envKeys.join(", ") })}</div>}
                      {isRemoteMcpListing(server) && server.oauth && <div className="mt-1 truncate text-[11px] text-ink-secondary">{t(server.oauth.clientSecretConfigured ? "mcp.oauth.savedWithSecret" : "mcp.oauth.saved", { clientId: server.oauth.clientId })}</div>}
                    </div>
                    <div data-mcp-row-actions className="ml-auto flex flex-wrap items-center justify-end gap-1">
                      {signingIn === server.name ? (
                        <button type="button" onClick={() => signInAbort.current?.abort()} className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink in-data-[connect-apps]:rounded-full in-data-[connect-apps]:hover:bg-ink/[0.035]">
                          <Loader2 size={14} className="animate-spin" /> {t("mcp.auth.cancel")}
                        </button>
                      ) : canSignIn ? (
                        <button type="button" disabled={locked || Boolean(server.managedBy)} onClick={() => void signIn(server)} className="flex items-center gap-1.5 rounded-lg bg-ink px-2.5 py-2 text-[12px] font-medium text-app hover:bg-ink/85 disabled:opacity-40">
                          <LogIn size={14} /> {hosted ? t("hostedMcp.connect", { service: hosted.label }) : t("mcp.auth.signIn")}
                        </button>
                      ) : auth === "signed-in" ? (
                        <button type="button" disabled={locked} onClick={() => void signOut(server)} className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink in-data-[connect-apps]:rounded-full in-data-[connect-apps]:hover:bg-ink/[0.035] disabled:opacity-40">
                          {busy === `signout:${server.name}` ? <Loader2 size={14} className="animate-spin" /> : <LogOut size={14} />} {hosted ? t("hostedMcp.disconnect", { service: hosted.label }) : t("mcp.auth.signOut")}
                        </button>
                      ) : null}
                      {underTest ? (
                        <button type="button" onClick={() => cancelTest(server.name)} className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink in-data-[connect-apps]:rounded-full in-data-[connect-apps]:hover:bg-ink/[0.035]">
                          <Loader2 size={14} className="animate-spin" /> {t("common.cancel")}
                        </button>
                      ) : (
                        <button type="button" disabled={locked} onClick={() => void test(server)} className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink in-data-[connect-apps]:rounded-full in-data-[connect-apps]:hover:bg-ink/[0.035] disabled:opacity-40">
                          <FlaskConical size={14} /> {t("mcp.test")}
                        </button>
                      )}
                      <button type="button" disabled={locked} onClick={() => openEditor(server.name)} className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink in-data-[connect-apps]:rounded-full in-data-[connect-apps]:hover:bg-ink/[0.035] disabled:opacity-40" aria-label={t("mcp.editAria", { name: server.name })}><Pencil size={14} /></button>
                      <button type="button" disabled={locked} onClick={() => void remove(server)} className="rounded-lg p-2 text-ink-secondary hover:bg-danger/10 hover:text-danger disabled:opacity-40" aria-label={t("mcp.removeAria", { name: server.name })}><Trash2 size={14} /></button>
                      <span className="ml-1 flex items-center">
                        {busy === `toggle:${server.name}` && <Loader2 size={13} className="mr-1.5 animate-spin text-ink-secondary" />}
                        <Switch
                          checked={server.enabled}
                          disabled={locked}
                          onClick={() => void toggle(server)}
                          aria-label={t("mcp.toggleAria", {
                            name: server.name,
                            state: t(server.enabled ? "mcp.state.off" : "mcp.state.on"),
                          })}
                          className="disabled:opacity-40"
                        />
                      </span>
                    </div>
                  </div>
                  {hosted && <div className="mt-3 text-[12px] leading-relaxed text-ink-secondary">
                    <p>{t(hosted.notice)}</p>
                    <details className="mt-2">
                      <summary className="cursor-pointer font-medium text-ink">{t("hostedMcp.access")}</summary>
                      <p className="mt-2">{t("hostedMcp.accessHint")}</p>
                      <div className="mt-2 flex flex-wrap gap-2">{(store.bots ?? []).filter((bot) => !bot.hidden).map((bot) => <button key={bot.id} type="button" onClick={() => { closeConnectApps(); openBotSettings(dispatch, "access", { botId: bot.id, page: "mcp" }); }} className="rounded-lg bg-control px-2.5 py-1.5 text-ink hover:bg-raised-hover">{t("hostedMcp.botSettings", { name: bot.name })}</button>)}</div>
                    </details>
                  </div>}
                  <McpAppsSwitch<McpServerListing> server={server} disabled={locked} onSaved={(next) => { loadGeneration.current += 1; listed(next); }} />{renderSignIn(server)}
                  {underTest && (
                    <div role="status" data-mcp-testing className="mt-3 flex items-center gap-2 text-[12px] text-ink-secondary">
                      <Loader2 size={13} className="animate-spin" aria-hidden="true" /> {t(testing.get(server.name) && !server.enabled ? "mcp.check.testingOff" : "common.checking")}
                    </div>
                  )}
                  {result && signingIn !== server.name && (
                    <div role="status" className={cn("mt-3 flex flex-wrap items-center justify-between gap-2 text-[12px]", result.ok ? "text-success" : result.auth === "required" ? "text-warning" : "text-danger")}>
                      {result.auth === "required" ? t("mcp.auth.required") : result.ok ? (
                        <span className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-px shrink-0" /> {connectedLabel(result)}</span>
                      ) : (
                        <>
                          <span className="min-w-0 flex-1">{t(server.enabled ? "mcp.check.failed" : result.saved ? "mcp.check.savedOff" : "mcp.check.failedOff", { reason: failureReason(server, result) })}</span>
                          {(result.reason === "keys" && isRemoteMcpListing(server)) || result.reason === "unreachable" || result.reason === "timeout" ? (
                            <button type="button" disabled={locked}
                              onClick={() => result.reason === "keys" ? openEditor(server.name, true) : void connect(server.name)}
                              className="shrink-0 rounded-lg bg-raised px-2.5 py-1.5 font-medium text-ink hover:bg-raised-hover disabled:opacity-40">
                              {t(result.reason === "keys" ? "mcp.check.fixKeys" : "mcp.check.tryAgain")}
                            </button>
                          ) : null}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
