import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Check, Download, LoaderCircle, Monitor } from "@/icons";
import meadow from "../art/p-meadow.webp";
import layers from "../art/wide-layers-plain.webp";
import { useCloud } from "../data/cloud";
import type { BillingInterval, PlanCatalog } from "../data/contracts";
import { bundleOf } from "../data/pricing";
import { useSession } from "../data/session";
import { api, FIXTURE } from "../lib/api";
import { navigate, useLocation } from "../lib/router";
import { planIntent } from "../lib/site";
import { DIRECT, Downloads, isDesktop, NOTE_DIRECT, trackDownload } from "../ui/Downloads";
import { detectOs, useReleaseState } from "../lib/downloads";
import { StretchPill } from "../ui/Digits";
import { SplitFrame } from "../ui/Frame";
import { Button, cx, Skeleton } from "../ui/kit";
import { Mascot, type MascotHandle } from "../ui/Mascot";
import type { SceneHandle, SceneMood } from "../ui/Scene";
import { points } from "./Billing";
import { CHECKOUT_SOON, trialAction } from "./cloud-offer";
import { track, trackOnboardingStep } from "../lib/analytics";
import { per, planSelection, teamSelection, type PaidPlan } from "./plan-sheet";
import { fromApp } from "../lib/from-app";
import { APP_LANDING_PATH, type WebsiteHome } from "../../../../shared/account-api";

const STEPS = ["name", "plan", "app"] as const;
type Step = (typeof STEPS)[number];
type Home = "cloud" | "free";

const SAVED = "dusk-onboarding-step";
const NAME_SKIPPED = "dusk-onboarding-name-skipped";
const CHECKOUT_OPENED = "dusk-onboarding-checkout-opened";
/** the end of the first steps for someone the desktop app sent: the way back to it */
const APP_DONE = `${APP_LANDING_PATH}?set=1`;
const isStep = (v: string | null): v is Step => (STEPS as readonly string[]).includes(v ?? "");
const LABELS = ["your name", "pick a home", "get the app"];

function Busy({ children }: { children: ReactNode }) {
  return <><LoaderCircle size={17} strokeWidth={2} className="spin" aria-hidden />{children}</>;
}

/** how far along: a rail that fills, and a small bot that rides its leading edge and hops when a step lands */
function Rail({ at, total }: { at: number; total: number }) {
  const rider = useRef<MascotHandle>(null);
  const last = at === total - 1;
  const part = (at + 1) / total;
  useEffect(() => { rider.current?.react("hop"); }, [at]);
  return (
    <div className="relative mb-10 h-2 rounded-full bg-track [overflow-x:clip]" role="progressbar" aria-valuemin={1} aria-valuemax={total} aria-valuenow={at + 1} aria-label={`step ${at + 1} of ${total}`}>
      <div className="h-full origin-left rounded-full bg-ink transition-transform duration-500 ease-[var(--ease-out)] motion-reduce:transition-none" style={{ transform: `scaleX(${part})` }} />
      <div className="pointer-events-none absolute inset-0 transition-transform duration-500 ease-[var(--ease-pop)] motion-reduce:transition-none" style={{ transform: `translateX(${part * 100}%)` }} aria-hidden>
        <span className="absolute -top-[30px] left-0 -translate-x-full"><Mascot ref={rider} body="tofu" color="pink" size={34} state={last ? "celebrate" : "happy"} /></span>
      </div>
    </div>
  );
}

/** both homes keep the same light card; the chosen one shows a filled dot, never a darker card */
function Dot({ on }: { on: boolean }) {
  return (
    <span aria-hidden className={cx("grid size-4 shrink-0 place-items-center rounded-full transition-colors duration-150 ease-[ease]", on ? "bg-ink-3" : "bg-track")}>
      <span className={cx("size-1.5 rounded-full bg-bg transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none", on ? "scale-100 opacity-100" : "scale-75 opacity-0")} />
    </span>
  );
}

/** dusk cloud first and chosen, its plans on a white track with one grey thumb that stretches between them; this
 * computer below it as the free way */
function PlanStep({ catalog, home, setHome, plan, setPlan }: { catalog: PlanCatalog; home: Home; setHome(h: Home): void; plan: PaidPlan; setPlan(p: PaidPlan): void }) {
  const cloud = home === "cloud";
  const plans = (["starter", "pro"] as const).flatMap((id) => { const b = bundleOf(catalog, id); return b ? [{ id, b }] : []; });
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">where your bots live</legend>
      <div className={cx("rounded-[22px] bg-card p-2", !cloud && "hover-card")}>
        <label htmlFor="home-cloud" className="focus-tint block cursor-pointer rounded-[16px]">
          <input id="home-cloud" type="radio" name="home" value="cloud" checked={cloud} onChange={() => setHome("cloud")} className="sr-only" />
          <span className="relative block overflow-hidden rounded-[16px]">
            <img src={meadow} alt="" width={800} height={354} className="h-[84px] w-full object-cover object-bottom" draggable={false} />
            {/* pro has its own scene, crossfading in over plus's meadow */}
            <img src={layers} alt="" width={800} height={354} className={cx("absolute inset-0 h-[84px] w-full object-cover object-bottom transition-opacity duration-300 ease-out motion-reduce:transition-none", plan === "pro" ? "opacity-100" : "opacity-0")} draggable={false} />
            <span className="absolute bottom-1 right-4" aria-hidden><Mascot body="kit" color="blue" size={44} state="working" still /></span>
          </span>
          <span className="flex items-center justify-between gap-3 px-3 pt-4">
            <span className="text-17 font-medium tracking-[-0.02em] text-ink">dusk cloud</span>
            <Dot on={cloud} />
          </span>
          <ul key={plan} className="plan-points-in flex flex-col gap-2 px-3 pb-2 pt-3">
            {points(plan, catalog).map((p) => (
              <li key={p} className="flex gap-2.5 text-14 leading-[1.45] text-ink-2">
                <Check size={17} strokeWidth={2} className="mt-0.5 shrink-0 text-good" aria-hidden />{p}
              </li>
            ))}
          </ul>
        </label>
        {cloud && (
          <div role="radiogroup" aria-label="plan" className="step-in relative mt-1 grid grid-cols-2 rounded-full bg-bg p-1">
            <StretchPill target={plan} className="bg-[color-mix(in_oklab,var(--ink)_5%,var(--bg))]" />
            {plans.map(({ id, b }) => {
              const on = plan === id;
              return (
                <button key={id} type="button" role="radio" aria-checked={on} data-stretch-key={id} onClick={() => setPlan(id)}
                  className={cx("relative inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3 text-13", on ? "font-medium text-ink" : "font-normal text-ink-2 hover-link")}>
                  {b.name.toLowerCase()} <span className="num">{per(b.monthly, "month", catalog).amount}/mo</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <label htmlFor="home-free" className={cx("focus-tint mt-2 flex cursor-pointer items-center gap-3.5 rounded-[18px] bg-card py-3.5 pe-5 ps-4", home !== "free" && "hover-card")}>
        <input id="home-free" type="radio" name="home" value="free" checked={home === "free"} onChange={() => setHome("free")} className="sr-only" />
        <Monitor size={20} strokeWidth={1.5} className="shrink-0 text-ink-3" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-15 font-medium text-ink">this computer</span>
          <span className="block text-13 leading-[1.4] text-ink-3">bots work while it's awake.</span>
        </span>
        <span className="num shrink-0 text-14 text-ink-2">free</span>
        <Dot on={home === "free"} />
      </label>
    </fieldset>
  );
}

const OS_WORD = { macos: "mac", windows: "windows", linux: "linux" } as const;
/** what to do once the file is down, for the computer it was for; windows shows its smartscreen page because the
 *  installer isn't code-signed yet, so that page is named before it shows */
export function nextSteps(os: keyof typeof OS_WORD, file: string | null, email: string | null): string[] {
  const it = file ?? "the file";
  const signIn = email ? `open dusk bot and sign in as ${email}. it picks up this account.` : "open dusk bot and sign in with this account.";
  if (os === "windows") return [`open ${it} from your downloads.`, "if windows says it protected your pc, choose more info, then run anyway.", signIn];
  if (os === "macos") return [`open ${it} and drag dusk bot into applications.`, "open it from applications. if your mac asks, choose open.", signIn.replace("open dusk bot and ", "")];
  return [`open ${it}. if it won't start, allow it to run as a program first.`, signIn.replace("open dusk bot and ", "")];
}

/** the last step for someone who signed up here: their computer's download as the one big button, what to do once it
 *  is down, the phone apps and other platforms below, and the dashboard as the quiet way on */
function AppStep({ bought, email, error, busy, big, back, onDone }: { bought: boolean; email: string | null; error: string | null; busy: string | null; big: string; back: ReactNode; onDone(): void }) {
  const release = useReleaseState();
  const [os] = useState(detectOs);
  const [got, setGot] = useState(false);
  const own = isDesktop(os) && release !== "soon" && DIRECT[os].href ? DIRECT[os] : null;
  const desktop = isDesktop(os) ? os : null;
  const dashboard = <Button variant={own ? "ghost" : "primary"} className={own ? "-me-2 !h-11 !px-2 !text-14" : cx("mt-5", big)} onClick={onDone} disabled={busy !== null}>{busy ? <Busy>opening</Busy> : "go to the dashboard"}</Button>;
  return (
    <div key="app" className="step-in">
      {bought && <p className="tag mb-4 !bg-lime !text-ink" role="status"><span className="live-dot text-good" data-live />your dusk cloud is being set up</p>}
      <h1 className="t-title">get the app.</h1>
      <p className="mt-3 text-16 text-ink-2">sign in with this account and make your first bot.</p>
      {own && desktop && (
        <div className="mt-6">
          <a href={own.href!} download="" onClick={() => { trackDownload(desktop, os); setGot(true); }} data-track="download_own"
            className={cx("press hover-primary inline-flex items-center justify-center gap-2 rounded-full bg-primary font-medium text-primary-ink", big)}>
            <Download size={17} strokeWidth={1.75} aria-hidden />{got ? "download again" : `download for ${OS_WORD[desktop]}`}
          </a>
          <p className="mt-2 px-1 text-13 text-ink-3">
            {NOTE_DIRECT[desktop]}
            {own.also?.href && <> · <a href={own.also.href} download="" onClick={() => { trackDownload(desktop, os); setGot(true); }} className="underline-offset-2 hover:text-ink hover:underline">{own.also.label}</a></>}
          </p>
          <div role="status">{got && (
            <ol aria-label="next" className="step-in mt-4 flex flex-col gap-2.5 rounded-[16px] bg-card px-4 py-3.5">
              {nextSteps(desktop, own.name, email).map((line, i) => (
                <li key={line} className="flex gap-3 text-14 leading-[1.45] text-ink-2"><span className="num w-3 shrink-0 font-medium text-ink">{i + 1}</span>{line}</li>
              ))}
            </ol>
          )}</div>
        </div>
      )}
      <div className={own ? "mt-5" : "mt-6"}><Downloads own={!own} /></div>
      {error && <p role="alert" className="mt-3 text-14 text-bad">{error}</p>}
      {own ? <div className="mt-2 flex items-center justify-between">{back ?? <span />}{dashboard}</div> : <>{dashboard}{back && <div className="mt-1">{back}</div>}</>}
    </div>
  );
}

/** the first minutes of an account, one step at a time: a name, where the bots live, the app. a plan picked on the
 * site arrives chosen; the step survives a refresh. there is no way past it but through: every dashboard page leads
 * back here until it is done. paying ends on the plans page, staying free ends on the dashboard */
export function Onboarding() {
  const { account, catalog, billing, clouds, checkout, updateProfile, finishOnboarding } = useCloud();
  const { account: me, setAccount, toast } = useSession();
  const { path, query } = useLocation();
  const intent = planIntent(query);
  // an open checkout already has a machine reserved: only a paid one counts
  const bought = billing?.subscription?.status === "active" || billing?.subscription?.status === "past_due" || Boolean(clouds?.some((cloud) => !cloud.awaitingPayment));
  const asked = query.get("step");
  const saved = sessionStorage.getItem(SAVED);
  const wanted: Step = asked === "done" ? "app" : isStep(asked) ? asked : isStep(saved) ? saved : "name";
  const step: Step = wanted === "plan" && bought ? "app" : wanted;
  const at = STEPS.indexOf(step);
  const guess = account?.profile.name || me?.name || me?.email.split("@")[0] || "";
  const [name, setName] = useState<string | null>(null);
  const [home, setHome] = useState<Home>("cloud");
  const [plan, setPlan] = useState<PaidPlan | "team">(intent?.plan ?? "pro");
  const [interval, setInterval] = useState<BillingInterval>(intent?.interval ?? "month");
  const [busy, setBusy] = useState<"name" | "cloud" | "free" | "done" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const scene = useRef<SceneHandle>(null);
  const leaving = useRef(false);
  const shownName = name ?? guess;
  // a name the sign-in brought (Google, Apple) is already on the account: the step is skipped once, with none it stays,
  // and going back to it later shows it
  const given = (account?.profile.name || me?.name || "").trim();
  const [skippedOnce, setSkippedOnce] = useState(() => sessionStorage.getItem(NAME_SKIPPED) !== null);
  const autoSaved = useRef(false);
  // signed up from the app (its sign-in brought them here): they have it, so there is no app step
  const [inApp] = useState(fromApp);
  const total = inApp ? STEPS.length - 1 : STEPS.length;
  const ended = useRef(false);
  const [opened, setOpened] = useState(() => sessionStorage.getItem(CHECKOUT_OPENED) !== null);
  // a plan picked on the site goes from sign-in straight to checkout, the name comes after; once it was opened and
  // not paid (back from the payment page, or it failed) the steps run as usual with that plan chosen
  const autoPay = Boolean(intent) && !bought && !inApp && !opened;
  const paying = useRef(false);
  const skipping = step === "name" && !skippedOnce && account !== null && /\p{L}/u.test(given) && !autoPay;

  const search = query.toString();
  const address = (to: Step) => {
    const params = new URLSearchParams(search);
    params.set("step", to);
    return `${path}?${params}`;
  };
  const here = address(step);
  useEffect(() => { sessionStorage.setItem(SAVED, step); }, [step]);
  useEffect(() => {
    if (step === "name" && account === null) return;
    trackOnboardingStep(step, inApp, step === "name" && skipping);
  }, [step, inApp, account === null]);
  useEffect(() => { setError(null); scene.current?.react("perk"); }, [step]);
  useEffect(() => { if (step === "plan") { setInterval("month"); setPlan((p) => (p === "team" ? "pro" : p)); } }, [step]);
  // each history entry names its step, so back and forward move between steps and a refresh stays put
  useEffect(() => { if (asked !== step && !leaving.current) navigate(here, { replace: true }); }, [asked, step, here]);

  const go = (to: Step, replace = false) => navigate(address(to), replace ? { replace: true } : undefined);
  /** done: the account is marked and the dashboard opens like any other visit; the app picks things up by itself */
  const finish = async (to: string, home: WebsiteHome) => {
    setBusy("done"); setError(null);
    try { await finishOnboarding(home); }
    catch { setError("that didn't save. try again."); setBusy(null); return; }
    sessionStorage.removeItem(SAVED);
    sessionStorage.removeItem(CHECKOUT_OPENED);
    leaving.current = true;
    navigate(to, { replace: true });
  };
  // the app has no step of its own when the app sent them: a stale step there just finishes
  useEffect(() => {
    if (!inApp || step !== "app" || ended.current) return;
    ended.current = true;
    void finish(bought ? "/billing" : APP_DONE, bought ? "cloud" : "free");
  }, [inApp, step]);
  const choose = async (where: "cloud" | "free", early = true) => {
    // from the app: it carries on with this computer, so the browser's part ends here
    if (where === "free") { if (inApp) await finish(APP_DONE, "free"); else go("app"); return; }
    if (!catalog) return;
    track({ name: "plan_chosen", props: { plan, period: interval } });
    if (catalog.checkoutOpen === false) { setError(CHECKOUT_SOON); setOpened(true); return; }
    setBusy("cloud"); setError(null);
    // paid before the name, the first run goes on after checkout; picked on the plan step, it is over once the payment page opens
    if (early) { try { await finishOnboarding("cloud"); } catch { /* the plans page still works; the next visit asks again */ } }
    sessionStorage.removeItem(SAVED);
    sessionStorage.setItem(CHECKOUT_OPENED, "1");
    const selection = plan === "team" ? teamSelection(catalog, interval) : planSelection(catalog, plan, { interval, work: false });
    const ok = selection ? await checkout({ source: "dash_onboarding", kind: "plan", selection, bundle: null }) : false;
    if (!ok) { setError("checkout didn't open. try again."); setBusy(null); setOpened(true); return; }
    // the live page is on its way to the payment page; fixtures pay at once
    if (FIXTURE) { toast("paid. your dusk cloud is being set up."); leaving.current = true; navigate("/billing", { replace: true }); }
  };
  const signOut = () => {
    sessionStorage.removeItem(SAVED);
    sessionStorage.removeItem(NAME_SKIPPED);
    sessionStorage.removeItem(CHECKOUT_OPENED);
    leaving.current = true;
    void api.signOut().finally(() => setAccount(null));
  };
  const saveName = async (auto = false) => {
    const next = (auto ? given : shownName).trim();
    if (!next) { setError("a name, any name."); return; }
    setBusy("name"); setError(null);
    try { if (next !== (account?.profile.name ?? "")) await updateProfile(next); }
    catch (e) { setError(auto ? null : (e as Error).message); setBusy(null); return; }
    setBusy(null);
    if (bought && inApp) { await finish("/billing", "cloud"); return; }
    go(bought ? "app" : "plan", auto);
  };
  useEffect(() => {
    if (!autoPay || step !== "name" || account === null || !catalog || paying.current) return;
    paying.current = true;
    void choose("cloud", false);
  }, [autoPay, step, account === null, catalog === null]);
  useEffect(() => {
    if (!skipping || autoSaved.current) return;
    autoSaved.current = true;
    sessionStorage.setItem(NAME_SKIPPED, "1");
    void saveName(true).finally(() => setSkippedOnce(true));
  }, [skipping]);

  const chosen = catalog ? bundleOf(catalog, plan) : null;
  const price = chosen && catalog ? per(chosen.monthly, interval, catalog) : null;
  const mood: SceneMood = busy ? "thinking" : focused ? "typing" : "idle";
  const back = (to: Step) => <button type="button" onClick={() => go(to)} disabled={busy !== null} className="text-link -ms-2 inline-flex h-11 items-center gap-1.5 rounded-full px-2 text-14 disabled:opacity-50"><ArrowLeft size={15} strokeWidth={1.75} aria-hidden />back</button>;
  const big = "w-full !h-12 !text-15";

  return (
    <SplitFrame
      mood={mood}
      step={at}
      scene={scene}
      snug
      card={<p key={step} className="swap-in flex items-end gap-3.5"><span className="text-[56px] font-medium leading-[0.8] tracking-[-0.05em] text-ink">{at + 1}</span><span className="pb-0.5 text-20 font-medium tracking-[-0.03em] text-ink">{LABELS[at]}</span></p>}
      aside={<button type="button" onClick={signOut} disabled={busy !== null} className="text-link -me-2 h-11 rounded-full px-2 text-14 disabled:opacity-50">sign out</button>}
    >
      <Rail at={Math.min(at, total - 1)} total={total} />
      {step === "name" && (skipping || autoPay) ? (
        <div key="name-skip" className="min-h-[200px]" aria-busy="true" />
      ) : step === "name" ? (
        <form key="name" className="step-in" onSubmit={(e) => { e.preventDefault(); void saveName(); }} noValidate>
          <h1 className="t-title">what's your name?</h1>
          <p className="mt-3 text-16 text-ink-2">{bought ? "your dusk cloud is setting up." : "two quick things and you're in."}</p>
          <input id="onb-name" aria-label="your name" placeholder="your name" autoComplete="given-name" maxLength={60} value={shownName} onChange={(e) => { setName(e.target.value); setError(null); }} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} className="field mt-7 !h-12" aria-invalid={Boolean(error)} aria-describedby={error ? "onb-error" : undefined} />
          {error && <p id="onb-error" role="alert" className="mt-2.5 text-14 text-bad">{error}</p>}
          <Button type="submit" variant="primary" className={cx("mt-3", big)} disabled={busy !== null}>{busy ? <Busy>saving</Busy> : "continue"}</Button>
        </form>
      ) : step === "plan" ? (
        <div key="plan" className="step-in">
          <h1 className="t-title">where should your bots live?</h1>
          <p className="mb-6 mt-3 text-16 text-ink-2">on dusk cloud they keep working, even when your computer is off.</p>
          {catalog ? <PlanStep catalog={catalog} home={home} setHome={(h) => { setHome(h); setError(null); }} plan={plan === "team" ? "pro" : plan} setPlan={(p) => { setPlan(p); setError(null); }} /> : <div className="flex flex-col gap-2" aria-busy="true"><Skeleton className="h-[300px] !rounded-[22px]" /><Skeleton className="h-[72px] !rounded-[18px]" /></div>}
          {error && <p role="alert" className="mt-3 text-14 text-bad">{error}</p>}
          <Button variant="primary" className={cx("mt-5", big)} onClick={() => void choose(home)} disabled={busy !== null || !catalog}>{busy === "cloud" ? <Busy>opening checkout</Busy> : busy === "done" ? <Busy>opening</Busy> : home === "free" ? "continue with free" : trialAction(catalog) ?? (price ? `continue to checkout, ${price.amount}${price.unit}` : "continue to checkout")}</Button>
          <div className="mt-2 flex items-center justify-between">{back("name")}</div>
        </div>
      ) : inApp ? (
        <div key="app" className="min-h-[200px]" aria-busy="true" />
      ) : (
        <AppStep bought={bought} email={me?.email ?? null} error={error} busy={busy} big={big} back={bought ? null : back("plan")}
          onDone={() => void finish(bought ? "/billing" : "/", bought ? "cloud" : "free")} />
      )}
    </SplitFrame>
  );
}
