import { upperFirst } from "@/lib/lower-first";
import { useEffect, useId, useState, type ReactNode } from "react";

import { t } from "@/lib/i18n";
import { KEEP_WORDS } from "@/locales/brand-case";
import { needsReconnect } from "@/lib/connector-status";
import { connectorSetupNotice } from "./connector-helpers";
import type { ToolkitCard } from "../ServiceIcon";
import { Icon } from "../Icon";
import { Select } from "../Select";
import { AppTile, ConnectedMark, RowPill, type RowAction } from "./AppRow";
import type { AppEntry, Connection } from "./catalog";
import type { ConnectorPhase, Connectors } from "./use-connectors";
import { COMPOSIO_AUTH_CONFIGS_URL } from "../../../shared/connector-availability";
import { composioPage, loadToolkitActions, type SnapshotToolkit, type ToolkitActions } from "./composio-snapshot";
import { abilityLines } from "./ability-lines";
import { ComposioKeyStep, viaLine } from "./ComposioKeyStep";
import { GmailCard, gmailCard } from "./GmailCard";
import type { Primary } from "./PrimaryButton";
import { ConnectBlock } from "./ConnectBlock";
import type { ConnectorAccount } from "@/lib/connector-status";
import { activeAccounts, defaultAccount, nextAccountName, useAccountChoices } from "./account-choices";
import type { RemoteAccount } from "./use-remote-apps";

/** One way an app connects, when it has more than one: our own card, its token or sign-in in place of the card's, the vendor's server, Composio. */
export interface Way {
  key: "own" | "token" | "remote" | "composio";
  label: string;
  connected: boolean;
  action?: Extract<RowAction, { kind: "button" }>;
}

export interface AppPageModel {
  entry: AppEntry;
  /** The app's Composio toolkit, its own id or the one folded into our card. */
  composioSlug?: string;
  ways?: Way[];
  connection: Connection;
  phase: ConnectorPhase | null;
  card: ToolkitCard | undefined;
  connectors: Connectors;
  /** The page's own way in (the native card under it) leads; everything here is another way to connect. */
  ownFirst?: boolean;
  usedBy: string[];
  /** The bots that can use this app, for picking which of its accounts each one uses. */
  appBots: Array<{ id: string; name: string }>;
  /** What Composio's catalog says about the app: how you sign in, and what it can do. */
  toolkit?: SnapshotToolkit;
  remoteClient: boolean;
  onOpenLogins: () => void;
  onOpenKeys: () => void;
  /** A vendor's own MCP server: connect signs in there, managing it is the MCP servers page. */
  remote?: {
    open: boolean; busy: boolean; stalled?: boolean; onConnect: () => void; onCancel: () => void; onManage: () => void;
    /** Its directory id, the slug its account picks are kept under (`mcp-<id>`). */
    appId?: string;
    /** Each entry signed in to the app, one per account of the person's. */
    accounts?: RemoteAccount[];
    bots?: Array<{ id: string; name: string }>;
    onReconnect?: (server: string) => void;
    onAddAccount?: (account: string) => void;
  };
}

/** One app's page, top down: its tile, name and what it does, then the one way to connect, its accounts, the other ways
 * folded behind one toggle, and a quiet line of facts. */
export function AppPage({ model }: { model: AppPageModel }) {
  const { entry, phase, card, connectors } = model;
  const [alias, setAlias] = useState("");
  const slug = model.composioSlug ?? entry.id;
  const composio = model.composioSlug !== undefined && card !== undefined;
  // more than one way in: each shows in the ways card, and Composio's setup waits until that one is picked
  const ways = model.ways && model.ways.length > 1 ? model.ways : null;
  const ownFirst = model.ownFirst === true;
  const remoteAccounts = model.remote?.accounts ?? [];
  const remoteLeads = model.remote !== undefined && (entry.kind === "remote" || !(connectors.configured || connectors.via?.signedIn === true));
  // one way shows at a time: the rest are rows behind the other-ways toggle
  const leadWay: Way["key"] = ownFirst ? "own" : remoteLeads ? "remote" : "composio";
  // Composio leading the page sets up in place, as it does when it is the only way
  const composioOnly = !ways || leadWay === "composio";
  const status = composio ? connectors.status[slug] : undefined;
  const accounts = status?.accounts ?? [];
  const { choices, choose } = useAccountChoices();
  const active = activeAccounts(status);
  const usual = defaultAccount(status, choices.defaults[slug]);
  const [choiceFailed, setChoiceFailed] = useState(false);
  const pick = (accountId: string | null, botId?: string) => { setChoiceFailed(false); void choose(slug, accountId, botId).then((ok) => { if (!ok) setChoiceFailed(true); }); };
  // one click: the new account gets the next free name, and the one already there becomes the default it keeps
  const addAccount = () => {
    if (!choices.defaults[slug] && usual) pick(usual.id);
    void connectors.connect(slug, nextAccountName(accounts, t("connectApps.account.word")));
  };
  const accountName = (account: ConnectorAccount) => account.alias || t("connectApps.account.fallback");
  // a key is all that is missing: the key step shows right here, no trip to Settings
  const viaSignedIn = connectors.via?.signedIn === true;
  const askingKey = composio && !model.remoteClient && !viaSignedIn
    && (connectors.keyFor === slug || (composioOnly && !connectors.configured && !connectors.stale && connectors.setup === "needs-setup"));
  const setup = composio && !askingKey && !viaSignedIn && composioOnly ? connectorSetupNotice({ configured: connectors.configured, stale: connectors.stale, setup: connectors.setup, remoteClient: model.remoteClient }) : null;
  const flow = composio ? connectors.viaFlow[slug] : undefined;
  // through Composio Connect: two steps, Authorize Composio then Connect the app, and the main button is the one you are on
  const viaSteps = askingKey || (composio && !model.remoteClient && viaSignedIn && connectors.viaRoute(slug)
    && (flow !== undefined || (composioOnly && model.connection !== "connected")));
  // Composio is connected once per person: its guided step shows only until then; after that an app is just its sign-in
  const firstTime = viaSteps && !viaSignedIn;
  const viaStatus = viaSteps && viaSignedIn ? viaLine(flow, entry.label) : null;
  const askingAlias = composio && connectors.aliasFor === slug;
  const aliasError = askingAlias && connectors.error ? (typeof connectors.error === "string" ? connectors.error : t(connectors.error.key)) : null;

  const remoteStale = model.connection === "connected" ? undefined : remoteAccounts.find((account) => account.stale);
  const primary = ((): Primary | null => {
    // our own card connects in its body below, when it leads
    if (entry.kind !== "composio" && entry.kind !== "remote" && (ownFirst || !ways)) return null;
    if (model.remote && remoteLeads) {
      const remote = model.remote;
      if (remoteStale && remote.onReconnect) {
        return { label: t("connectors.action.reconnect"), busy: remote.busy, onClick: () => remote.onReconnect!(remoteStale.name), onCancel: remote.onCancel };
      }
      return model.connection === "connected"
        ? { label: t("connectApps.remote.manage"), quiet: true, onClick: remote.onManage }
        : { label: t(remote.stalled ? "connectors.action.retry" : "connectors.action.connect"), busy: remote.busy, disabled: model.connection === "unknown", onClick: remote.onConnect, onCancel: remote.onCancel };
    }
    if (!composio || !phase) return null;
    const connect: Primary = { label: t("connectApps.connectApp", { name: entry.label }), onClick: () => void connectors.connect(slug), onCancel: () => connectors.cancel(slug) };
    if (viaSteps) {
      const authorize: Primary = { label: t("connectApps.via.authorize"), signIn: true, disabled: model.remoteClient, onClick: () => void connectors.authorizeComposio(slug), onCancel: () => connectors.cancel(slug) };
      if (flow?.step === "authorizing") return { ...authorize, busy: true, busyLabel: t(flow.opened ? "connectApps.signIn.waiting" : "connectApps.signIn.opening") };
      if (flow?.step === "failed" && flow.why === "signedOut") return { ...authorize, label: t("connectApps.via.authorizeAgain") };
      if (!viaSignedIn) return flow?.step === "failed" ? { ...authorize, label: t("connectors.action.retry") } : authorize;
      if (flow?.step === "waiting") return { label: t("connectApps.via.openAgain"), onClick: () => connectors.reopenVia(slug), onCancel: () => connectors.cancel(slug), waiting: true };
      if (flow?.step === "failed") return { label: t("connectors.action.retry"), onClick: () => void connectors.connect(slug) };
      if (flow?.step === "done" || model.connection === "connected") return null;
      return phase.kind === "connecting" ? { ...connect, busy: true, busyLabel: t("connectApps.signIn.opening") } : connect;
    }
    if (askingKey) return null;
    if (ways && model.connection === "connected" && phase.kind === "connect") return null;
    if (!connectors.configured && !viaSignedIn) return { ...connect, disabled: model.remoteClient, onClick: () => connectors.askKey(slug) };
    switch (phase.kind) {
      case "checking": return { ...connect, disabled: true };
      case "connecting": return { ...connect, busy: true };
      case "continue": return { label: t("connectApps.via.openAgain"), onClick: () => connectors.resume(slug), onCancel: () => connectors.cancel(slug), waiting: true };
      case "failed": return { label: t("connectors.action.retry"), onClick: () => void connectors.connect(slug) };
      case "reconnect": return { label: t("connectors.action.reconnect"), onClick: () => void connectors.connect(slug, phase.account.alias, phase.account) };
      // grok keeps Add Account with the accounts it adds to
      case "connected": return accounts.length || connectors.viaApps[slug] ? null : { label: t("connectors.action.addAccount"), quiet: true, onClick: addAccount };
      case "included": return { label: t("connectors.action.included"), quiet: true, disabled: true };
      case "setup": return { ...connect, label: t("common.checkAgain") };
      case "unavailable": return { ...connect, disabled: true };
      default: return connect;
    }
  })();

  // gmail connects on one card: its promise, the one button, and where the sign-in stands
  const gmail = composio && slug === "gmail" && composioOnly && !model.remote && phase !== null
    ? gmailCard({
      name: entry.label, primary, connected: model.connection === "connected", via: viaSteps, viaSignedIn, flow, phase,
      ...(model.remoteClient ? {} : { onOwnKey: model.onOpenKeys }),
    })
    : null;
  const facts = appFacts(model);
  const keyCard = Boolean(firstTime) && !gmail;
  const ownCard = entry.kind !== "composio";
  // our own way is a row here only when it is not the lead: its card then opens under these rows
  const otherWays = ways ? ways.filter((way) => way.key !== leadWay) : [];
  const remoteNote = model.remote && remoteLeads ? t(model.remote.open ? "connectApps.remote.open" : "connectApps.remote.note", { name: entry.label }) : null;
  // a sign-in out on the page that opened, through a key or the broker: say so beside Open page again, as the via path does
  // ended unfinished (the link ran out, or cancelled on the app's page): said beside Retry, not a quiet Connect again
  const waitLine = viaStatus ? null
    : primary?.waiting === true && phase?.kind === "continue" ? { text: t("connectApps.gmail.waiting"), tone: "status" as const }
    : phase?.kind === "failed" ? viaLine({ step: "failed", why: phase.why, ...(phase.message ? { message: phase.message } : {}) }, entry.label)
    : null;
  const block = !gmail && !keyCard && Boolean(primary || viaStatus || remoteNote);
  const othersBusy = otherWays.some((way) => way.connected || way.action?.busy === true || way.action?.pending === true)
    || (ownFirst && (flow !== undefined || askingKey || askingAlias || accounts.length > 0 || model.remote?.busy === true
      || remoteAccounts.some((account) => account.signedIn || account.stale)
      || (phase !== null && ["connecting", "continue", "failed", "reconnect"].includes(phase.kind))));
  const [othersOpen, setOthersOpen] = useState(false);
  useEffect(() => { setOthersOpen(false); }, [entry.id]);
  useEffect(() => { if (othersBusy) setOthersOpen(true); }, [othersBusy, entry.id]);

  const groups = (
    <div className="ca-groups">
      {gmail && <GmailCard model={gmail} />}
      {block && <ConnectBlock note={remoteNote} primary={primary} line={viaStatus ?? waitLine} lineMarker={waitLine ? "data-connect-line" : "data-via-line"} />}
      {keyCard && <ComposioKeyStep slug={slug} name={entry.label} connectors={connectors} primary={primary} />}
      {setup && (
        <p className="ca-notice" data-tone={setup.tone === "warning" ? "danger" : undefined}>
          {t(setup.key)}{" "}
          {!model.remoteClient && <button type="button" className="ca-link" onClick={model.onOpenKeys}>{t("connectors.openSettings")}</button>}
        </p>
      )}
      {phase?.kind === "unavailable" && <p className="ca-notice">{phase.reason}</p>}
      {phase?.kind === "setup" && (
        <p className="ca-notice" data-composio-setup="">
          {/* the official broker's project cannot use the person's own auth config, their own key can */}
          {t(connectors.mode === "managed" ? "connectApps.composioSetupKey" : "connectApps.composioSetup", { name: entry.label })}{" "}
          <a className="ca-link" href={COMPOSIO_AUTH_CONFIGS_URL} target="_blank" rel="noopener noreferrer">{t("connectApps.openComposio")}</a>
          {connectors.mode === "managed" && !model.remoteClient && <>{" "}<button type="button" className="ca-link" onClick={() => connectors.askKey(slug)}>{t("connectApps.key.add")}</button></>}
        </p>
      )}
      {ownFirst && otherWays.length > 0 && <WayRows ways={otherWays} name={entry.label} />}
      {model.remote && !model.remote.open && remoteAccounts.some((account) => account.signedIn || account.stale) && (
        <RemoteAccounts remote={model.remote} name={entry.label} accounts={remoteAccounts} />
      )}
      {composio && (accounts.length > 0 || askingAlias) && (
        <div data-accounts="">
          <h3 className="ca-group-label">{t("connectApps.accounts")}</h3>
          <div className="ca-card">
            {accounts.map((account) => (
              <AccountRow key={account.id} account={account} service={entry.label} busy={phase?.kind === "connecting"}
                isDefault={active.length > 1 && usual?.id === account.id}
                {...(active.length > 1 && usual?.id !== account.id && /^active$/i.test(account.status) ? { onMakeDefault: () => pick(account.id) } : {})}
                onReconnect={() => void connectors.connect(slug, account.alias, account)}
                onDisconnect={() => connectors.disconnect(slug, account.id)} />
            ))}
            {askingAlias && (
              <form className="ca-alias" onSubmit={(event) => {
                event.preventDefault();
                const name = alias.trim();
                if (!name) { connectors.setError({ key: "connectors.aliasRequired" }); return; }
                void connectors.connect(slug, name);
              }}>
                <input autoFocus value={alias} maxLength={64} onChange={(event) => setAlias(event.target.value)}
                  placeholder={t("connectors.aliasPlaceholder")}
                  aria-label={accounts.length ? t("connectors.aliasAriaAnother", { service: entry.label }) : t("connectors.aliasAriaNew", { service: entry.label })} />
                <button type="submit" className="ca-primary" disabled={phase?.kind === "connecting" || !alias.trim()}><span>{t("connectors.action.continue")}</span></button>
              </form>
            )}
            {aliasError && <p role="alert" className="ca-card-row">{aliasError}</p>}
            {!askingAlias && accounts.length > 0 && (
              <div className="ca-card-row">
                <button type="button" className="ca-pill" disabled={phase?.kind === "connecting"} onClick={addAccount}>
                  <span>{t("connectors.action.addAccount")}</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      {composio && active.length > 1 && (model.appBots?.length ?? 0) > 0 && usual && (
        <div data-account-bots="">
          <h3 className="ca-group-label">{t("connectApps.botsUse")}</h3>
          <div className="ca-card">
            {(model.appBots ?? []).map((bot) => {
              const own = choices.bots[bot.id]?.[slug];
              return (
                <label key={bot.id} className="ca-card-row" data-account-bot={bot.id}>
                  <span>{bot.name}</span>
                  <Select variant="pill" size="sm" className="ml-auto max-w-[220px]" value={own && active.some((account) => account.id === own) ? own : ""}
                    aria-label={t("connectApps.botsUse.aria", { bot: bot.name, service: entry.label })}
                    onChange={(event) => pick(event.target.value || null, bot.id)}>
                    <option value="">{t("connectApps.botsUse.default", { name: accountName(usual) })}</option>
                    {active.map((account) => <option key={account.id} value={account.id}>{accountName(account)}</option>)}
                  </Select>
                </label>
              );
            })}
          </div>
        </div>
      )}
      {choiceFailed && <p role="alert" className="ca-notice" data-tone="danger">{t("connectApps.account.choiceFailed")}</p>}
      {model.toolkit && !gmail && <ToolkitAbilities toolkit={model.toolkit} name={entry.label} />}
    </div>
  );

  return (
    <>
      <div className="ca-detail" data-app-page={entry.id}>
        <header className="ca-detail-header">
          <AppTile entry={entry} size={56} />
          <span className="ca-detail-title">
            <h3 className="ca-detail-name" data-detail-hero-title="">{entry.label}</h3>
            <p className="ca-detail-desc" title={entry.description}>{entry.description}</p>
          </span>
          {!ownFirst && !gmail && !keyCard && !primary && (entry.kind === "composio" || entry.kind === "remote") && model.connection === "connected" && <ConnectedMark />}
        </header>
        {!ownFirst && groups}
      </div>
      {(ownFirst || otherWays.length > 0) && (
        <OtherWays open={othersOpen} onToggle={() => setOthersOpen(!othersOpen)}>
          {ownFirst ? groups : <WayRows ways={otherWays} name={entry.label} />}
        </OtherWays>
      )}
      {!ownCard && <AppFacts facts={facts} />}
    </>
  );
}

/** The ways in that are not the page's main one, each with its own button. */
function WayRows({ ways, name }: { ways: Way[]; name: string }) {
  return (
    <div className="ca-card" data-ways="">
      {ways.map((way) => (
        <div key={way.key} className="ca-card-row" data-way={way.key}>
          <span>{way.label}</span>
          {way.connected ? <ConnectedMark /> : way.action && <RowPill action={way.action} name={`${name}, ${way.label}`} />}
        </div>
      ))}
    </div>
  );
}

/** Every other way to connect, folded behind one quiet toggle under the main one. */
function OtherWays({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }) {
  const id = useId();
  return (
    <section className="ca-other-ways" data-other-ways="" data-open={open ? "" : undefined}>
      <button type="button" className="ca-other-toggle" aria-expanded={open} aria-controls={id} onClick={onToggle}>
        <span>{t("connectApps.otherWays")}</span>
        <Icon name="chevron-down" size={12} />
      </button>
      {open && <div id={id} className="ca-other-body">{children}</div>}
    </section>
  );
}

/** A vendor server's accounts: each entry by the account it signs in as, a quiet mark on one to sign in to again, Add
 * another account, and with more than one working, which one each bot uses. */
export function RemoteAccounts({ remote, name, accounts }: { remote: NonNullable<AppPageModel["remote"]>; name: string; accounts: RemoteAccount[] }) {
  const { choices, choose } = useAccountChoices();
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [failed, setFailed] = useState(false);
  const slug = `mcp-${remote.appId ?? ""}`;
  const shown = accounts.filter((account) => account.signedIn || account.stale);
  const working = shown.filter((account) => account.signedIn);
  const titleOf = (account: RemoteAccount, index: number) => account.account || (index === 0 ? name : `${t("connectApps.account.word")} ${index + 1}`);
  const titles = new Map(shown.map((account, index) => [account.name, titleOf(account, index)]));
  const usual = working.find((account) => account.name === choices.defaults[slug]) ?? working[0];
  const pick = (server: string | null, botId?: string) => { setFailed(false); void choose(slug, server, botId).then((ok) => { if (!ok) setFailed(true); }); };
  const add = () => {
    const account = label.trim();
    if (!account || !remote.onAddAccount) return;
    // the one already there stays every bot's account until a bot is given the new one
    if (!choices.defaults[slug] && usual) pick(usual.name);
    remote.onAddAccount(account);
    setAdding(false);
    setLabel("");
  };
  return (
    <>
      <div data-remote-accounts="">
        <h3 className="ca-group-label">{t("connectApps.accounts")}</h3>
        <div className="ca-card">
          {shown.map((account) => {
            const title = titles.get(account.name)!;
            return (
              <div key={account.name} className="ca-card-row" data-remote-account={account.name}>
                <span data-glyph="" aria-hidden="true"><Icon name="person" size={16} /></span>
                <span>
                  {title}
                  {account.stale && <span className="ca-account-tag" data-tone="quiet" data-needs-reconnect="">{t("connectApps.account.needsReconnect")}</span>}
                  {working.length > 1 && usual?.name === account.name && <span className="ca-account-tag" data-tone="quiet">{t("connectApps.account.default")}</span>}
                </span>
                {working.length > 1 && account.signedIn && usual?.name !== account.name && (
                  <button type="button" className="ca-pill" disabled={remote.busy} onClick={() => pick(account.name)}
                    aria-label={t("connectApps.account.makeDefaultAria", { title })}>
                    <span>{t("connectApps.account.makeDefault")}</span>
                  </button>
                )}
                {account.stale && remote.onReconnect && (
                  <button type="button" className="ca-pill" disabled={remote.busy} onClick={() => remote.onReconnect!(account.name)}
                    aria-label={t("connectors.reconnectAria", { account: title, service: name })}>
                    <span>{t("connectors.action.reconnect")}</span>
                  </button>
                )}
              </div>
            );
          })}
          {adding ? (
            <form className="ca-alias" onSubmit={(event) => { event.preventDefault(); add(); }}>
              <input autoFocus value={label} maxLength={64} onChange={(event) => setLabel(event.target.value)}
                placeholder={t("connectors.aliasPlaceholder")} aria-label={t("connectors.aliasAriaAnother", { service: name })} />
              <button type="submit" className="ca-primary" disabled={remote.busy || !label.trim()}><span>{t("connectors.action.continue")}</span></button>
            </form>
          ) : remote.onAddAccount && (
            <div className="ca-card-row">
              <button type="button" className="ca-pill" disabled={remote.busy} onClick={() => setAdding(true)} data-add-account="">
                <span>{t("tokenApps.addAnother")}</span>
              </button>
            </div>
          )}
        </div>
      </div>
      {working.length > 1 && (remote.bots?.length ?? 0) > 0 && usual && (
        <div data-account-bots="">
          <h3 className="ca-group-label">{t("connectApps.botsUse")}</h3>
          <div className="ca-card">
            {(remote.bots ?? []).map((bot) => {
              const own = choices.bots[bot.id]?.[slug];
              return (
                <label key={bot.id} className="ca-card-row" data-account-bot={bot.id}>
                  <span>{bot.name}</span>
                  <Select variant="pill" size="sm" className="ml-auto max-w-[220px]" value={own && working.some((account) => account.name === own) ? own : ""}
                    aria-label={t("connectApps.botsUse.aria", { bot: bot.name, service: name })}
                    onChange={(event) => pick(event.target.value || null, bot.id)}>
                    <option value="">{t("connectApps.botsUse.default", { name: titles.get(usual.name)! })}</option>
                    {working.map((account) => <option key={account.name} value={account.name}>{titles.get(account.name)}</option>)}
                  </Select>
                </label>
              );
            })}
          </div>
        </div>
      )}
      {failed && <p role="alert" className="ca-notice" data-tone="danger">{t("connectApps.account.choiceFailed")}</p>}
    </>
  );
}

/** One account, Grok's way: its name, a mark when it needs signing in again, and Disconnect that turns into Confirm
 * Disconnect in place instead of asking in a dialog. */
function AccountRow({ account, service, busy, isDefault, onMakeDefault, onReconnect, onDisconnect }: {
  account: ConnectorAccount;
  service: string;
  busy: boolean;
  isDefault: boolean;
  onMakeDefault?: () => void;
  onReconnect: () => void;
  onDisconnect: () => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState(false);
  const [removing, setRemoving] = useState(false);
  const title = account.alias || upperFirst(t("connectApps.account.fallback"));
  const stale = needsReconnect(account);
  return (
    <>
      <div className="ca-card-row" data-account={account.id}>
        <span data-glyph="" aria-hidden="true"><Icon name="person" size={16} /></span>
        <span title={account.alias ? undefined : account.id}>
          {title}
          {stale && <span className="ca-account-tag" data-tone="quiet">{t("connectApps.account.needsReconnect")}</span>}
          {isDefault && <span className="ca-account-tag" data-tone="quiet">{t("connectApps.account.default")}</span>}
        </span>
        {onMakeDefault && !confirming && (
          <button type="button" className="ca-pill" disabled={busy || removing} onClick={onMakeDefault}
            aria-label={t("connectApps.account.makeDefaultAria", { title })}>
            <span>{t("connectApps.account.makeDefault")}</span>
          </button>
        )}
        {stale && (
          <button type="button" className="ca-pill" disabled={busy || removing}
            aria-label={t("connectors.reconnectAria", { account: title, service })} onClick={onReconnect}>
            <span>{t("connectors.action.reconnect")}</span>
          </button>
        )}
        {confirming ? (
          <button type="button" className="ca-pill" data-tone="danger-solid" disabled={busy || removing}
            aria-label={t("connectApps.account.confirmAria", { title: account.alias || t("connectApps.account.fallback") })}
            onClick={() => {
              setConfirming(false);
              setFailed(false);
              setRemoving(true);
              void onDisconnect().then((ok) => { setRemoving(false); if (!ok) setFailed(true); });
            }}>
            <span>{t("connectApps.account.confirm")}</span>
          </button>
        ) : (
          <button type="button" className="ca-pill" data-tone="danger" disabled={busy || removing}
            aria-label={t("connectors.disconnectAria", { account: title, service })} onClick={() => setConfirming(true)}>
            <span>{t("connectors.disconnect")}</span>
          </button>
        )}
      </div>
      {failed && <p role="alert" className="ca-card-row">{t("connectApps.account.removeFailed")}</p>}
    </>
  );
}

export function appFacts(model: Pick<AppPageModel, "entry" | "usedBy">): Array<[string, string]> {
  const facts: Array<[string, string]> = [];
  if (model.entry.website) facts.push([t("connectApps.info.website"), model.entry.website]);
  if (model.usedBy.length) facts.push([t("connectApps.info.usedBy"), model.usedBy.join(", ")]);
  return facts;
}

const PROPER = /^[A-Z][a-z]+$/;

/** A tool's name in sentence case: "New Channel Created Trigger" reads "New channel created trigger"; the app's own name
 * and other names (Slack, Google) keep their capital, and so do mixed or all-caps words (GitHub, API). */
export function toolName(name: string, app: string): string {
  const keep = new Set(app.split(/\s+/));
  return name.split(" ").map((word, index) => {
    if (index === 0) return word.charAt(0).toUpperCase() + word.slice(1);
    return PROPER.test(word) && !keep.has(word) && !KEEP_WORDS.has(word) ? word.toLowerCase() : word;
  }).join(" ");
}

/** What an app can do: a quiet row with its count, open from the start, then a search, the actions as plain lines with
 * the everyday ones first, its triggers, and a link to every one on Composio's page for it. Folding slides the list. */
/** How many abilities a long list shows before its search and "Show more"; a list this short has neither. */
const ABILITIES_SHOWN = 12;

function ToolkitAbilities({ toolkit, name }: { toolkit: SnapshotToolkit; name: string }) {
  // undefined while its names load, so the row opens whole instead of growing
  const [lists, setLists] = useState<ToolkitActions | null | undefined>(undefined);
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [whole, setWhole] = useState(false);
  const listId = useId();
  useEffect(() => {
    let alive = true;
    setLists(undefined);
    setOpen(true);
    setQuery("");
    setWhole(false);
    void loadToolkitActions(toolkit.slug).then((found) => { if (alive) setLists(found); });
    return () => { alive = false; };
  }, [toolkit.slug]);
  if (lists === undefined || toolkit.tools <= 0) return null;
  const needle = query.trim().toLowerCase();
  // a multi-word app's own words ("Google Calendar") read as plain nouns inside a line ("Change calendar")
  const keep = name.includes(" ") ? "" : name;
  const groups = [
    { key: "actions", label: null, names: abilityLines(lists?.actions ?? []) },
    { key: "triggers", label: t("connectApps.info.triggers"), names: lists?.triggers ?? [] },
  ].map((group) => ({ ...group, names: group.names.map((one) => toolName(one, keep)).filter((one) => !needle || one.toLowerCase().includes(needle)) }));
  const found = groups.some((group) => group.names.length > 0);
  const listed = (lists?.actions?.length ?? 0) + (lists?.triggers?.length ?? 0);
  // a long list opens on its first rows and a search; a short one is simply all there
  let budget = needle || whole ? Infinity : ABILITIES_SHOWN;
  const shown = groups.map((group) => {
    const names = group.names.slice(0, Math.max(0, budget));
    budget -= names.length;
    return { ...group, names };
  });
  const hidden = groups.reduce((sum, group) => sum + group.names.length, 0) - shown.reduce((sum, group) => sum + group.names.length, 0);
  return (
    <section className="ca-card" data-toolkit-group="actions" data-open={open ? "" : undefined}>
      <button type="button" className="ca-card-row ca-abilities-toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
        <span>{t("connectApps.canDo", { name })}</span>
        <span className="ca-abilities-count">{toolkit.tools}</span>
        <Icon name="chevron-down" size={14} />
      </button>
      <div className="ca-abilities-fold" data-open={open ? "" : undefined} inert={!open}>
        <div id={listId} className="ca-abilities">
          {listed > ABILITIES_SHOWN && (
            <div className="ca-card-row">
              <input type="search" className="ca-abilities-search" value={query} onChange={(event) => setQuery(event.target.value)}
                placeholder={t("connectApps.canDo.searchPlaceholder", { name })} aria-label={t("connectApps.canDo.searchPlaceholder", { name })} />
            </div>
          )}
          {shown.filter((group) => group.names.length > 0).map((group) => (
            <div key={group.key} data-ability-group={group.key}>
              {group.label && <p className="ca-card-row ca-abilities-label">{group.label}</p>}
              {group.names.map((one, index) => <div key={`${index}:${one}`} className="ca-card-row" data-ability=""><span data-tip-clipped={one}>{one}</span></div>)}
            </div>
          ))}
          {needle && !found && <p className="ca-card-row ca-abilities-label" role="status">{t("connectApps.noResults", { query: query.trim() })}</p>}
          {(hidden > 0 || toolkit.tools > listed) && (
            <div className="ca-card-row ca-abilities-foot">
              {hidden > 0 && <button type="button" className="ca-link" onClick={() => setWhole(true)}>{t("connectApps.canDo.showMore", { count: hidden })}</button>}
              {toolkit.tools > listed && (
                <a className="ca-link" href={composioPage(toolkit.slug)} target="_blank" rel="noopener noreferrer">
                  {t("connectApps.composioAll", { count: toolkit.tools })}
                  <Icon name="arrow-right-up" size={12} />
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** The facts about an app, as one quiet line at the foot of its page. */
export function AppFacts({ facts }: { facts: Array<[string, string]> }) {
  if (!facts.length) return null;
  return (
    <p className="ca-facts" data-app-facts="">
      {facts.map(([term, value]) => <span key={term} title={value}>{term} <span data-value="">{value}</span></span>)}
    </p>
  );
}
