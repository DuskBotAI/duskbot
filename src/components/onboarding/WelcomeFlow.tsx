import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { setEmailGateDone, track } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import { chiefFor, chiefStepFits, createChiefPatch, myDefaultBot, stageIntro, useViewerEmail } from "@/lib/default-bot";
import { completionPatch, computerAiIds, firstRunPatch, markWelcomeFinished, resumeBeat, showWelcome, type BeatId } from "@/lib/onboarding";
import { clearWelcomeDraft, readWelcomeDraft, saveWelcomeDraft } from "@/lib/welcome-draft";
import { looksLikeIntake } from "@/lib/assistant-notes";
import { greetingName } from "../../../shared/greeting-name";
import { usePlaceSetupOpen } from "@/lib/place-setup";
import { api, useStore, type ModelSelection } from "@/state/store";
import { engineReady } from "@/components/EngineLibrary";
import { useNotesIntake } from "../NotesWaiting";
import { WindowDragStrip } from "../DesktopCapabilities";
import { AccountStep } from "./AccountStep";
import { AiStep } from "./AiStep";
import { BringStatus } from "./BringStep";
import { CheckoutStep } from "./CheckoutStep";
import { CloudBringStep, useCloudBringOffered } from "./CloudBringStep";
import { cloudOwned, foundPicks, freeModel, funnelSteps, nextStep, previousStep, type FunnelPath, type FunnelStep } from "./funnel";
import { useFreeWarmup } from "./free-warmup";
import { funnelAccount, type FunnelAccountState } from "./funnel-account";
import { FunnelBar, WelcomeStep } from "./FunnelSteps";
import { cloudOpenedHere } from "./late-cloud";
import { MakingStep } from "./MakingStep";
import { useWelcomeAi } from "./welcome-ai";
import { localDesktopPage } from "./WelcomeGate";
import "../../styles/onboarding.css";
import "../../styles/place-setup.css";

type Config = ReturnType<typeof useStore>["state"]["config"];

/** A genuine first run on this computer's own page names the person after its account, where their profile has none
 * (never on a Cloud, a Team Cloud or a remote page). The name stays theirs to change in Settings. */
async function nameFromComputer(config: Config, done: (config: NonNullable<Config>) => void): Promise<void> {
  const bridge = window.duskDesktop;
  if (!config || config.onboarding?.completedAt || config.profile?.name?.trim() || config.cloudHome || config.team) return;
  if (!localDesktopPage() || bridge?.remoteClient?.active) return;
  const name = await bridge?.desktopProfile?.systemName().catch(() => null);
  if (!name) return;
  try {
    done(await api<NonNullable<Config>>("/api/config", { method: "PUT", body: JSON.stringify({ profile: { name } }), signal: AbortSignal.timeout(10_000) }));
  } catch {
  }
}

export { cloudBought } from "./funnel";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Tab and Shift+Tab stay inside `root`, the way a modal dialog keeps them. */
export function trapTab(event: ReactKeyboardEvent<HTMLElement>, root: HTMLElement | null): void {
  if (event.key !== "Tab" || !root) return;
  const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
  if (!focusable.length) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/** The first run, two calm screens: the hello (the free model gets ready meanwhile), then one choice, free models or a
 * plan the person already has. It ends in Dusk's chat (Dusk made the Chief of Staff where no other bot is one), where Dusk
 * speaks first with three first jobs, and raises anything else (an account, dusk cloud, the phone, the Mac's
 * permissions, apps) when a job needs it. A run already on its way to dusk cloud keeps the browser checkout, the AI while
 * the Cloud is made, then the Cloud, ending in that Cloud's chat. */
export function WelcomeFlow({
  onDone,
  replay = false,
  initialBeat,
  embedded = false,
  cloudHome: onCloud = false,
}: {
  onDone: (botId: string | null) => void;
  replay?: boolean;
  initialBeat?: BeatId;
  embedded?: boolean;
  /** the person's own cloud, which runs this first run when the desktop app that set it up opened it */
  cloudHome?: boolean;
}) {
  const { state, dispatch, refreshInstances } = useStore();
  const maus = myDefaultBot(state.bots, useViewerEmail());
  const keepsDraft = !replay && !embedded;
  const root = useRef<HTMLDivElement>(null);
  const finishing = useRef(false);
  // "Use free models" is the person's own pick: Dusk and new bots stay on it even once another AI is ready
  const freePick = useRef<ModelSelection | null>(null);
  const record = useRef(state.config?.onboarding);
  record.current = state.config?.onboarding;

  // the account: asked once where this window can sign in; a step only for someone not signed in yet
  const account = useMemo(() => (embedded ? null : funnelAccount()), [embedded]);
  const [known, setKnown] = useState<FunnelAccountState | null>(null);
  const firstKnown = useRef<FunnelAccountState | null>(null);
  useEffect(() => {
    if (!account) return;
    let alive = true;
    const read = () => void account.state().then((next) => {
      if (!alive) return;
      firstKnown.current ??= next;
      setKnown(next);
    }, () => {});
    read();
    const stop = account.onChange(read);
    window.addEventListener("focus", read);
    return () => { alive = false; stop(); window.removeEventListener("focus", read); };
  }, [account]);
  const desktop = !embedded && localDesktopPage() && window.duskDesktop?.remoteClient?.active !== true;
  const draft = useMemo(() => (keepsDraft ? readWelcomeDraft() : null), [keepsDraft]);
  // where the bots live, once picked; a resumed dusk cloud run past its checkout is paid for (the AI or the Cloud being made)
  const [path, setPath] = useState<FunnelPath | null>(draft?.cloud === true ? "cloud" : null);
  const [paid, setPaid] = useState(draft?.cloud === true && (draft.beat === "ai" || draft.beat === "bring" || draft.beat === "making"));
  const [checkoutStart, setCheckoutStart] = useState(false);
  const cloud = path === "cloud";

  const cloudHome = !embedded && onCloud;
  const cloudBring = useCloudBringOffered(cloudHome && !replay);
  useFreeWarmup(state.instances, desktop && !replay);
  const [notesLine, setNotesLine] = useState<string | null>(null);

  const saved = initialBeat ?? draft?.beat;
  // the account is a step only where the install requires one; otherwise the chat asks once something needs it
  const accountStep = Boolean(account) && firstKnown.current?.required === true && !firstKnown.current.signedIn;
  const steps = funnelSteps({ account: accountStep, desktop, path, paid,
    hello: window.duskDesktop?.remoteClient?.active !== true, cloudBring, aiAsked: cloudHome && !replay });

  const [at, setAt] = useState<FunnelStep>(() => resumeBeat(steps, saved));
  // the second click of a double click lands on the step it opened: it must not choose there
  const stepShownAt = useRef(0);
  useEffect(() => { stepShownAt.current = Date.now(); }, [at]);
  const swallowDoubleClick = (event: { detail: number; preventDefault(): void; stopPropagation(): void }) => {
    if (event.detail < 2 || Date.now() - stepShownAt.current > 600) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const [from, setFrom] = useState<"next" | "back">("next");
  const tested = useWelcomeAi(state.instances);

  // each screen shown, with the path and how long the screen before it took: drop-off per step on the admin page
  const shownAt = useRef<number | null>(null);
  useEffect(() => {
    const now = Date.now();
    track("onboarding_step", { step: at, replay, ...(path ? { path } : {}), ...(shownAt.current !== null ? { ms: now - shownAt.current } : {}) });
    shownAt.current = now;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, replay]);
  useEffect(() => {
    if (keepsDraft && !finishing.current) saveWelcomeDraft({ beat: at, ...(cloud ? { cloud: true as const } : {}) });
  }, [at, keepsDraft, cloud]);

  // A Cloud sheet opened over the welcome never switches the window away from it (CloudAddDialog).
  useEffect(() => (embedded ? undefined : showWelcome()), [embedded]);
  useEffect(() => {
    if (!replay && !embedded) void nameFromComputer(state.config, (config) => dispatch({ type: "configStatus", config }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // each step's title takes focus, so a screen reader hears where it is
  useEffect(() => {
    const title = root.current?.querySelector<HTMLElement>("#welcome-title");
    if (title && !root.current?.querySelector("[autofocus]")) title.focus({ preventScroll: true });
    else if (!title) root.current?.focus({ preventScroll: true });
  }, [at]);

  const finish = useCallback(
    async (reason: "completed" | "skipped", botId: string | null) => {
      if (finishing.current) return;
      finishing.current = true;
      track("onboarding_completed", { reason, at, replay, ...(path ? { path } : {}) });
      setEmailGateDone("submitted");
      if (!replay && !embedded) markWelcomeFinished();
      if (keepsDraft) clearWelcomeDraft();
      onDone(botId);
      try {
        const run = replay ? completionPatch() : cloudOpenedHere(firstRunPatch(record.current, new Date(), { cloudHome }), path === "cloud", record.current?.hintsSeen ?? []);
        const patch = freePick.current ? { ...run, defaultModelSelection: freePick.current } : run;
        const config = await api("/api/config", { method: "PUT", body: JSON.stringify(patch), signal: AbortSignal.timeout(10_000) });
        dispatch({ type: "configStatus", config });
      } catch {
      }
    },
    [at, path, dispatch, onDone, replay, embedded, keepsDraft, cloudHome],
  );

  // where it fits, Dusk becomes the Chief of Staff and greets in its chat, with no screen to ask
  const toChat = useCallback(() => {
    if (finishing.current) return;
    const chief = Boolean(maus && chiefStepFits(state.bots, maus));
    if (chief && maus) dispatch({ type: "updateBot", botId: maus.id, patch: createChiefPatch(maus, chiefFor(state.bots, maus)) });
    if (maus && freePick.current) dispatch({ type: "updateBot", botId: maus.id, patch: { modelSelection: freePick.current } });
    const botId = chief ? maus!.id : null;
    if (botId && !replay) stageIntro(botId);
    void finish(botId ? "completed" : "skipped", botId);
  }, [maus, state.bots, dispatch, finish, replay]);

  const go = useCallback((step: FunnelStep | null, direction: "next" | "back") => {
    if (!step) { if (direction === "next") toChat(); return; }
    setFrom(direction);
    setAt(step);
  }, [toChat]);
  const next = useCallback(() => go(nextStep(steps, at), "next"), [go, steps, at]);
  const back = previousStep(steps, at, { paid });


  const placeSheet = usePlaceSetupOpen();
  const cloudPaid = useCallback(() => {
    track("onboarding_cloud", { action: "bought" });
    setPaid(true);
    setFrom("next");
    setAt("ai");
  }, []);

  // an account that already has dusk cloud (bought on the website, or earlier) goes on as if its checkout had just
  // completed: the AI, then its Cloud being made
  const cloudAccount = desktop && !replay ? window.duskDesktop?.cloudAccount : undefined;
  const [owned, setOwned] = useState(false);
  useEffect(() => {
    if (!cloudAccount || paid) return;
    let alive = true;
    const seen = (next: Parameters<typeof cloudOwned>[0]) => { if (alive && cloudOwned(next)) setOwned(true); };
    void cloudAccount.state().then(seen, () => {});
    const stop = cloudAccount.onState(seen);
    return () => { alive = false; stop(); };
  }, [cloudAccount, paid]);
  useLayoutEffect(() => {
    if (!owned || paid || at === "making") return;
    track("onboarding_cloud", { action: "owned" });
    setPath("cloud");
    setPaid(true);
    if (at === "checkout") { setFrom("next"); setAt("ai"); }
  }, [owned, paid, at]);
  // this Mac, from the browser's waiting screen or the website's pick: on to the AI choice
  const toMac = () => {
    setPath("mac");
    setCheckoutStart(false);
    setFrom("next");
    if (steps.includes("ai")) setAt("ai"); else toChat();
  };

  // signing in in the browser comes back here by itself. A new account first takes the website's own first steps (name,
  // plan) and this step waits on them; then the app carries on from what was picked there: this computer goes past the
  // place, a plan waits on its checkout here, and a paid one skips both (owned, above)
  const signedOutSeen = useRef(false);
  const websiteSeen = useRef(false);
  useEffect(() => {
    if (at !== "account" || !known) return;
    if (!known.signedIn) { signedOutSeen.current = true; return; }
    if (known.website === "open") { websiteSeen.current = true; return; }
    if (!signedOutSeen.current && !websiteSeen.current) return;
    signedOutSeen.current = false;
    const picked = websiteSeen.current && desktop ? known.website : undefined;
    websiteSeen.current = false;
    if (picked === "free") { track("onboarding_place", { choice: "mac", via: "website" }); toMac(); return; }
    if (picked === "cloud" && window.duskDesktop?.cloudAccount) {
      track("onboarding_place", { choice: "cloud", via: "website" });
      setPath("cloud");
      setCheckoutStart(false);
      setFrom("next");
      setAt("checkout");
      return;
    }
    next();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, known, next]);

  // notes from another AI pasted on any step come in from here too (the bring step takes them itself, and says so there)
  const takeNotes = useNotesIntake();
  const onPaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    const pasted = event.clipboardData.getData("text/plain");
    if (!looksLikeIntake(pasted)) return;
    event.preventDefault();
    takeNotes(pasted, setNotesLine);
  };

  const overlayOpen = Boolean(placeSheet);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      if (event.defaultPrevented || overlayOpen) return;
      event.preventDefault();
      // Escape is "not now": past an optional step, never past an account the app needs
      if (at === "account" && known?.required) return;
      if (at === "welcome" || at === "account" || at === "checkout" || at === "making") return;
      next();
      return;
    }
    trapTab(event, root.current);
  };

  let body: ReactNode;
  switch (at) {
    case "welcome":
      body = <WelcomeStep onStart={next} cloud={cloudHome ? { name: greetingName(state.config?.profile?.name), picture: state.config?.profile?.avatarUrl || undefined } : undefined} />;
      break;
    case "account":
      body = account ? <AccountStep account={account} known={known}
        onDone={() => { track("onboarding_account", { action: "signed_in" }); next(); }}
        onSkip={known?.required ? null : () => { track("onboarding_account", { action: "skipped" }); next(); }} /> : null;
      break;
    case "checkout":
      body = <CheckoutStep start={checkoutStart} onPaid={cloudPaid} onMac={toMac} />;
      break;
    case "ai":
      body = <AiStep tested={tested} cloud={cloud} computerAis={cloudHome ? computerAiIds(state.config?.onboarding) : []} onNext={(how) => {
        track("onboarding_ai", { action: how });
        const free = how === "free" && !cloud ? freeModel(state.instances, engineReady) : undefined;
        freePick.current = free ? { instanceId: free.instanceId, model: free.models.default } : null;
        const picks = foundPicks(how, tested?.instance, state.instances, engineReady);
        if (!picks.length) { next(); return; }
        void Promise.allSettled(picks.map((instance) => api(`/api/instances/${encodeURIComponent(instance.instanceId)}`, { method: "PATCH", body: JSON.stringify({ chosen: true }), signal: AbortSignal.timeout(10_000) })))
          .then(() => refreshInstances().catch(() => {}))
          .finally(next);
      }} />;
      break;
    case "bring":
      body = <CloudBringStep onNext={next} />;
      break;
    case "making":
      body = <MakingStep onOpened={() => void finish("completed", null)} />;
      break;
  }

  const index = steps.indexOf(at);
  return (
    <div
      ref={root}
      role="dialog"
      aria-modal
      aria-labelledby="welcome-title"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onClickCapture={swallowDoubleClick}
      onPaste={onPaste}
      data-welcome={at}
      className={cn("welcome-screen flex overflow-y-auto bg-app outline-none", embedded ? "relative h-full w-full" : "fixed inset-y-0 left-[var(--rail-beside,0px)] right-0 z-50")}
    >
      {/* first, so the back button and every control after it stay clickable (styles.css) */}
      {!embedded && <WindowDragStrip />}
      {at !== "welcome" && steps.length > 1 && <FunnelBar at={index} count={steps.length} onBack={back ? () => go(back, "back") : null} />}
      <div key={at} data-from={from} className="place-step relative flex min-h-full w-full flex-col">
        {body}
      </div>
      {/* notes pasted from another AI say how they came in */}
      <BringStatus line={notesLine} />
    </div>
  );
}
