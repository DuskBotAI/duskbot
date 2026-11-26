import { useEffect, useRef, useState, type ReactNode } from "react";
import { PairingQr } from "./PairingQr";
import { requireUserPresence } from "@/lib/user-presence";
import { KeyRound } from "../icons";

import { t } from "@/lib/i18n";
import { copyText, type CopyFeedback } from "@/lib/copy-text";
import { api, ApiError } from "@/state/store";
import { isOwnerOrAdmin, readSessionState, type SessionState } from "../lib/session";
import { lastSeen, minutesLeft } from "../lib/pairing-time";
import { revealPhonePairing } from "../lib/phone-pairing";
import { Card } from "./SettingsPrimitives";
import { SettingsSelect } from "./SettingsSelect";
import { Card as RowsCard, ItemRow, NoteRow } from "./ListRows";
import { TeamPhoneCard } from "./TeamPhoneCard";
import { ComputerNameRow } from "./ComputerNameRow";
import { PairingTile, type PhoneParts } from "./MobilePairingCard";
import { friendlyError } from "@/lib/plain-error";

export interface PairingOffer {
  id: string;
  code: string;
  expiresAt: number;
  url: string | null;
  hint: string | null;
}

export interface PairedDevice {
  id: string;
  label: string;
  scopes: string[];
  lastSeenAt: number;
  expiresAt: number;
  email?: string;
}

/**
 * Security: only the owner on its own machine or an admin session may pair; a chat-only session must not even see the
 * offer.
 */
export function canPairDevices(state: SessionState | null): boolean {
  return isOwnerOrAdmin(state);
}

export function pairingBlockedReason(state: SessionState | null): "chat-only" | null {
  return state?.kind === "session" && !state.scopes.includes("admin") ? "chat-only" : null;
}

export function shownDevices(devices: PairedDevice[], cloudHome: boolean): PairedDevice[] {
  return cloudHome ? devices.filter((device) => device.scopes.includes("admin")) : devices;
}

const button = "ui-button ui-button-primary";
const quiet = "ui-button";

export function ServerPairingCard({ initialSession = null, cloudHome = false, focusRequest = 0, team, teamPhoneBlocked = null, simple = false, phone, elsewhere }: { initialSession?: SessionState | null; cloudHome?: boolean; focusRequest?: number; team?: string; teamPhoneBlocked?: string | null; simple?: boolean; /** the phone page's pieces, laid out around this code; null when phones may not link here */ phone?: PhoneParts | null;
  /** Settings > Computer > Connect from elsewhere: this computer's code, the row that connects to another computer, and
   * who a code lets in */
  elsewhere?: { connect: ReactNode } }) {
  const [session, setSession] = useState<SessionState | null>(initialSession);
  const [computerName, setComputerName] = useState<string | null>(null);
  const [scope, setScope] = useState<"admin" | "client">("admin");
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<CopyFeedback>("idle");
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const root = useRef<HTMLDivElement>(null);
  const revealed = useRef(0);
  const [computerOpen, setComputerOpen] = useState(false);
  const [signingOut, setSigningOut] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);

  async function loadDevices() {
    try {
      const body = await api("/api/auth/sessions");
      setDevices(Array.isArray(body?.sessions) ? body.sessions : []);
      setCurrent(typeof body?.current === "string" ? body.current : null);
      setSessionError(null);
    } catch (e) {
      setSessionError(t("remote.serverPairing.error", { error: friendlyError(e) }));
    }
  }

  useEffect(() => {
    void readSessionState().then((state) => {
      setSession(state);
      if (canPairDevices(state)) void loadDevices();
      if (state.kind === "loopback" || state.kind === "session") {
        void api("/api/config").then((config) => {
          if (canPairDevices(state)) setComputerName(typeof config?.computerName === "string" ? config.computerName : "");
        }).catch(() => {});
      }
    });
  }, []);

  useEffect(() => {
    if (!focusRequest) revealed.current = 0;
    else if (revealed.current !== focusRequest && revealPhonePairing(root.current)) {
      revealed.current = focusRequest;
      // asked for this server's own code: open it, unless the phone's own ways are on this page. That code is for /pair
      // in a browser, and the phone app reads it as unknown
      if (!phone) setComputerOpen(true);
    }
  }, [focusRequest, session, phone]);

  // a phone that just linked shows up in the sign-ins once the flow folds away
  const phoneStepping = phone?.stepping === true;
  const phoneVersion = phone?.version ?? 0;
  useEffect(() => {
    if (phone && !phoneStepping && canPairDevices(session)) void loadDevices();
  }, [phoneStepping, phoneVersion]);

  useEffect(() => {
    if (!offer) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [offer]);

  // the phone page: the phone flow or the linked phones, pairing another computer under them, then the rest
  const phonePage = (computerPair: ReactNode, rest: ReactNode) => (
    <div ref={root} tabIndex={-1} data-phone-pairing="server" className="flex scroll-mt-4 flex-col gap-5 focus:outline-none">
      {phone?.top}
      {phone?.phones}
      {phone?.stepping ? null : computerPair}
      {rest}
    </div>
  );

  if (elsewhere && !canPairDevices(session)) {
    return (
      <div data-settings-elsewhere="" className="flex flex-col gap-5">
        <p className="m-0 px-2.5 text-[13px] leading-[18px] text-ink-secondary">{t("settings.elsewhere.intro")}</p>
        {elsewhere.connect}
      </div>
    );
  }
  if (team && session?.kind === "session" && session.team) {
    if (phone !== undefined) return phonePage(null, <TeamPhoneCard team={team} blocked={teamPhoneBlocked} />);
    return (
      <div ref={root} tabIndex={-1} data-phone-pairing="server" className="scroll-mt-4 rounded-xl focus:outline-none">
        <TeamPhoneCard team={team} blocked={teamPhoneBlocked} />
      </div>
    );
  }
  if (!canPairDevices(session)) {
    if (pairingBlockedReason(session) !== "chat-only") return phone !== undefined ? phonePage(null, null) : null;
    if (simple && phone !== undefined) {
      return phonePage(null, <RowsCard><div data-server-pairing-chat-only="" className="contents"><NoteRow>{t("remote.serverPairing.chatOnly")}</NoteRow></div></RowsCard>);
    }
    if (simple) {
      return (
        <div ref={root} tabIndex={-1} data-phone-pairing="server" className="scroll-mt-4 focus:outline-none">
          <RowsCard><div data-server-pairing-chat-only="" className="contents"><NoteRow>{t("remote.serverPairing.chatOnly")}</NoteRow></div></RowsCard>
        </div>
      );
    }
    return (
      <div ref={root} tabIndex={-1} data-phone-pairing="server" className="scroll-mt-4 rounded-xl focus:outline-none">
        <Card title={t("remote.serverPairing.title")} subtitle={t("remote.serverPairing.subtitle")}>
          <p data-server-pairing-chat-only className="mt-3 text-[13px] text-ink-secondary">{t("remote.serverPairing.chatOnly")}</p>
        </Card>
      </div>
    );
  }
  const expired = offer ? offer.expiresAt <= now : false;
  const listed = shownDevices(devices, cloudHome);

  async function create() {
    setBusy(true);
    setError(null);
    setCopied("idle");
    try {
      if (!(await requireUserPresence())) return;
      const body: PairingOffer = await api("/api/auth/pairing", { method: "POST", body: JSON.stringify({ scopes: scope === "admin" || cloudHome ? ["admin", "client"] : ["client"] }) });
      setOffer(body);
      setNow(Date.now());
    } catch (e) {
      setError(t("remote.serverPairing.error", { error: friendlyError(e) }));
    } finally {
      setBusy(false);
    }
  }

  async function signOut(id: string) {
    if (signingOut !== null) return;
    setSigningOut(id);
    setSessionError(null);
    let failed: unknown = null;
    try {
      await api(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) failed = e;
    }
    try {
      if (failed) {
        setSessionError(t("remote.serverPairing.error", { error: friendlyError(failed) }));
      } else {
        setDevices((currentDevices) => currentDevices.filter((device) => device.id !== id));
        await loadDevices();
        phone?.onSessionChanged?.();
      }
    } finally {
      setSigningOut(null);
    }
  }

  async function copyLink() {
    if (!offer?.url) return;
    const result = await copyText(offer.url);
    if (result !== "empty") setCopied(result);
  }

  const offerPanel = offer ? (
        <div className="mt-4 rounded-lg border border-transparent bg-inset p-4">
          {expired ? (
            <p className="text-[13px] text-ink-secondary">{t("remote.serverPairing.expired")}</p>
          ) : (
            <div className="flex flex-wrap items-start gap-5">
              {offer.url ? (
                <div className="rounded-md bg-white p-2">
                  <PairingQr value={offer.url} size={160} level="M" bgColor="#ffffff" fgColor="#111111" />
                </div>
              ) : null}
              <div className="min-w-[200px] flex-1">
                <div className="font-mono text-[18px] tracking-[0.14em] text-ink">{offer.code}</div>
                <div className="mt-1 text-[13px] text-ink-secondary">{t("remote.serverPairing.expires", { minutes: minutesLeft(offer.expiresAt, now) })}</div>
                {offer.url ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <code className="break-all text-[12px] text-ink-secondary">{offer.url}</code>
                    <button type="button" onClick={() => void copyLink()} className={quiet}>
                      {t(copied === "copied" ? "remote.serverPairing.copied" : copied === "failed" ? "common.copyFailed" : "remote.serverPairing.copyLink")}
                    </button>
                  </div>
                ) : (
                  <p className="mt-3 text-[13px] text-ink-secondary">{offer.hint ?? t("remote.serverPairing.noLink")}</p>
                )}
              </div>
            </div>
          )}
        </div>
  ) : null;
  // Loaded with the config; a personal cloud has no computer of its own to name.
  const nameRow = (className: string) => !cloudHome && computerName !== null
    ? <div className={className}><ComputerNameRow saved={computerName} onSaved={setComputerName} /></div> : null;
  const scopeName = (device: PairedDevice) => t(device.scopes.includes("admin") ? "remote.serverPairing.scope.admin" : "remote.serverPairing.scope.client");

  if (elsewhere) {
    const live = offer && !expired ? offer : null;
    const copyCode = async () => {
      if (!live) return;
      const result = await copyText(live.url ?? live.code);
      if (result !== "empty") setCopied(result);
    };
    return (
      <div ref={root} tabIndex={-1} data-phone-pairing="server" data-settings-elsewhere="" className="flex scroll-mt-4 flex-col gap-5 focus:outline-none">
        <p className="m-0 px-2.5 text-[13px] leading-[18px] text-ink-secondary">{t("settings.elsewhere.intro")}</p>
        <RowsCard label={t("settings.elsewhere.code")} data-settings-block="pair-code">
          <div data-pairing-offer={live ? "" : undefined} className="flex flex-col items-start gap-2 px-2.5 py-2">
            {live && <code aria-label={t("settings.w6.pairing.code")} className="select-all whitespace-nowrap font-mono text-[22px] leading-8 tracking-[0.1em] text-ink">{live.code}</code>}
            <p className="m-0 text-[13px] leading-[18px] text-ink-secondary">
              {live ? t(live.url ? "settings.elsewhere.codeLive" : "remote.serverPairing.expires", { minutes: minutesLeft(live.expiresAt, now) }) : expired ? t("remote.serverPairing.expired") : t("settings.elsewhere.codeHint")}
            </p>
            {live && !live.url && <p data-pairing-no-address="" className="m-0 text-[13px] leading-[18px] text-ink-secondary [text-wrap:pretty]">{t("settings.elsewhere.noAddress")}</p>}
            <div className="flex flex-wrap items-center gap-2">
              {live && (
                <button type="button" data-pairing-copy="" className="ui-button ui-button-primary" onClick={() => void copyCode()}>
                  {t(copied === "copied" ? "remote.serverPairing.copied" : copied === "failed" ? "common.copyFailed" : "settings.elsewhere.copy")}
                </button>
              )}
              <button type="button" data-phone-pairing-action onClick={() => void create()} disabled={busy} className={live ? quiet : button}>
                {busy ? t("remote.serverPairing.creating") : offer ? t("settings.mobile.newCode") : t("settings.simple.computer.createCode")}
              </button>
            </div>
            {error ? <p role="alert" className="m-0 text-[13px] leading-[18px] text-danger">{error}</p> : null}
          </div>
          {!cloudHome && (
            <ItemRow pixel="shield" title={t("settings.s2.pairing.access")} hint={t("settings.mobile.accessHint")}>
              <SettingsSelect data-settings-select="pairing-scope" value={scope} aria-label={t("settings.s2.pairing.access")}
                options={[{ value: "admin", label: t("remote.serverPairing.scope.admin") }, { value: "client", label: t("remote.serverPairing.scope.client") }]}
                onChange={(event) => setScope(event.target.value === "client" ? "client" : "admin")} />
            </ItemRow>
          )}
        </RowsCard>
        {elsewhere.connect}
        {(listed.length > 0 || sessionError) && (
          <RowsCard label={t("remote.serverPairing.signedInDevices")} data-settings-block="paired-sessions">
            {listed.map((device) => (
              <ItemRow key={device.id} pixel="globe" title={device.label}
                hint={`${scopeName(device)} · ${t("remote.serverPairing.seen", { when: lastSeen(device.lastSeenAt, now) })}${device.id === current ? ` · ${t("remote.serverPairing.thisBrowser")}` : ""}`}>
                {device.id === current ? null : (
                  <button type="button" disabled={signingOut !== null} onClick={() => void signOut(device.id)} className="ui-button">{t("remote.serverPairing.signOut")}</button>
                )}
              </ItemRow>
            ))}
            {sessionError ? <NoteRow tone="danger">{sessionError}</NoteRow> : null}
          </RowsCard>
        )}
      </div>
    );
  }

  if (simple) {
    // secondary to the phone's own ways: this server's code, typed at /pair on another computer or browser
    const open = computerOpen || !phone;
    const computerBody = <>
            {offer && !expired ? (
              <div data-pairing-offer="" className="flex flex-col items-start gap-2">
                <code aria-label={t("settings.w6.pairing.code")} className="select-all whitespace-nowrap font-mono text-[22px] leading-8 tracking-[0.1em] text-ink">{offer.code}</code>
                <p className="m-0 text-[13px] leading-[18px] text-ink-secondary">{offer.url ? t("remote.serverPairing.expires", { minutes: minutesLeft(offer.expiresAt, now) }) : offer.hint ?? t("remote.serverPairing.noLink")}</p>
              </div>
            ) : (
              <p className="m-0 text-[13px] leading-[18px] text-ink-secondary">
                {expired ? t("remote.serverPairing.expired") : cloudHome ? t("settings.mobile.codeHintCloud") : t("settings.mobile.codeHint")}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" data-phone-pairing-action onClick={() => void create()} disabled={busy} className="ui-button mobile-press min-h-11 rounded-full">
                {busy ? t("remote.serverPairing.creating") : offer ? t("settings.mobile.newCode") : t("settings.simple.computer.createCode")}
              </button>
              {offer?.url && !expired ? (
                <button type="button" onClick={() => void copyLink()} className="mobile-press min-h-11 rounded-full px-3 text-[13px] font-medium text-ink-secondary hover:bg-ink/5">
                  {t(copied === "copied" ? "remote.serverPairing.copied" : copied === "failed" ? "common.copyFailed" : "remote.serverPairing.copyLink")}
                </button>
              ) : null}
            </div>
            {error ? <p role="alert" className="m-0 text-[13px] leading-[18px] text-danger">{error}</p> : null}
    </>;
    const computerPair = (
      <div data-pair-computer="" className="-mt-3 flex flex-col items-start gap-2">
        {phone ? (
          <button type="button" aria-expanded={open} aria-controls="server-pairing-code" onClick={() => setComputerOpen(!computerOpen)}
            className="mobile-press min-h-11 rounded-full px-3 text-[13px] font-medium text-ink-secondary hover:bg-ink/5">
            {t("settings.mobile.pairComputer")}
          </button>
        ) : null}
        <div id="server-pairing-code" hidden={!open} className="w-full">
          {phone ? (
            // under its own toggle the panel needs no second name
            <div data-pairing-tile="computer" className="flex flex-col gap-3 rounded-[12px] border-[0.5px] border-edge bg-composer p-4">{computerBody}</div>
          ) : (
            <PairingTile id="server-pairing-code-title" icon={<KeyRound size={16} />} title={t("settings.mobile.pairComputer")} data-pairing-tile="computer">{computerBody}</PairingTile>
          )}
        </div>
      </div>
    );
    // who a computer's code lets in, and who is signed in, below. A cloud's phone page leads to signing in only: a
    // code there was what people typed into the phone app
    // while the phone flow is on screen it is the only thing there; the rest waits for the linked phones
    if (phone?.stepping) return phonePage(null, null);
    return phonePage(cloudHome && phone ? null : computerPair, <>
      {!cloudHome && computerName !== null && (
        <RowsCard label={t("settings.mobile.thisComputer")} data-settings-block="pair-code">
          <ComputerNameRow saved={computerName} onSaved={setComputerName} />
          <ItemRow pixel="shield" title={t("settings.s2.pairing.access")} hint={t("settings.mobile.accessHint")}>
            <SettingsSelect data-settings-select="pairing-scope" value={scope} aria-label={t("settings.s2.pairing.access")}
              options={[{ value: "admin", label: t("remote.serverPairing.scope.admin") }, { value: "client", label: t("remote.serverPairing.scope.client") }]}
              onChange={(event) => setScope(event.target.value === "client" ? "client" : "admin")} />
          </ItemRow>
        </RowsCard>
      )}
      {/* "Signed-in" either way: the desktop's own paired phones are listed under "phones" on the same page */}
      <RowsCard label={t("remote.serverPairing.signedInDevices")} data-settings-block="paired-sessions">
        {listed.length === 0 ? (
          <NoteRow>{t("remote.serverPairing.noDevices")}</NoteRow>
        ) : listed.map((device) => (
          <ItemRow key={device.id} pixel="globe" title={device.label}
            hint={`${scopeName(device)} · ${t("remote.serverPairing.seen", { when: lastSeen(device.lastSeenAt, now) })}${device.id === current ? ` · ${t("remote.serverPairing.thisBrowser")}` : ""}`}>
            {device.id === current ? null : (
              <button type="button" disabled={signingOut !== null} onClick={() => void signOut(device.id)} className="ui-button">{t("remote.serverPairing.signOut")}</button>
            )}
          </ItemRow>
        ))}
        {sessionError ? <NoteRow tone="danger">{sessionError}</NoteRow> : null}
      </RowsCard>
    </>);
  }

  return (
    <div ref={root} tabIndex={-1} data-phone-pairing="server" className="scroll-mt-4 rounded-xl focus:outline-none">
    <Card title={t("remote.serverPairing.title")} subtitle={t("remote.serverPairing.subtitle")}>
      {cloudHome ? <p data-server-pairing-personal className="mt-3 text-[13px] text-ink-secondary">{t("remote.serverPairing.cloudPersonal")}</p> : null}
      {nameRow("mt-3")}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {cloudHome ? null : <>
          <label className="flex items-center gap-1.5 text-[13px] text-ink">
            <input type="radio" name="server-pairing-scope" checked={scope === "admin"} onChange={() => setScope("admin")} />
            {t("remote.serverPairing.scope.admin")}
          </label>
          <label className="flex items-center gap-1.5 text-[13px] text-ink">
            <input type="radio" name="server-pairing-scope" checked={scope === "client"} onChange={() => setScope("client")} />
            {t("remote.serverPairing.scope.client")}
          </label>
        </>}
        <button type="button" data-phone-pairing-action onClick={() => void create()} disabled={busy} className={button}>
          {busy ? t("remote.serverPairing.creating") : t("remote.serverPairing.create")}
        </button>
      </div>
      {offerPanel}
      <div className="mt-5 text-[13px] font-medium text-ink">{t("remote.serverPairing.devices")}</div>
      {listed.length === 0 ? (
        <p className="mt-1 text-[13px] text-ink-secondary">{t("remote.serverPairing.noDevices")}</p>
      ) : (
        <ul className="mt-1 divide-y divide-transparent">
          {listed.map((device) => (
            <li key={device.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[13px]">
              <span className="text-ink">
                {device.label}
                {device.email ? <span className="text-ink-secondary"> · {device.email}</span> : null}
                <span className="text-ink-secondary">
                  {" · "}
                  {device.scopes.includes("admin") ? t("remote.serverPairing.scope.admin") : t("remote.serverPairing.scope.client")}
                  {" · "}
                  {t("remote.serverPairing.seen", { when: lastSeen(device.lastSeenAt, now) })}
                  {device.id === current ? ` · ${t("remote.serverPairing.thisBrowser")}` : ""}
                </span>
              </span>
              {device.id === current ? null : (
                <button type="button" disabled={signingOut !== null} onClick={() => void signOut(device.id)} className={quiet}>
                  {t("remote.serverPairing.signOut")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {sessionError ? <p role="alert" className="mt-3 text-[13px] text-danger">{sessionError}</p> : null}
      {error ? <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p> : null}
    </Card>
    </div>
  );
}
