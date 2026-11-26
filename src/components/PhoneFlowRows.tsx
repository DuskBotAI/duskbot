import type { ReactNode } from "react";
import { PairingQr } from "./PairingQr";

import { Check, Loader2 } from "../icons";
import { t } from "@/lib/i18n";
import { relayUnavailableMessage, useRelayPairing } from "@/lib/phone-relay";
import { useStore } from "@/state/store";
import type { PhoneSetupController } from "./PhoneSetupFlow";
import { PixelIcon, type PixelIconName } from "./ui/PixelIcon";

const ROW = "flex min-h-12 flex-wrap items-center justify-between gap-x-5 gap-y-2 px-3.5 py-2.5";
const LABEL = "min-w-0 flex-1 basis-48";
const TITLE = "text-[13px] leading-[18px] tracking-[-0.08px] text-ink";
const SECONDARY = "text-[13px] leading-[18px] tracking-[-0.08px] text-ink-secondary";
export const FIELD = "h-8 w-56 max-w-full rounded-[10px] border border-transparent bg-menu px-3 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-transparent disabled:opacity-50";

/** One Grok row: a label, an optional short line under it, and what sits on the right. */
export function FlowRow({ title, detail, alert, icon, children }: { title: ReactNode; detail?: ReactNode; alert?: boolean; icon?: PixelIconName; children?: ReactNode }) {
  return (
    <div className={ROW}>
      {icon && <PixelIcon name={icon} size={24} className="-me-1 shrink-0" />}
      <div className={LABEL}>
        <div className={TITLE}>{title}</div>
        {detail && <div role={alert ? "alert" : undefined} className={SECONDARY}>{detail}</div>}
      </div>
      {children && <div className="ms-auto flex shrink-0 flex-wrap items-center justify-end gap-2">{children}</div>}
    </div>
  );
}

export const ErrorLine = ({ children }: { children: ReactNode }) => <p role="alert" className="px-3.5 pb-2.5 text-[13px] leading-[18px] text-danger">{children}</p>;

export const WifiRow = ({ c }: { c: PhoneSetupController }) => (
  <FlowRow title={t("settings.w6.phone.wifi")} detail={t("settings.w6.phone.wifiDetail")}>
    <button type="button" disabled={c.busy || c.accountBusy} onClick={c.useLocal} className="ui-button">{t("settings.w6.phone.useWifi")}</button>
  </FlowRow>
);

export function AnywhereUnavailableRows({ c }: { c: PhoneSetupController }) {
  const relayProblem = relayUnavailableMessage(c.relay);
  if (relayProblem) {
    return (
      <>
        <FlowRow title={t("phone.relay.title")} detail={relayProblem}>
          {c.relay?.status === "signed-out"
            ? <RelaySignInButton />
            : <button type="button" onClick={c.retryRelay} className="ui-button">{t("common.tryAgain")}</button>}
          <button type="button" onClick={c.cancel} className="ui-button">{t("phone.back")}</button>
        </FlowRow>
        <WifiRow c={c} />
      </>
    );
  }
  if (c.setupTimedOut) {
    return (
      <FlowRow title={t("phone.wifiSlow.title")} detail={t("phone.wifiSlow.detail")} alert>
        <button type="button" disabled={c.busy} onClick={c.useLocal} className="ui-button">{t("common.tryAgain")}</button>
        <button type="button" onClick={c.cancel} className="ui-button">{t("phone.back")}</button>
      </FlowRow>
    );
  }
  return (
    <FlowRow title={<span className="inline-flex items-center gap-2"><Loader2 size={13} className="animate-spin text-ink-secondary" />{t("phone.verifying.local")}</span>}>
      <button type="button" onClick={c.cancel} className="ui-button">{t("common.cancel")}</button>
    </FlowRow>
  );
}

/** The secure route through this computer's relay: one code with the relay and the wi-fi routes, then the phone. */
export function RelayPairingRows({ onCancel, onDone }: { onCancel: () => void; onDone: () => void }) {
  const pairing = useRelayPairing(true);
  if (pairing.paired) {
    return (
      <FlowRow title={<span className="inline-flex items-center gap-2"><Check size={14} className="text-success" />{t("phone.success.title")}</span>}>
        <button type="button" onClick={onDone} className="ui-button">{t("phone.success.done")}</button>
      </FlowRow>
    );
  }
  if (!pairing.offer) {
    return (
      <>
        <FlowRow title={<span className="inline-flex items-center gap-2">{!pairing.error && <Loader2 size={13} className="animate-spin text-ink-secondary" />}{t("phone.verifying.local")}</span>}>
          {pairing.error && <button type="button" onClick={() => void pairing.renew()} className="ui-button">{t("phone.signIn.retry")}</button>}
          <button type="button" onClick={onCancel} className="ui-button">{t("common.cancel")}</button>
        </FlowRow>
        {pairing.error && <ErrorLine>{pairing.error}</ErrorLine>}
      </>
    );
  }
  return (
    <>
      <FlowRow
        title={pairing.expired ? t("phone.code.expired") : t("settings.w6.phone.scan")}
        detail={pairing.expired ? undefined : t(pairing.offer.anywhere ? "phone.relay.anywhere" : "phone.relay.sameWifi")}
      >
        {pairing.expired && <button type="button" onClick={() => void pairing.renew()} className="ui-button">{t("settings.w6.phone.newCode")}</button>}
        <button type="button" onClick={onCancel} className="ui-button">{t("common.cancel")}</button>
      </FlowRow>
      {!pairing.expired && (
        <div className="flex justify-center px-3.5 pb-3">
          <div className="rounded-[10px] bg-white p-4 outline outline-[0.5px] -outline-offset-[0.5px] outline-transparent" aria-label={t("phone.code.qrAria")}>
            <PairingQr value={pairing.offer.qr} size={220} level="L" bgColor="#ffffff" fgColor="#000000" shapeRendering="crispEdges" />
          </div>
        </div>
      )}
      {!pairing.expired && pairing.offer.code && (
        <FlowRow title={t("phone.code.manual")} detail={t("phone.code.expiresIn", { seconds: pairing.secondsLeft })}>
          <span className="font-mono text-[15px] tracking-[0.12em] text-ink">{pairing.offer.code}</span>
        </FlowRow>
      )}
    </>
  );
}

function RelaySignInButton() {
  const { dispatch } = useStore();
  return <button type="button" onClick={() => dispatch({ type: "openCloudAdd", source: "app_settings", signIn: true })} className="ui-button">{t("phone.relay.signInAction")}</button>;
}
