import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "motion/react";
import { Bell, CalendarClock, Check, FileText, Globe, KeyRound, LayoutDashboard, LifeBuoy, Lock, LogOut, Mail, Mic, MonitorX, MoreHorizontal, Palette, Pencil, Plug, Plus, RefreshCw, ShieldCheck, Trash2, UserPlus, UserRound, Hand, Server, Sparkles, X, ZoomIn } from "../../icons";
import { accountDashboardUrl } from "@/lib/account-dashboard";
import { cn } from "@/lib/cn";
import { useMenuMotion } from "@/components/MenuMotion";
import { photoSource } from "@/components/AvatarPicker";
import { useGroupYou } from "@/components/GroupAvatar";
import { UserAvatarArt, UserFace } from "@/components/UserAvatar";
import { newAvatarSeed, parseAccountAvatarUrl, parseUserAvatarChoice, plainAvatarChoice, type SyncedAccountFace, type UserAvatarChoice } from "../../../shared/user-avatar";
import { trackUpsell, watchUpsell } from "@/lib/cloud-upsell";
import { activeLocale, t } from "@/lib/i18n";
import { effectiveLanguage, setLanguageChoice, useLanguageChoice, usePageLanguage } from "@/lib/language-preference";
import { applySkinChoice, readSkinChoice, subscribeSkin, THEME_SKINS } from "@/lib/skins";
import { systemDialogs } from "@/lib/system-dialog";
import { systemMenu } from "@/lib/system-menu";
import { localeChoices } from "@/locales";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { useConnections } from "../connection/connections";
import { placeActions, usePlaces, type Place, type PlacesState, type PlaceStatus } from "../connection/places";
import { haptic, setHapticsEnabled, useHapticsEnabled } from "../haptics";
import { readTextSize, setTextSize, subscribeTextSize, TEXT_SIZES } from "../text-scale";
import { dur, ease, spring } from "../motion";
import { useMobileAccount } from "../account/AccountGate";
import { chooseAccountOrigin, environmentName, PREVIEW_ORIGIN, PRODUCTION_ORIGIN } from "../account/environment";
import { LEGAL_LINKS, supportMail } from "../legal";
import { useAiConsent } from "../consent/AiConsent";
import { WorkingDots } from "@/components/WorkingIndicator";
import { SIMPLE_BUTTONS } from "@/components/SettingsPrimitives";
import { VoiceInputSettings } from "@/components/VoiceInputSettings";
import { usePlatform } from "../platform";
import { useNativePush } from "../chrome";
import { closesOnBack, Sheet, SheetStack, StackPage } from "../Sheet";
import { SheetPush, useSheetPushSettled } from "../SheetPush";
import { NavStack } from "../NavStack";
import { useSystemControl } from "@/lib/system-control";
import { NotificationsSheet } from "./NotificationsSheet";
import { NotificationSettings } from "./NotificationSettings";
import { RoutinesSheet } from "./RoutinesSheet";
import { ConnectorsSheet } from "./ConnectorsSheet";
import { VaultSheet } from "./VaultSheet";
import { DeleteAccountPage } from "./DeleteAccountPage";
import { ConfirmPage } from "./ConfirmPage";
import { placeKind } from "../connection/connection-notice";
import { removePlace } from "../account/sign-out";
import { phoneIdentity, type PhoneIdentity } from "../account/identity";
import { SettingsRow, SettingsSection, SettingsSwitch } from "./SettingsRow";
import { UpdatesPage, WhatsNewPage } from "./UpdatesPage";
import { PixelArt } from "../Illustration";
import type { SheetPageProps } from "./registry";
import type { MobileConnectionRecord } from "../../../shared/mobile-link";

const APPEARANCES = ["system", THEME_SKINS.light, THEME_SKINS.dark] as const;

/** The account rows Settings shows. The account dashboard sells plans, so the store apps never link to it (App Store
 * guideline 3.1.1, Play payments policy); a phone on an account (its session, or a dusk cloud of it) signs out here, and
 * deletes the account with its session (App Store 5.1.1(v)). Log in leads only on a phone that links nothing; one with
 * only its own computers (they need no account) gets the dusk cloud sign-in lower down, apart from who it is. */
export function accountRows(input: { native: boolean; identity: PhoneIdentity; offered?: boolean }): { dashboard: boolean; signOut: boolean; deleteAccount: boolean; signIn: boolean; cloudSignIn: boolean } {
  const { identity } = input;
  const onAccount = identity.kind === "account" || identity.kind === "cloud";
  return {
    dashboard: !input.native, signOut: onAccount, deleteAccount: identity.kind === "account" && identity.session,
    signIn: Boolean(input.offered) && identity.kind === "none", cloudSignIn: Boolean(input.offered) && identity.kind === "computer",
  };
}

/** A label a person would recognise for where these bots live: never an address like 127.0.0.1:5331 or a URL. */
export function readableWorkspace(label: string | null | undefined): string | null {
  const value = label?.trim();
  if (!value) return null;
  if (/:\/\//.test(value) || /^\[?[0-9a-f:.]+\]?(:\d+)?$/i.test(value) || /^[\w.-]+:\d+$/.test(value) || /^localhost$/i.test(value)) return null;
  return value;
}

/** The header's two lines: the person's name, then the account's email, the dusk cloud, or the computer they're linked to. */
export function settingsIdentity(input: { name?: string | null; accountName?: string | null; identity: PhoneIdentity }): { title: string; subtitle: string } {
  const { identity } = input;
  const email = identity.kind === "account" ? identity.email.trim() : "";
  const title = input.accountName?.trim() || input.name?.trim() || email.split("@")[0] || t("mobile.settings.you");
  const subtitle = email
    || (identity.kind === "cloud" ? readableWorkspace(identity.name) ?? t("mobile.settings.cloudLinked") : "")
    || (identity.kind === "computer" ? t("mobile.settings.connectedTo", { name: readableWorkspace(identity.name) ?? t("mobile.connection.yourComputer") }) : "")
    || t("mobile.settings.onComputer");
  return { title, subtitle };
}

/** dusk cloud, as its own quiet card under the settings, only where the dashboard may be linked and the phone is not
 * already talking to a cloud */
function CloudCard({ onOpen }: { onOpen: () => void }) {
  const shown = useRef(false);
  useEffect(() => { if (!shown.current) { shown.current = true; trackUpsell("shown", "app_mobile"); } }, []);
  useEffect(() => watchUpsell("app_mobile"), []);
  return (
    <button type="button" onClick={() => { trackUpsell("click", "app_mobile"); onOpen(); }} className="mobile-press mx-4 mt-9 flex w-[calc(100%-32px)] items-center gap-4 rounded-[16px] bg-menu px-4 py-4 text-left">
      <PixelArt name="server" size={44} />
      <span className="min-w-0 flex-1">
        <span className="block text-balance text-[16px] font-semibold text-ink">{t("cloudUpsell.mobile")}</span>
        <span className="mt-0.5 block text-[14px] font-medium leading-5 text-ink-secondary">{t("cloudUpsell.mobileDetail")}</span>
      </span>
    </button>
  );
}

/** a failed charge, in one line: the cloud is stopped, and until when its data is kept. Update card only where the dashboard may be linked:
 * the store apps never link to where plans are paid (App Store 3.1.1, Play payments policy) */
export function PaymentLine({ payment, onUpdate }: { payment: { name: string; fixBy: number; trial?: true }; onUpdate: (() => void) | null }) {
  const date = new Intl.DateTimeFormat(activeLocale(), { dateStyle: "medium" }).format(new Date(payment.fixBy));
  return (
    <SettingsSection card>
      <div data-payment-notice="" className="flex items-center gap-3 px-4 py-3.5">
        <p role="status" className="min-w-0 flex-1 text-[15px] leading-5 text-ink">{t(payment.trial ? "cloudAccount.trialNotice" : "cloudAccount.paymentNotice", { name: payment.name, date })}</p>
        {onUpdate && <button type="button" onClick={onUpdate} className="mobile-press shrink-0 rounded-full bg-ink px-3.5 py-1.5 text-[15px] font-semibold text-app">{t(payment.trial ? "cloudHome.upgrade" : "cloudAccount.updateCard")}</button>}
      </div>
    </SettingsSection>
  );
}

type SettingsPage =
  | "avatar" | "language" | "textSize" | "voice" | "notifications" | "routines" | "connectors" | "vault" | "delete" | "signOut" | "removeComputer" | "updates" | "whatsNew"
  | { kind: "renamePlace"; place: Place }
  | { kind: "removePlace"; place: Place };

export function removePlaceCopy(place: Pick<Place, "name" | "target" | "kind" | "synced" | "accountComputer">): { heading: string; body: string } {
  const name = place.name.trim() || t("mobile.connection.yourComputer");
  if (place.target.kind === "computer") {
    return { heading: t("mobile.settings.removePlaceTitle", { name }), body: t("mobile.settings.removePlaceSyncedBody", { name }) };
  }
  if (place.accountComputer) {
    return { heading: t("mobile.settings.removePlaceTitle", { name }), body: t("mobile.settings.removePlaceAccountBody", { name }) };
  }
  if (place.kind !== "computer" && place.synced) {
    return { heading: t("mobile.settings.removeComputerTitle", { name }), body: t("mobile.settings.removeCloudBody", { name }) };
  }
  return { heading: t("mobile.settings.removeComputerTitle", { name }), body: t("mobile.settings.removeComputerBody", { name }) };
}

/** the computer on screen when it was paired with its own QR or code, which the account's sign-out never removes */
export function shownComputer(connections: readonly MobileConnectionRecord[], activeId: string | null): MobileConnectionRecord | null {
  const shown = connections.find((connection) => connection.id === activeId);
  return shown && placeKind(shown) === "computer" ? shown : null;
}
const SETTINGS_PAGES: readonly string[] = ["avatar", "language", "textSize", "voice", "notifications", "routines", "connectors", "vault", "updates", "whatsNew"];

/** Settings is a stack inside one sheet, as iOS Settings: the grouped list, and each page pushed over it with the
 * system's slide and edge swipe back. Notifications, routines, apps and the vault are the same pages the rest of the
 * app opens as sheets, drawn here as pages, so nothing in Settings leaves it. */
export const SettingsSheet: ComponentType<SheetPageProps<"settings">> = ({ sheet, open, onClose, onOpenSheet, onOpenChat }) => {
  const { state } = useStore();
  const account = useMobileAccount();
  const platform = usePlatform();
  const { connections, activeId } = useConnections();
  const placesState = usePlaces(state.connected === true);
  const computer = shownComputer(connections, activeId);
  const computerName = readableWorkspace(computer?.label) ?? t("mobile.connection.yourComputer");
  const keepsComputers = connections.some((connection) => placeKind(connection) === "computer");
  const identity = phoneIdentity({ account: account?.account, connections, activeId });
  const signsOut = identity.kind === "account" || identity.kind === "cloud";
  const [page, setPage] = useState<SettingsPage | null>(SETTINGS_PAGES.includes(sheet.page ?? "") ? sheet.page as SettingsPage : null);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) setPage(SETTINGS_PAGES.includes(sheet.page ?? "") ? sheet.page as SettingsPage : null);
    wasOpen.current = open;
  }, [open, sheet.page]);
  const nativePush = useNativePush();
  const lastPage = useRef<SettingsPage | null>(null);
  if (page) lastPage.current = page;
  const shownPage = nativePush ? (page ?? lastPage.current) : page;
  const pop = useCallback(() => setPage(null), []);
  const stack = useMemo(() => ({ back: pop }), [pop]);
  const stepsBackOnBack = !nativePush && page !== null;
  useEffect(() => {
    if (stepsBackOnBack) return closesOnBack(pop);
  }, [stepsBackOnBack, pop]);
  const pageProps = { open: true, onClose: pop, onOpenSheet, onOpenChat };
  const removeTarget = shownPage && typeof shownPage === "object" && shownPage.kind === "removePlace" ? shownPage.place : null;
  const removeCopy = removeTarget ? removePlaceCopy(removeTarget) : null;
  const shown = shownPage === "avatar" && account?.account ? <AvatarPage account={account.account} onSave={account.setAvatar} onDone={pop} />
    : shownPage === "notifications" ? <NotificationsSheet sheet={{ kind: "notifications" }} {...pageProps} />
    : shownPage === "routines" ? <RoutinesSheet sheet={{ kind: "routines" }} {...pageProps} />
    : shownPage === "connectors" ? <ConnectorsSheet sheet={{ kind: "connectors" }} {...pageProps} />
    : shownPage === "vault" ? <VaultSheet sheet={{ kind: "vault" }} {...pageProps} />
    : shownPage === "language" ? <LanguagePage />
    : shownPage === "textSize" ? <TextSizePage />
    : shownPage === "delete" && account?.account ? <DeleteAccountPage email={account.account.email} onDelete={account.deleteAccount} onCancel={pop} onDone={() => window.location.reload()} />
    : shownPage === "signOut" && account && signsOut ? <ConfirmPage title={t("accountGate.signOut")}
      heading={account.accounts.length > 1 && account.account ? t("mobile.settings.signOutAccountTitle", { email: account.account.email }) : t("mobile.settings.signOutTitle")}
      body={t(account.accounts.length > 1 ? "mobile.settings.signOutAccountBody" : keepsComputers ? "mobile.settings.signOutKeepsComputers" : "mobile.settings.signOutBody")}
      action={t("accountGate.signOut")} onConfirm={account.signOutOfPhone} onCancel={pop} />
    : shownPage === "removeComputer" && computer ? <ConfirmPage title={t("mobile.settings.removeComputer")} heading={t("mobile.settings.removeComputerTitle", { name: computerName })}
      body={t("mobile.settings.removeComputerBody", { name: computerName })} action={t("mobile.settings.removeComputerAction")}
      onConfirm={async () => { await removePlace(platform, computer.id); window.location.reload(); }} onCancel={pop} />
    : shownPage && typeof shownPage === "object" && shownPage.kind === "renamePlace" ? <RenamePlacePage key={shownPage.place.key} place={shownPage.place}
      onSave={async (name) => { const ok = await placesState.rename(shownPage.place, name); if (ok) pop(); return ok; }} onCancel={pop} />
    : removeTarget && removeCopy ? <ConfirmPage key={removeTarget.key} title={t("mobile.settings.removePlace")} heading={removeCopy.heading}
      body={removeCopy.body} action={t("mobile.settings.removeComputerAction")} errorMessage={t("mobile.settings.removePlaceError", { name: removeTarget.name })}
      onConfirm={async () => {
        const outcome = await placesState.remove(removeTarget);
        if (!outcome.ok) return false;
        if (outcome.reload) { window.location.reload(); return true; }
        pop();
        return true;
      }} onCancel={pop} />
    : shownPage === "updates" ? <UpdatesPage onClose={pop} />
    : shownPage === "whatsNew" ? <WhatsNewPage onClose={pop} />
    : shownPage === "voice" ? <Sheet open onClose={pop} title={t("settings.voice.title")}><div data-settings-look="simple" className={`flex flex-col gap-6 px-4 pt-2 ${SIMPLE_BUTTONS}`}><VoiceInputSettings /></div></Sheet>
    : null;
  const pageKey = typeof page === "string" ? page : page ? `${page.kind}:${page.place.key}` : null;
  const base = <StackPage open title={t("mobile.settings.title")} onClose={onClose}><SettingsList onClose={onClose} push={setPage} placesState={placesState} /></StackPage>;
  if (nativePush) {
    return (
      <Sheet open={open} onClose={onClose} full flush label={t("mobile.settings.title")} bodyClassName="overflow-hidden pt-0! pb-0">
        {base}
        <SheetPush open={Boolean(page && shown)} onClose={pop} bare>
          {shown && <SheetStack value={stack}>{shown}</SheetStack>}
        </SheetPush>
      </Sheet>
    );
  }
  return (
    <Sheet open={open} onClose={onClose} full flush label={t("mobile.settings.title")} bodyClassName="overflow-hidden pt-0! pb-0">
      <NavStack
        snappy
        base={base}
        page={shown && <SheetStack value={stack}>{shown}</SheetStack>}
        pageKey={pageKey}
        onBack={pop}
      />
    </Sheet>
  );
};

function SettingsList({ onClose, push, placesState }: { onClose: () => void; push: (page: SettingsPage) => void; placesState: PlacesState }) {
  const { state } = useStore();
  const { connections, activeId, switchTo } = useConnections();
  const you = useGroupYou();
  const platform = usePlatform();
  const account = useMobileAccount();
  const hapticsEnabled = useHapticsEnabled();
  const textSize = useSyncExternalStore(subscribeTextSize, readTextSize, () => "system" as const);
  const skin = useSyncExternalStore(subscribeSkin, readSkinChoice, () => "system");
  const language = effectiveLanguage(useLanguageChoice(), state.config?.language);
  usePageLanguage(language);
  const { places, expected, open: openPlace, payment } = placesState;
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const appearanceId = useId();
  const appearanceRef = useRef<HTMLDivElement>(null);
  const systemAppearance = useSystemControl(appearanceRef, {
    kind: "segmented",
    items: [t("mobile.settings.system"), t("mobile.settings.light"), t("mobile.settings.dark")],
    selected: Math.max(0, APPEARANCES.indexOf(skin as typeof APPEARANCES[number])),
    label: t("mobile.settings.appearance"),
  }, (index) => { if (typeof index === "number" && APPEARANCES[index]) { haptic("segment"); applySkinChoice(APPEARANCES[index]); } });
  const computer = shownComputer(connections, activeId);
  const who = phoneIdentity({ account: account?.account, connections, activeId });
  const email = who.kind === "account" ? who.email : undefined;
  const face = account?.account ?? you?.face ?? null;
  const identity = settingsIdentity({ name: state.config?.profile?.name, accountName: account?.account?.name, identity: who });
  const rows = accountRows({ native: platform.native, identity: who, offered: account?.offered });
  const consent = useAiConsent();
  const unread = state.notifications.filter((entry) => !entry.read).length;
  const environment = account ? environmentName(account.origin) : null;
  // seven taps on the version show the servers row, for testing a store build against the preview stack
  const taps = useRef<number[]>([]);
  const [serversShown, setServersShown] = useState(false);
  const [switching, setSwitching] = useState(false);
  const tapVersion = () => {
    const now = Date.now();
    taps.current = [...taps.current.filter((at) => now - at < 3_000), now];
    if (taps.current.length >= 7) { setServersShown(true); haptic("pick"); }
  };
  const switchServers = () => {
    if (!switching) { setSwitching(true); return; }
    chooseAccountOrigin(account?.origin === PREVIEW_ORIGIN ? PRODUCTION_ORIGIN : PREVIEW_ORIGIN);
    void (account?.signOutEverywhere() ?? Promise.resolve()).finally(() => window.location.reload());
  };

  const otherAccounts = account?.accounts.filter((one) => one.id !== account.account?.id) ?? [];
  const useAccount = async (id: string) => {
    haptic("pick");
    if (!(await account?.switchAccount(id))) { haptic("error"); setError(t("mobile.settings.workspaceError")); return; }
    const linked = [...connections].sort((a, b) => b.lastUsedAt - a.lastUsedAt).find((one) => one.account?.id === id);
    if (linked) { await switchTo(linked.id); return; }
    onClose();
    window.dispatchEvent(new Event("dusk:sign-in"));
  };

  const choosePlace = async (place: Place) => {
    if (opening || place.active) return;
    haptic("pick");
    setOpening(place.key);
    setError(null);
    try {
      const outcome = await openPlace(place);
      if (outcome === "paired") onClose();
      else if (outcome !== "switched") { haptic("error"); setError(outcome === "asleep" || outcome === "unavailable" ? t("mobile.settings.placeAsleepError", { name: place.name }) : t("mobile.settings.workspaceError")); }
    } catch {
      haptic("error");
      setError(t("mobile.settings.workspaceError"));
    } finally {
      setOpening(null);
    }
  };

  const renamePlace = (place: Place) => {
    const dialogs = systemDialogs();
    if (!dialogs) { push({ kind: "renamePlace", place }); return; }
    void dialogs.form({
      title: t("mobile.settings.renamePlace"),
      saveLabel: t("mobile.settings.save"),
      cancelLabel: t("mobile.settings.cancel"),
      fields: [{
        id: "name",
        label: t("mobile.settings.placeName"),
        value: place.name,
        placeholder: t("mobile.settings.placeNamePlaceholder"),
        required: true,
        maxLength: 60,
        autoFocus: true,
      }],
      onSubmit: async ({ name }) => {
        const trimmed = (name ?? "").trim();
        if (!trimmed || trimmed === place.name) return null;
        const ok = await placesState.rename(place, trimmed).catch(() => false);
        return ok ? null : t("mobile.settings.renamePlaceError", { name: place.name });
      },
    });
  };

  const confirmRemovePlace = (place: Place) => {
    const dialogs = systemDialogs();
    if (!dialogs) { push({ kind: "removePlace", place }); return; }
    const copy = removePlaceCopy(place);
    void dialogs.alert({
      title: copy.heading,
      message: copy.body,
      confirmLabel: t("mobile.settings.removeComputerAction"),
      cancelLabel: t("mobile.settings.cancel"),
      tone: "danger",
    }).then(async (choice) => {
      if (choice !== "confirm") return;
      const outcome = await placesState.remove(place).catch(() => ({ ok: false as const }));
      if (!outcome.ok) {
        haptic("error");
        void dialogs.alert({
          title: t("mobile.settings.removePlace"),
          message: t("mobile.settings.removePlaceError", { name: place.name }),
          confirmLabel: t("common.done"),
          singleAction: true,
        });
        return;
      }
      if (outcome.reload) window.location.reload();
    });
  };

  const confirmRemoveComputer = () => {
    haptic("tap");
    const dialogs = systemDialogs();
    if (!dialogs || !computer) { push("removeComputer"); return; }
    const name = readableWorkspace(computer.label) ?? t("mobile.connection.yourComputer");
    void dialogs.alert({
      title: t("mobile.settings.removeComputerTitle", { name }),
      message: t("mobile.settings.removeComputerBody", { name }),
      confirmLabel: t("mobile.settings.removeComputerAction"),
      cancelLabel: t("mobile.settings.cancel"),
      tone: "danger",
    }).then(async (choice) => {
      if (choice !== "confirm") return;
      await removePlace(platform, computer.id);
      window.location.reload();
    });
  };

  const confirmSignOut = () => {
    haptic("tap");
    const dialogs = systemDialogs();
    if (!dialogs || !account) { push("signOut"); return; }
    const keepsComputers = connections.some((connection) => placeKind(connection) === "computer");
    void dialogs.alert({
      title: account.accounts.length > 1 && account.account ? t("mobile.settings.signOutAccountTitle", { email: account.account.email }) : t("mobile.settings.signOutTitle"),
      message: t(account.accounts.length > 1 ? "mobile.settings.signOutAccountBody" : keepsComputers ? "mobile.settings.signOutKeepsComputers" : "mobile.settings.signOutBody"),
      confirmLabel: t("accountGate.signOut"),
      cancelLabel: t("mobile.settings.cancel"),
      tone: "danger",
    }).then(async (choice) => {
      if (choice !== "confirm") return;
      await account.signOutOfPhone();
    });
  };

  return (
    <div className="pb-6">
      <SettingsSection card>
        <div className="flex w-full items-center gap-4 px-4 py-3.5">
          {account?.account ? (
            <button
              type="button"
              data-settings-avatar=""
              aria-label={t("accounts.avatar.change")}
              onClick={() => { haptic("pick"); push("avatar"); }}
              className="mobile-press relative flex size-14 shrink-0 items-center justify-center rounded-full bg-ink/[0.07] text-[20px] font-semibold text-ink"
            >
              <span className="flex size-full items-center justify-center overflow-hidden rounded-full">
                {face ? <UserFace account={face} size={56} className="size-full" /> : you?.initials ?? <UserRound aria-hidden size={24} />}
              </span>
              <span aria-hidden className="absolute -bottom-0.5 -end-0.5 flex size-5 items-center justify-center rounded-full bg-menu text-ink-secondary shadow-sm ring-2 ring-card">
                <Pencil size={11} />
              </span>
            </button>
          ) : (
            <span className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-full bg-ink/[0.07] text-[20px] font-semibold text-ink">
              {face ? <UserFace account={face} size={56} className="size-full" /> : you?.initials ?? <UserRound aria-hidden size={24} />}
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[19px] font-semibold leading-6 tracking-[-0.01em] text-ink">{identity.title}</span>
            <span data-settings-identity className="block truncate text-[14px] text-ink-secondary">{identity.subtitle}</span>
          </span>
        </div>
        {rows.dashboard && <SettingsRow icon={<LayoutDashboard />} label={t("mobile.settings.accountDashboard")} onClick={() => void accountDashboardUrl().then((url) => platform.openExternal(url))} />}
        {rows.signIn && <SettingsRow icon={<UserRound />} label={t("mobile.entry.signIn")} detail={t("mobile.settings.signInDetail")} onClick={() => { onClose(); window.dispatchEvent(new Event("dusk:sign-in")); }} />}
        {otherAccounts.map((other) => (
          <SettingsRow key={other.id} icon={<UserFace account={other} size={24} className="size-6 rounded-full" />} label={other.name?.trim() || other.email} detail={other.name?.trim() ? other.email : t("mobile.settings.otherAccount")} onClick={() => void useAccount(other.id)} />
        ))}
        {account?.account && account.offered && <SettingsRow icon={<UserPlus />} label={t("mobile.settings.addAccount")} onClick={() => { haptic("pick"); onClose(); window.dispatchEvent(new Event("dusk:add-account")); }} />}
      </SettingsSection>

      {payment && <PaymentLine payment={payment} onUpdate={rows.dashboard ? () => void accountDashboardUrl().then((url) => platform.openExternal(url)) : null} />}

      <SettingsSection card title={t("mobile.settings.workspaces")} hint={error ? <span role="alert" className="text-danger">{error}</span> : email ? t("mobile.settings.workspacesHint") : undefined}>
        {(places === null || places.length > 0) && (
          <PlacesList
            places={places}
            expected={expected}
            opening={opening}
            onChoose={(place) => { void choosePlace(place); }}
            onRename={renamePlace}
            onRemove={confirmRemovePlace}
          />
        )}
        <SettingsRow icon={<Plus />} label={t("mobile.settings.addPlace")} onClick={() => { haptic("pick"); onClose(); window.dispatchEvent(new Event("dusk:add-place")); }} />
      </SettingsSection>

      <SettingsSection card>
        <SettingsRow icon={<Bell />} label={t("mobile.settings.notifications")} value={unread || undefined} onClick={() => push("notifications")} />
        <NotificationSettings />
      </SettingsSection>

      <SettingsSection card title={t("mobile.settings.phone")}>
        <div role="group" aria-label={t("mobile.settings.appearance")} className="flex items-center gap-3 px-4 py-2">
          <Palette aria-hidden className="size-5 shrink-0 text-ink-secondary" />
          {systemAppearance ? <div ref={appearanceRef} aria-hidden="true" data-segmented-room="" className="h-9 flex-1" /> : <div className="flex flex-1 rounded-full bg-ink/[0.06] p-1" data-segmented="" style={{ "--seg-count": APPEARANCES.length, "--seg-index": Math.max(0, APPEARANCES.indexOf(skin as typeof APPEARANCES[number])) } as CSSProperties}>
            {([{ choice: "system", label: t("mobile.settings.system") }, { choice: THEME_SKINS.light, label: t("mobile.settings.light") }, { choice: THEME_SKINS.dark, label: t("mobile.settings.dark") }] as const).map(({ choice, label }) => (
              <button key={choice} type="button" aria-pressed={skin === choice} onClick={() => { haptic("segment"); applySkinChoice(choice); }} className="mobile-press relative flex min-h-10 flex-1 items-center justify-center rounded-full px-2 text-[15px] font-semibold">
                {skin === choice && <motion.span aria-hidden data-segmented-pill="" layoutId={`${appearanceId}-selection`} className="absolute inset-0 rounded-full bg-app shadow-sm [:root[data-skin=grok-dark]_&]:bg-ink/[0.16]" transition={spring.settle} />}
                <span className={skin === choice ? "relative text-ink" : "relative text-ink-secondary"}>{label}</span>
              </button>
            ))}
          </div>}
        </div>
        <SettingsSwitch icon={<Hand />} label={t("mobile.settings.haptics")} checked={hapticsEnabled} onChange={(enabled) => { setHapticsEnabled(enabled); haptic("toggle"); }} />
        <SettingsRow icon={<Mic />} label={t("settings.voice.title")} onClick={() => push("voice")} />
        <SettingsRow icon={<ZoomIn />} label={t("mobile.settings.textSize")} value={t(`mobile.settings.textSize.${textSize}`)} onClick={() => push("textSize")} />
        <SettingsRow icon={<Globe />} label={t("mobile.settings.language")} value={localeChoices.find((choice) => choice.code === language)?.label ?? t("mobile.settings.system")} onClick={() => push("language")} />
      </SettingsSection>

      <SettingsSection card title={t("mobile.settings.bots")}>
        <SettingsRow icon={<CalendarClock />} label={t("mobile.settings.routines")} onClick={() => push("routines")} />
        <SettingsRow icon={<Plug />} label={t("mobile.settings.connectors")} onClick={() => push("connectors")} />
        <SettingsRow icon={<KeyRound />} label={t("mobile.settings.vault")} onClick={() => push("vault")} />
      </SettingsSection>

      {consent && (
        <SettingsSection card title={t("mobile.settings.privacyTitle")}>
          <SettingsRow icon={<ShieldCheck />} label={t("mobile.settings.aiSharing")} value={t(consent.covered ? "mobile.settings.aiSharingOn" : "mobile.settings.aiSharingOff")} onClick={() => { onClose(); consent.open(); }} />
        </SettingsSection>
      )}

      <SettingsSection card title={t("mobile.settings.about")}>
        <SettingsRow icon={<RefreshCw />} label={t("settings.updates.check")} onClick={() => push("updates")} />
        <SettingsRow icon={<Sparkles />} label={t("whatsNew.title")} onClick={() => push("whatsNew")} />
        <SettingsRow icon={<LifeBuoy />} label={t("mobile.settings.help")} onClick={() => void platform.openExternal(LEGAL_LINKS.help)} />
        <SettingsRow icon={<Mail />} label={t("mobile.settings.contact")} onClick={() => void platform.openExternal(supportMail(t("mobile.settings.contactSubject")))} />
        <SettingsRow icon={<Lock />} label={t("mobile.settings.privacy")} onClick={() => void platform.openExternal(LEGAL_LINKS.privacy)} />
        <SettingsRow icon={<FileText />} label={t("mobile.settings.terms")} onClick={() => void platform.openExternal(LEGAL_LINKS.terms)} />
      </SettingsSection>
      {(serversShown || environment) && platform.native && (
        <SettingsSection card>
          <SettingsRow icon={<Server />} label={t("mobile.settings.servers")} detail={t(switching ? "mobile.settings.serversConfirm" : "mobile.settings.serversHint")}
            value={environment ?? "dusk.bot"} onClick={switchServers} />
        </SettingsSection>
      )}
      {rows.cloudSignIn && (
        <SettingsSection card>
          <SettingsRow icon={<UserRound />} label={t("mobile.settings.cloudSignIn")} detail={t("mobile.settings.signInDetail")} onClick={() => { onClose(); window.dispatchEvent(new Event("dusk:sign-in")); }} />
        </SettingsSection>
      )}
      {(rows.signOut || computer) && (
        <SettingsSection card>
          {computer && <SettingsRow icon={<MonitorX />} label={t("mobile.settings.removeComputer")} chevron={false} onClick={confirmRemoveComputer} />}
          {rows.signOut && <SettingsRow icon={<LogOut />} label={t("accountGate.signOut")} chevron={false} onClick={confirmSignOut} />}
        </SettingsSection>
      )}
      {rows.dashboard && !state.config?.cloudHome && <CloudCard onOpen={() => void accountDashboardUrl().then((url) => platform.openExternal(url))} />}
      {rows.deleteAccount && (
        <button type="button" data-settings-delete-account onClick={() => { haptic("tap"); push("delete"); }} className="mx-auto mt-4 block min-h-11 px-4 text-center text-[13px] text-danger">
          {t("mobile.settings.deleteAccount")}
        </button>
      )}
      <button type="button" onClick={tapVersion} className="mx-auto mt-6 block min-h-11 px-4 text-center text-[13px] text-ink-tertiary">
        {environment ? t("mobile.settings.versionOn", { version: platform.appVersion, environment }) : t("mobile.settings.version", { version: platform.appVersion })}
      </button>
    </div>
  );
}

function TextSizePage() {
  const size = useSyncExternalStore(subscribeTextSize, readTextSize, () => "system" as const);
  return (
    <Sheet open onClose={() => {}} title={t("mobile.settings.textSize")}>
      <p data-text-size-sample="" className="mx-4 mb-4 rounded-[19px] bg-ink/[0.05] px-[14px] py-2 text-[17px] font-[450] leading-[22px] text-ink">{t("mobile.settings.textSize.sample")}</p>
      <SettingsSection card>
        {TEXT_SIZES.map((choice) => (
          <button key={choice} type="button" aria-pressed={size === choice} onClick={() => { haptic("pick"); setTextSize(choice); }} className="mobile-row flex min-h-[52px] w-full items-center gap-3 px-4 py-2 text-left text-[16px] font-medium text-ink">
            <span className="min-w-0 flex-1">{t(`mobile.settings.textSize.${choice}`)}</span>
            {size === choice && <Check aria-hidden size={20} />}
          </button>
        ))}
      </SettingsSection>
    </Sheet>
  );
}

const AVATAR_SUGGESTIONS = 5;

function AvatarPage({ account, onSave, onDone }: {
  account: { id: string; email: string; avatarUrl?: string; avatar?: string };
  onSave: (choice: UserAvatarChoice | null) => Promise<"saved" | "signed-out" | "failed">;
  onDone: () => void;
}) {
  const { state, dispatch } = useStore();
  const saved = parseUserAvatarChoice(account.avatar);
  const hasPhoto = Boolean(account.avatarUrl);
  const start = plainAvatarChoice(saved, hasPhoto);
  const [choice, setChoice] = useState<UserAvatarChoice | null>(start);
  const [suggested] = useState(() => Array.from({ length: AVATAR_SUGGESTIONS }, () => newAvatarSeed()));
  const [rolled, setRolled] = useState<string | null>(saved?.startsWith("g:") && !suggested.includes(saved.slice(2)) ? saved.slice(2) : null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const source = photoSource(account.avatarUrl);
  const previewAccount = { id: account.id, ...(account.avatarUrl ? { avatarUrl: account.avatarUrl } : {}), ...(choice ? { avatar: choice } : {}) };
  const swatches: { key: string; choice: UserAvatarChoice | null; seed: string; label: string }[] = [
    { key: "default", choice: hasPhoto ? "drawn" : null, seed: account.id, label: t("accounts.avatar.default") },
    ...(rolled ? [{ key: `g:${rolled}`, choice: `g:${rolled}` as const, seed: rolled, label: t("accounts.avatar.rolled") }] : []),
    ...suggested.slice(0, rolled ? AVATAR_SUGGESTIONS - 1 : AVATAR_SUGGESTIONS).map((seed, index) => ({ key: `g:${seed}`, choice: `g:${seed}` as const, seed, label: t("accounts.avatar.suggestion", { n: index + 1 }) })),
  ];
  const pick = (next: UserAvatarChoice | null) => { haptic("pick"); setChoice(next); setError(false); };
  const shuffle = () => { const seed = newAvatarSeed(); setRolled(seed); pick(`g:${seed}`); };
  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(false);
    haptic("tap");
    const outcome = await onSave(choice).catch(() => "failed" as const);
    if (outcome !== "saved") { haptic("error"); setError(true); setSaving(false); return; }
    if (!state.config?.team && state.config?.profile?.accountFace?.id === account.id) {
      const avatarUrl = parseAccountAvatarUrl(account.avatarUrl);
      const nextFace: SyncedAccountFace = { id: account.id, email: account.email, ...(avatarUrl ? { avatarUrl } : {}), ...(choice ? { avatar: choice } : {}) };
      void api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ profile: { accountFace: nextFace } }) })
        .then((config) => { if (config) dispatch({ type: "configStatus", config }); })
        .catch(() => {});
    }
    haptic("success");
    onDone();
  };
  return (
    <Sheet open onClose={saving ? () => {} : onDone} title={t("accounts.avatar.title")}>
      <div className="flex flex-col gap-5 px-4 pb-6 pt-3">
        <div className="flex flex-col items-center gap-3 py-2">
          <span className="flex size-24 items-center justify-center overflow-hidden rounded-full inset-ring inset-ring-ink/[0.08]">
            <UserFace account={previewAccount} size={96} className="size-full" />
          </span>
          <button type="button" data-avatar-shuffle="" disabled={saving} onClick={shuffle} className="mobile-press flex min-h-10 items-center gap-1.5 rounded-full bg-ink/[0.07] px-4 text-[15px] font-medium text-ink disabled:opacity-40">
            <RefreshCw size={15} aria-hidden />
            {t("accounts.avatar.shuffle")}
          </button>
        </div>
        <div role="group" aria-label={t("accounts.avatar.suggestions")} className="grid grid-cols-6 gap-2 rounded-[16px] bg-menu p-3">
          {swatches.map((swatch) => {
            const on = choice === swatch.choice;
            return (
              <button key={swatch.key} type="button" aria-label={swatch.label} aria-pressed={on} data-avatar-swatch={swatch.key} disabled={saving}
                onClick={() => pick(swatch.choice)}
                className={cn("mobile-press flex aspect-square items-center justify-center rounded-full disabled:opacity-40", on && "bg-ink/[0.08] inset-ring-2 inset-ring-ink/35")}>
                <UserAvatarArt seed={swatch.seed} size={36} />
              </button>
            );
          })}
        </div>
        {account.avatarUrl && (
          <button type="button" data-avatar-photo="" aria-pressed={choice === null} disabled={saving}
            onClick={() => pick(null)}
            className={cn("mobile-row flex min-h-[52px] w-full items-center gap-3 rounded-[16px] bg-menu px-4 py-2 text-left text-[16px] font-medium text-ink disabled:opacity-40", choice === null && "inset-ring-2 inset-ring-ink/25")}>
            <img src={account.avatarUrl} alt="" className="size-8 shrink-0 rounded-full object-cover" />
            <span className="min-w-0 flex-1 truncate">{t(source === "google" ? "accounts.avatar.photoGoogle" : source === "x" ? "accounts.avatar.photoX" : "accounts.avatar.photo")}</span>
            {choice === null && <Check aria-hidden size={20} />}
          </button>
        )}
        {error && <p role="alert" data-avatar-error="" className="px-1 text-[14px] leading-5 text-danger">{t("accounts.avatar.failed")}</p>}
        <button type="button" data-avatar-save="" disabled={saving || choice === start} onClick={() => void save()}
          className="mobile-press flex h-[50px] w-full items-center justify-center rounded-full bg-ink text-[16px] font-semibold text-app disabled:opacity-40">
          {t(saving ? "accounts.avatar.saving" : "accounts.avatar.save")}
        </button>
      </div>
    </Sheet>
  );
}

function LanguagePage() {
  const { state } = useStore();
  const language = effectiveLanguage(useLanguageChoice(), state.config?.language);
  return (
    <Sheet open onClose={() => {}} title={t("mobile.settings.language")}>
      <SettingsSection card>
        {[{ code: "", label: t("mobile.settings.system") }, ...localeChoices].map(({ code, label }) => (
          <button key={code} type="button" aria-pressed={language === code} onClick={() => { haptic("pick"); setLanguageChoice(code); }} className="mobile-row flex min-h-[52px] w-full items-center gap-3 px-4 py-2 text-left text-[16px] font-medium text-ink">
            <span className="min-w-0 flex-1">{label}</span>
            {language === code && <Check aria-hidden size={20} />}
          </button>
        ))}
      </SettingsSection>
    </Sheet>
  );
}

function RenamePlacePage({ place, onSave, onCancel }: { place: Place; onSave: (name: string) => Promise<boolean>; onCancel: () => void }) {
  const [name, setName] = useState(place.name);
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);
  const nameId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const settled = useSheetPushSettled();
  const trimmed = name.trim();
  useEffect(() => {
    if (!settled) return;
    inputRef.current?.focus({ preventScroll: true });
  }, [settled]);
  const cancel = () => {
    inputRef.current?.blur();
    onCancel();
  };
  const save = async () => {
    if (working || !trimmed) return;
    if (trimmed === place.name) { cancel(); return; }
    setWorking(true);
    setFailed(false);
    haptic("tap");
    const ok = await onSave(trimmed).catch(() => false);
    if (!ok) { haptic("error"); setFailed(true); setWorking(false); return; }
    inputRef.current?.blur();
    haptic("success");
  };
  return (
    <Sheet open onClose={working ? () => {} : cancel} title={t("mobile.settings.renamePlace")}>
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <SettingsSection card title={t("mobile.settings.placeName")}>
          <div className="flex min-h-[52px] items-center gap-2 px-4 py-2">
            <input
              ref={inputRef}
              id={nameId}
              type="text"
              data-rename-place-input=""
              aria-label={t("mobile.settings.placeName")}
              autoComplete="off"
              enterKeyHint="done"
              maxLength={60}
              disabled={working}
              value={name}
              placeholder={t("mobile.settings.placeNamePlaceholder")}
              onChange={(event) => { setName(event.target.value); setFailed(false); }}
              className="min-h-9 min-w-0 flex-1 border-0 bg-transparent text-[17px] font-medium text-ink outline-none placeholder:text-ink-tertiary"
            />
            {name.length > 0 && !working && (
              <button
                type="button"
                data-no-press=""
                aria-label={t("mobile.settings.clearName")}
                onClick={() => { setName(""); setFailed(false); inputRef.current?.focus(); }}
                className="mobile-press flex size-7 shrink-0 items-center justify-center rounded-full bg-ink/[0.08] text-ink-secondary"
              >
                <X size={14} aria-hidden />
              </button>
            )}
          </div>
        </SettingsSection>
        <div className="px-4 pt-4" aria-busy={working}>
          {failed && <p role="alert" className="mb-3 px-1 text-[14px] leading-5 text-danger">{t("mobile.settings.renamePlaceError", { name: place.name })}</p>}
          <div className="flex gap-2">
            <button type="button" disabled={working} onClick={cancel} className="mobile-press flex min-h-11 flex-1 items-center justify-center rounded-full bg-ink/[0.06] px-4 text-[15px] font-semibold text-ink">{t("mobile.settings.cancel")}</button>
            <button type="submit" data-rename-place-save="" disabled={working || !trimmed} className="mobile-press flex min-h-11 flex-1 items-center justify-center rounded-full bg-ink px-4 text-[15px] font-semibold text-app disabled:opacity-40">
              {working ? <WorkingDots size={4} /> : t("mobile.settings.save")}
            </button>
          </div>
        </div>
      </form>
    </Sheet>
  );
}

const DOT: Record<PlaceStatus, string> = {
  online: "bg-[var(--m-status-online,#34c759)] ring-[3px] ring-[var(--m-status-online-ring,rgb(52_199_89/0.18))]",
  asleep: "bg-ink/[0.28]",
  offline: "border-[1.5px] border-ink/[0.34] bg-transparent",
};
const ROW = "flex min-h-[52px] w-full items-center gap-3 px-4 py-2 text-left";
const ROW_WITH_MENU = "flex min-h-[52px] min-w-0 flex-1 items-center gap-3 py-2 pl-4 pr-1 text-left";

/** Every place on the account, each a status dot and its name. Until the list is in, skeleton rows of the same height
 * hold its place; the rows then fade in over them, so nothing below moves. */
function PlacesList({ places, expected, opening, onChoose, onRename, onRemove }: {
  places: Place[] | null;
  expected: number;
  opening: string | null;
  onChoose: (place: Place) => void;
  onRename: (place: Place) => void;
  onRemove: (place: Place) => void;
}) {
  const reduced = useReducedMotion();
  const drawnAtOnce = useRef(places !== null);
  if (!places) return (
    <div role="status" aria-label={t("mobile.settings.placesLoading")}>
      {Array.from({ length: Math.max(expected, 1) }, (_, index) => (
        <div key={index} aria-hidden className={ROW}>
          <span className="flex size-5 shrink-0 items-center justify-center"><span className="size-2 rounded-full bg-ink/[0.08]" /></span>
          <span className="h-4 rounded-full bg-ink/[0.06]" style={{ width: `${[46, 34, 40][index % 3]}%` }} />
        </div>
      ))}
    </div>
  );
  return (
    <motion.ul initial={drawnAtOnce.current ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reduced ? 0 : dur.base, ease: ease.out }}>
      {places.map((place) => (
        <li key={place.key} className="flex min-h-[52px] items-center">
          <PlaceRow
            place={place}
            working={opening === place.key}
            disabled={Boolean(opening)}
            onChoose={() => onChoose(place)}
            onRename={() => onRename(place)}
            onRemove={() => onRemove(place)}
          />
        </li>
      ))}
    </motion.ul>
  );
}

const STATUS_LABEL = { online: "mobile.settings.placeOnline", asleep: "mobile.settings.placeAsleep", offline: "mobile.settings.placeOffline" } as const;
const PLACE_MENU_W = 220;
const PLACE_MENU_H = 108;
const PLACE_MENU_MARGIN = 12;
const PLACE_MENU_GAP = 6;

function PlaceMenuButton({ place, disabled, onRename, onRemove }: { place: Place; disabled: boolean; onRename: () => void; onRemove: () => void }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const nativeBusy = useRef(false);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number; above: boolean } | null>(null);
  const menuMotion = useMenuMotion(open);
  const label = t("mobile.settings.placeActions", { name: place.name });

  const close = useCallback((refocus = false) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const show = () => {
    if (disabled) return;
    haptic("tap");
    const native = systemMenu();
    if (native && triggerRef.current) {
      if (nativeBusy.current) return;
      nativeBusy.current = true;
      void native(triggerRef.current.getBoundingClientRect(), [
        { key: "rename", label: t("mobile.settings.renamePlace"), symbol: "pencil" },
        { key: "remove", label: t("mobile.settings.removePlace"), symbol: "trash", danger: true, separated: true },
      ]).then((picked) => {
        if (picked === "rename") { haptic("pick"); onRename(); }
        else if (picked === "remove") { haptic("pick"); onRemove(); }
      }).finally(() => { nativeBusy.current = false; });
      return;
    }
    setOpen((was) => !was);
  };

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const box = triggerRef.current.getBoundingClientRect();
    const left = Math.min(Math.max(PLACE_MENU_MARGIN, box.right - PLACE_MENU_W), window.innerWidth - PLACE_MENU_W - PLACE_MENU_MARGIN);
    const below = box.bottom + PLACE_MENU_GAP;
    const aboveTop = box.top - PLACE_MENU_GAP - PLACE_MENU_H;
    const above = below + PLACE_MENU_H > window.innerHeight - PLACE_MENU_MARGIN && aboveTop >= PLACE_MENU_MARGIN;
    setCoords({ top: above ? aboveTop : Math.min(below, window.innerHeight - PLACE_MENU_H - PLACE_MENU_MARGIN), left, above });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']:not(:disabled)")?.focus({ preventScroll: true });
    const dismiss = () => close(false);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); } };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    const unback = closesOnBack(() => close(false));
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
      unback();
    };
  }, [open, coords, close]);

  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") { event.preventDefault(); close(true); return; }
    const rows = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)") ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (at + 1) % rows.length
      : event.key === "ArrowUp" ? (at - 1 + rows.length) % rows.length
      : event.key === "Home" ? 0
      : event.key === "End" ? rows.length - 1
      : null;
    if (next === null || rows.length === 0) return;
    event.preventDefault();
    rows[next]?.focus();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-place-menu=""
        data-no-press=""
        disabled={disabled}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={show}
        className="mobile-press -ml-1 mr-0.5 flex size-11 shrink-0 items-center justify-center rounded-full text-ink-secondary disabled:opacity-40"
      >
        <MoreHorizontal size={18} aria-hidden />
      </button>
      {typeof document !== "undefined" && menuMotion.shown && coords && createPortal(
        <div className={cn("dusk-mobile-overlay fixed inset-0 z-[75]", menuMotion.closing && "pointer-events-none")}>
          <div aria-hidden className="absolute inset-0" onClick={() => close(false)} />
          <div
            ref={menuRef}
            role="menu"
            aria-label={label}
            data-place-menu-popover=""
            {...menuMotion.exitProps}
            onKeyDown={onMenuKey}
            className={cn(menuMotion.className, "mobile-glass absolute overflow-hidden rounded-[16px] bg-menu py-1.5 shadow-[0_12px_40px_-8px_rgb(10_10_12/0.30)]")}
            style={{ left: coords.left, top: coords.top, width: PLACE_MENU_W, transformOrigin: `right ${coords.above ? "bottom" : "top"}` }}
          >
            <button
              type="button"
              role="menuitem"
              data-place-menu-item="rename"
              onClick={() => { haptic("pick"); close(false); onRename(); }}
              className="mobile-row flex h-[46px] w-full items-center gap-3 px-4 text-left text-[16px] text-ink"
            >
              <span className="min-w-0 flex-1 truncate">{t("mobile.settings.renamePlace")}</span>
              <Pencil size={16} aria-hidden className="shrink-0 opacity-80" />
            </button>
            <div role="separator" className="mx-3 my-1 h-px bg-ink/[0.08]" />
            <button
              type="button"
              role="menuitem"
              data-place-menu-item="remove"
              onClick={() => { haptic("pick"); close(false); onRemove(); }}
              className="mobile-row flex h-[46px] w-full items-center gap-3 px-4 text-left text-[16px] text-danger"
            >
              <span className="min-w-0 flex-1 truncate">{t("mobile.settings.removePlace")}</span>
              <Trash2 size={16} aria-hidden className="shrink-0 opacity-80" />
            </button>
          </div>
        </div>,
        document.querySelector(".dusk-mobile") ?? document.body,
      )}
    </>
  );
}

function PlaceRow({ place, working, disabled, onChoose, onRename, onRemove }: {
  place: Place;
  working: boolean;
  disabled: boolean;
  onChoose: () => void;
  onRename: () => void;
  onRemove: () => void;
}) {
  const hasMenu = placeActions(place).length > 0;
  const rowClass = hasMenu ? ROW_WITH_MENU : ROW;
  const content = <>
    <span aria-hidden className="flex size-5 shrink-0 items-center justify-center">
      <span data-place-status={place.status} className={`size-2 rounded-full transition-colors duration-200 ${DOT[place.status]}`} />
    </span>
    <span className={`min-w-0 flex-1 truncate text-[16px] text-ink ${place.active ? "font-semibold" : "font-medium"}`}>{place.name}</span>
    {working ? <WorkingDots size={3} /> : <span className="shrink-0 text-[15px] text-ink-secondary">{t(STATUS_LABEL[place.status])}</span>}
  </>;
  return (
    <>
      {place.active
        ? <div data-testid="mobile-place" aria-current="true" className={rowClass}>{content}</div>
        : <button type="button" data-testid="mobile-place" disabled={disabled} aria-busy={working || undefined} onClick={onChoose} className={`mobile-row ${rowClass} disabled:opacity-100`}>{content}</button>}
      {hasMenu && <PlaceMenuButton place={place} disabled={disabled} onRename={onRename} onRemove={onRemove} />}
    </>
  );
}
