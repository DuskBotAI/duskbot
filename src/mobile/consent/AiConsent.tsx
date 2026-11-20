import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { installAiConsentGate } from "@/lib/ai-consent-gate";
import { useStore } from "@/state/store";
import { useMobileAccount } from "../account/AccountGate";
import { ActiveConnection } from "../connection/active";
import { useConnections } from "../connection/connections";
import { haptic } from "../haptics";
import { PixelArt } from "../Illustration";
import { LEGAL_LINKS } from "../legal";
import { PRIMARY, QUIET } from "../onboarding/parts";
import { usePlatform } from "../platform";
import { Sheet } from "../Sheet";
import { aiProviders, consentCovers, consentKey, createConsentStore, type AiConsent } from "./ai-consent";

type ConsentContext = { consent: AiConsent | null; covered: boolean; open(): void };
const Context = createContext<ConsentContext | null>(null);
export const useAiConsent = () => useContext(Context);
const SheetSlot = createContext<ReactNode>(null);

/** Where the question shows: inside the phone's root, which carries its safe areas, scheme and styles. */
export function AiConsentSheet() {
  return useContext(SheetSlot);
}

/** Asks once, on this phone, before a message, a photo or a call reaches an AI, naming who gets them (App Store
 * guideline 5.1.2(i)). Without a yes the app still opens every chat and setting; sending asks again. */
export function AiConsentProvider({ children }: { children: ReactNode }) {
  const platform = usePlatform();
  const account = useMobileAccount();
  const connection = useContext(ActiveConnection) ?? "none";
  const { state } = useStore();
  const accountId = account?.account?.id ?? null;
  const store = useMemo(() => createConsentStore(platform.prefs, consentKey(accountId, connection)), [platform, accountId, connection]);
  const consent = useSyncExternalStore(store.subscribe, store.get, store.get);
  const loaded = useSyncExternalStore(store.subscribe, store.loaded, store.loaded);
  const providers = useMemo(() => aiProviders(state.bots, state.instances), [state.bots, state.instances]);
  const covered = consentCovers(consent, providers);
  const [open, setOpen] = useState(false);
  const retry = useRef<(() => void) | null>(null);
  const latest = useRef({ store, providers });
  latest.current = { store, providers };

  useEffect(() => installAiConsentGate({
    allowed: () => consentCovers(latest.current.store.get(), latest.current.providers),
    ask: (next) => { retry.current = next ?? null; setOpen(true); },
  }), []);
  // first run: the question comes up as soon as the bots are in, before anyone types
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || !loaded || !state.hydrated || consent) return;
    asked.current = true;
    setOpen(true);
  }, [loaded, state.hydrated, consent]);

  const close = useCallback(() => { retry.current = null; setOpen(false); }, []);
  const allow = async () => {
    haptic("success");
    await store.allow(providers);
    const held = retry.current;
    close();
    held?.();
  };
  const decline = async () => {
    haptic("pick");
    await store.decline();
    close();
  };
  const value = useMemo<ConsentContext>(() => ({ consent, covered, open: () => setOpen(true) }), [consent, covered]);

  return (
    <Context value={value}>
      <SheetSlot value={
        <Sheet open={open} onClose={() => { if (!consent) void decline(); else close(); }} title={t("mobile.consent.title")}>
          <ConsentBody providers={providers} covered={covered} onAllow={() => void allow()} onDecline={() => void decline()} onDone={close} />
        </Sheet>
      }>
        {children}
      </SheetSlot>
    </Context>
  );
}

function ConsentBody({ providers, covered, onAllow, onDecline, onDone }: { providers: string[]; covered: boolean; onAllow: () => void; onDecline: () => void; onDone: () => void }) {
  const platform = usePlatform();
  const { connections, activeId } = useConnections();
  const computer = connections.find((one) => one.id === activeId)?.label?.trim() || t("mobile.consent.yourComputer");
  const items = [
    t("mobile.consent.computer", { computer }),
    providers.length ? t("mobile.consent.ai", { providers: providers.join(", ") }) : t("mobile.consent.aiUnknown"),
    t("mobile.consent.apps"),
    t("mobile.consent.relay"),
  ];
  return (
    <div className="px-5 pb-4" data-ai-consent>
      <PixelArt name="key" size={52} className="mb-3 [@media(max-height:700px)]:hidden" />
      <p className="text-[16px] leading-6 text-ink">{t("mobile.consent.lead")}</p>
      <ul className="mt-3 flex flex-col gap-2.5">
        {items.map((item) => (
          <li key={item} className="flex gap-2.5 text-[15px] leading-[1.45] text-ink-secondary"><span aria-hidden className="mt-[9px] size-1.5 shrink-0 rounded-full bg-ink/40" />{item}</li>
        ))}
      </ul>
      <p className="mt-4 text-[14px] leading-5 text-ink-secondary">
        {t(covered ? "mobile.consent.onNote" : "mobile.consent.note")}{" "}
        <button type="button" className="underline underline-offset-2" onClick={() => void platform.openExternal(LEGAL_LINKS.privacy)}>{t("mobile.settings.privacy")}</button>
      </p>
      <div className="mt-6 flex flex-col gap-1">
        {covered ? <>
          <button type="button" className={PRIMARY} onClick={onDone}>{t("mobile.consent.done")}</button>
          <button type="button" className={cn(QUIET, "text-danger")} onClick={onDecline}>{t("mobile.consent.turnOff")}</button>
        </> : <>
          <button type="button" className={PRIMARY} onClick={onAllow}>{t("mobile.consent.allow")}</button>
          <button type="button" className={QUIET} onClick={onDecline}>{t("mobile.consent.decline")}</button>
        </>}
      </div>
    </div>
  );
}
