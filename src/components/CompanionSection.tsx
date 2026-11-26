import { useEffect, useRef } from "react";
import { t } from "@/lib/i18n";
import {
  PhoneSetupFlowView,
  companionAccountActionError,
  companionBridge,
  loadCompanionBridgeState,
  shouldHydrateCompanionEmail,
  type CompanionState,
  type PhoneSetupController,
  usePhoneSetupController,
} from "./PhoneSetupFlow";
import { companionPairingMode } from "../lib/phone-setup";
import { revealPhonePairing } from "../lib/phone-pairing";
import { PhonesList } from "./PhonesList";
import { ConnectionDetail } from "./ConnectionDetail";
import { SettingRow, SettingsGroup, SettingsRows, Switch } from "./SettingsPrimitives";
import { NavRow, NoteRow, useSubPage } from "./ListRows";
import { useStore } from "@/state/store";
import { PHONE_ADVANCED_PAGE } from "./settings-page-ids";

export {
  companionAccountActionError,
  companionPairingMode,
  loadCompanionBridgeState,
  shouldHydrateCompanionEmail,
};

export interface CompanionPanelStatus {
  label: string;
  good: boolean;
}

export interface TailscalePairingStatus {
  kind: "unchecked" | "unavailable" | "magicdns" | "ready" | "error";
  title: string;
  detail: string;
}

export function deriveTailscalePairingStatus(
  state: Pick<CompanionState, "enabled" | "tailscale" | "tailnetName" | "error">,
  routeAvailable: boolean,
): TailscalePairingStatus {
  if (state.error) {
    return {
      kind: "error",
      title: t("remote.status.attention"),
      detail: state.error,
    };
  }
  if (routeAvailable && state.tailnetName) {
    return {
      kind: "ready",
      title: t("remote.tailscale.ready", { name: state.tailnetName }),
      detail: t("remote.tailscale.readyDetail"),
    };
  }
  if (state.tailscale) {
    return {
      kind: "magicdns",
      title: t("remote.tailscale.magicDns"),
      detail: t("remote.tailscale.magicDnsDetail"),
    };
  }
  if (state.enabled) {
    return {
      kind: "unavailable",
      title: t("remote.tailscale.notConnected"),
      detail: t("remote.tailscale.notConnectedDetail"),
    };
  }
  return {
    kind: "unchecked",
    title: t("remote.tailscale.already"),
    detail: t("remote.tailscale.alreadyDetail"),
  };
}

export function pairingSurfaceCopy(
  route: Pick<PhoneSetupController, "localFallback" | "tailscaleFallback">,
): { title: string; subtitle: string } {
  if (route.tailscaleFallback) {
    return {
      title: t("remote.pairing.tailscale.title"),
      subtitle: t("remote.pairing.tailscale.subtitle"),
    };
  }
  if (route.localFallback) {
    return {
      title: t("remote.pairing.wifi.title"),
      subtitle: t("remote.pairing.wifi.subtitle"),
    };
  }
  return {
    title: t("remote.pairing.https.title"),
    subtitle: t("remote.pairing.https.subtitle"),
  };
}

export function deriveCompanionPanelStatus(
  state: Pick<CompanionState, "enabled" | "devices" | "error">,
): CompanionPanelStatus | null {
  if (state.error) return { label: t("remote.status.attention"), good: false };
  if (!state.enabled) return { label: t("remote.status.off"), good: false };
  const pairedCount = state.devices.length;
  if (!pairedCount) return null;
  return {
    label: `${pairedCount} ${pairedCount === 1 ? "device" : "devices"} paired`,
    good: true,
  };
}

export const relative = (at: number) => {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 90) return t("remote.time.justNow");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("remote.time.minutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("remote.time.hours", { count: hours });
  return t("remote.time.days", { count: Math.round(hours / 24) });
};

const endpointHost = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export function CompanionSection({ profileEmail = "", focusRequest = 0 }: { profileEmail?: string; focusRequest?: number }) {
  const c = usePhoneSetupController(profileEmail);
  const state = c.state;
  const pairingFlow = useRef<HTMLDivElement>(null);
  const revealed = useRef(0);
  const loaded = Boolean(state);
  const sub = useSubPage();
  const advancedPage = sub.at === PHONE_ADVANCED_PAGE;
  useEffect(() => {
    if (!focusRequest) revealed.current = 0;
    else if (revealed.current !== focusRequest && revealPhonePairing(pairingFlow.current)) revealed.current = focusRequest;
  }, [focusRequest, loaded]);
  const managedPolicy = useStore().state.config?.managedPolicy;
  const remoteBlocked = managedPolicy?.remoteAccess === false ? t("policy.remoteBlocked", { organization: managedPolicy.organizationName }) : null;
  const managedBy = managedPolicy?.remoteAccess === false ? t("policy.managedBy", { organization: managedPolicy.organizationName }) : null;

  if (!companionBridge()) return null;

  const advancedRow = (
    <SettingsRows>
      <NavRow data-panel-page={PHONE_ADVANCED_PAGE} pixel="sliders" title={t("settings.w6.phone.advanced")} onClick={() => sub.open(PHONE_ADVANCED_PAGE, t("settings.w6.phone.advanced"))} />
    </SettingsRows>
  );
  // while the computer's own link loads, the page is already the one it settles into: no row comes and goes above Advanced
  if (!state) return advancedPage ? null : <div className="flex flex-col gap-5"><PhonesList />{advancedRow}</div>;

  const accountActionError = companionAccountActionError(c.account, c.accountError);
  const tailscaleStatus = deriveTailscalePairingStatus(state, c.tailscaleAvailable);
  const hosted = state.endpoints?.find((endpoint) => endpoint.kind === "hosted");
  const localRoutes = [
    state.tailnetName ? { label: "Tailscale", value: `${state.tailnetName}:${state.port}` } : null,
    state.lan ? { label: t("remote.connection.wifi"), value: `${state.lan}:${state.port}` } : null,
    state.discovery?.name
      ? { label: t("remote.connection.discovery"), value: `${state.discovery.name}:${state.port}` }
      : null,
    ...(state.addresses ?? [])
      .filter((address) => address !== state.lan && address !== state.tailscale)
      .map((address, index) => ({
        label: t("remote.connection.localRoute", { index: index + 1 }),
        value: `${address}:${state.port}`,
      })),
  ].filter((route): route is { label: string; value: string } => Boolean(route));
  const accountStatus = c.account?.status === "ready"
    ? c.account.email ?? t("remote.account.yourAccount")
    : c.account?.status === "connecting"
      ? t("remote.account.connecting")
      : c.account?.status === "error"
        ? c.account.message ?? t("remote.account.error")
        : t("settings.w6.phone.signedOut");
  const problem = c.error ?? state.error;

  // the connection's own page: Pair over Tailscale or Wi-Fi draws the pairing flow here, above the rows, and goes to it
  if (advancedPage) {
    return (
      <div className="flex flex-col gap-5">
        {(c.localFallback || c.tailscaleFallback) && (
          <>
            <div ref={pairingFlow} tabIndex={-1} data-phone-pairing="computer" className="scroll-mt-4 rounded-[14px] focus:outline-none">
              <SettingsRows><PhoneSetupFlowView controller={c} /></SettingsRows>
            </div>
            {remoteBlocked && <p role="status" className="-mt-3 pl-3 text-[11px] leading-4 text-ink-tertiary">{remoteBlocked}</p>}
          </>
        )}
        <SettingsRows>
          <SettingRow title={t("remote.title")}>
            <Switch
              checked={state.enabled}
              aria-label={t("remote.title")}
              disabled={c.busy || (Boolean(remoteBlocked) && !state.enabled)}
              onClick={() => void c.act((companion) => (state.enabled ? companion.stop() : companion.start()))}
            />
          </SettingRow>
          <SettingRow title={t("remote.keepAwake")}>
            <Switch
              checked={state.keepAwake}
              aria-label={t("remote.keepAwakeAria")}
              disabled={c.busy || !state.enabled}
              onClick={() => void c.act((companion) => companion.keepAwake(!state.keepAwake))}
            />
          </SettingRow>
          {typeof window !== "undefined" && window.duskDesktop?.platform === "win32" && Boolean(companionBridge()?.keepScreenOn) && (
            <SettingRow title={t("remote.keepScreenOn")} subtitle={t("remote.keepScreenOnHint")}>
              <Switch
                checked={state.keepScreenOn === true}
                aria-label={t("remote.keepScreenOnAria")}
                disabled={c.busy || !state.enabled || !state.keepAwake}
                onClick={() => void c.act((companion) => companion.keepScreenOn!(!(state.keepScreenOn === true)))}
              />
            </SettingRow>
          )}
          <SettingRow title={t("settings.w6.phone.tailscale")} subtitle={<span aria-live="polite">{tailscaleStatus.title}</span>}>
            {tailscaleStatus.kind === "ready" ? (
              <button
                type="button"
                disabled={c.busy || c.accountBusy || Boolean(managedBy)}
                title={managedBy ?? undefined}
                onClick={() => {
                  c.useTailscale();
                  window.requestAnimationFrame(() => {
                    pairingFlow.current?.scrollIntoView({ block: "start" });
                    pairingFlow.current?.focus({ preventScroll: true });
                  });
                }}
                className="ui-button"
              >
                {t("settings.w6.phone.pair")}
              </button>
            ) : (
              <button
                type="button"
                disabled={c.busy || c.accountBusy || (Boolean(managedBy) && !state.enabled)}
                title={managedBy ?? undefined}
                onClick={c.refreshTailscale}
                className="ui-button"
              >
                {c.busy ? t("common.checking") : state.enabled ? t("remote.checkAgain") : t("settings.w6.phone.check")}
              </button>
            )}
          </SettingRow>
          <SettingRow title={t("settings.w6.phone.wifi")}>
            <button type="button" disabled={c.busy || c.accountBusy} onClick={c.useLocal} className="ui-button">{t("settings.w6.phone.pair")}</button>
          </SettingRow>
          <SettingRow title={t("settings.w6.phone.account")} subtitle={accountStatus}>
            {c.account?.status === "error" && (
              <button type="button" disabled={c.accountBusy} onClick={c.retryAccount} className="ui-button">
                {c.accountBusy ? t("remote.account.retrying") : t("remote.account.retry")}
              </button>
            )}
            {(c.account?.status === "ready" || c.account?.status === "connecting" || c.account?.status === "error") && (
              <button type="button" disabled={c.accountBusy} onClick={() => void c.accountAct((remote) => remote.signOut())} className="ui-button">
                {t("remote.account.signOut")}
              </button>
            )}
          </SettingRow>
          {accountActionError && <NoteRow tone="danger">{accountActionError}</NoteRow>}
          {hosted && <ConnectionDetail label={t("remote.connection.secureRoute")} value={endpointHost(hosted.url)} />}
          {localRoutes.map((route) => <ConnectionDetail key={`${route.label}:${route.value}`} {...route} />)}
          {problem && <NoteRow tone="danger">{problem}</NoteRow>}
        </SettingsRows>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {c.phase !== "intro" && (
        <div ref={pairingFlow} tabIndex={-1} data-phone-pairing="computer" className="scroll-mt-4 rounded-[14px] focus:outline-none">
          <SettingsRows><PhoneSetupFlowView controller={c} /></SettingsRows>
        </div>
      )}
      {remoteBlocked && <p role="status" className="-mt-3 pl-3 text-[11px] leading-4 text-ink-tertiary">{remoteBlocked}</p>}

      {state.devices.length > 0 && (
        <SettingsGroup label={t("remote.devices.title")} block="paired-devices">
          {state.devices.map((device) => (
            <SettingsRows key={device.id}>
              <SettingRow icon="phone" title={device.name} subtitle={t("remote.devices.lastSeen", { when: relative(device.lastSeenAt) })}>
                <button
                  type="button"
                  disabled={c.busy}
                  onClick={() => void c.act((companion) => companion.revoke(device.id))}
                  aria-label={t("remote.devices.remove", { name: device.name })}
                  className="ui-button"
                >
                  {t("settings.w6.phone.remove")}
                </button>
              </SettingRow>
              <SettingRow icon="laptop" title={t("settings.w6.phone.computerView")}>
                <Switch
                  checked={device.cloudDesktopAccess}
                  aria-label={t("remote.devices.viewAria", { name: device.name })}
                  disabled={c.busy}
                  onClick={() => void c.act((companion) => companion.cloudDesktop(device.id, !device.cloudDesktopAccess))}
                />
              </SettingRow>
              <SettingRow icon="globe" title={t("settings.w6.phone.browserControl")}>
                <Switch
                  checked={device.browserControlAccess === true}
                  aria-label={t("remote.devices.browserAria", { name: device.name })}
                  disabled={c.busy}
                  onClick={() => void c.act((companion) => companion.browserControl(device.id, !device.browserControlAccess))}
                />
              </SettingRow>
            </SettingsRows>
          ))}
        </SettingsGroup>
      )}

      <PhonesList />

      {advancedRow}
    </div>
  );
}
