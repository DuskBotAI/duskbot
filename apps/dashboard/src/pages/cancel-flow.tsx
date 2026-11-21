import { useId, useState, type ReactNode } from "react";
import { ArrowUpRight, Minus } from "@/icons";
import { useCloud } from "../data/cloud";
import type { PlanCatalog, Selection } from "../data/contracts";
import { bundleOf, priceCart } from "../data/pricing";
import { useAccountUsage } from "../data/usage";
import { useSession } from "../data/session";
import type { CancelAnswer, RetentionInput, RetentionOfferShown } from "../data/wire";
import { longDate } from "../lib/format";
import { Link } from "../lib/router";
import { Choice, Modal } from "../ui/controls";
import { Button } from "../ui/kit";
import { cartText, planSelection } from "./plan-sheet";

export const CONTACT = "mailto:hello@dusk.bot";

/** the reasons in the order they are offered */
export const REASONS: Array<{ id: CancelAnswer; label: string }> = [
  { id: "price", label: "it's too expensive" },
  { id: "unused", label: "i'm not using it" },
  { id: "broken", label: "something broke" },
  { id: "feature", label: "it's missing a feature i need" },
  { id: "switching", label: "i'm switching to something else" },
  { id: "other", label: "something else" },
];
/** the paid plans keep a dusk cloud's files this many days after the plan ends, then delete them */
export const KEPT_DAYS = 30;
const DAY = 86_400_000;

/** what the reason step offers for a reason: only what this plan can really take */
export function offerFor(reason: CancelAnswer | null, can: { discount: boolean; cheaper: boolean }): RetentionOfferShown {
  if (reason === "price") return can.discount ? "discount" : can.cheaper ? "downgrade" : "none";
  if (reason === "unused" || reason === "broken") return "help";
  if (reason === "feature" || reason === "switching" || reason === "other") return "note";
  return "none";
}

export type FlowStep = "before" | "reason" | "confirm" | "done";

/** what ends with the plan, as plain lines, in the person's own numbers when known; `keepsLicense` is a work license that outlives the dusk cloud */
export function losses(opts: { desk: boolean; work: boolean; keepsLicense: boolean; bots?: number; routines?: number; keptUntil: string }): string[] {
  const bots = opts.bots && opts.bots > 1 ? `your ${opts.bots} bots stop` : opts.bots === 1 ? "your bot stops" : "your bots stop";
  const routines = opts.routines && opts.routines > 1 ? `your ${opts.routines} routines only run` : opts.routines === 1 ? "your routine only runs" : "routines only run";
  return [
    ...(opts.desk ? [`${bots} working when your mac sleeps`, `${routines} while your mac is awake`, `your dusk cloud files are kept until ${opts.keptUntil}, then deleted`] : []),
    ...(opts.work && !opts.keepsLicense ? ["work use is no longer covered. personal use stays free."] : []),
  ];
}

function Losses({ desk, work, keepsLicense, keptUntil }: { desk: boolean; work: boolean; keepsLicense: boolean; keptUntil: string }) {
  const { bots } = useAccountUsage();
  const lost = losses({ desk, work, keepsLicense, keptUntil, bots: bots.length, routines: bots.reduce((sum, row) => sum + (row.bot.routines?.length ?? 0), 0) });
  if (!lost.length) return null;
  return (
    <ul className="mt-3 flex flex-col gap-2">
      {lost.map((l) => <li key={l} className="flex gap-2.5 text-14 text-ink-2"><Minus size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-ink-4" aria-hidden />{l}</li>)}
    </ul>
  );
}

function HelpLink({ to, external, onClick, children }: { to: string; external?: boolean; onClick(): void; children: ReactNode }) {
  const cls = "hover-row flex min-h-12 items-center justify-between gap-3 rounded-[14px] bg-card px-3.5 text-14 text-ink";
  return external
    ? <a href={to} className={cls} onClick={onClick}>{children}<ArrowUpRight size={15} strokeWidth={1.5} className="shrink-0 text-ink-3" aria-hidden /></a>
    : <Link to={to} className={cls} onClick={onClick}>{children}<ArrowUpRight size={15} strokeWidth={1.5} className="shrink-0 text-ink-3" aria-hidden /></Link>;
}

function Unused({ onHelped }: { onHelped(): void }) {
  const { month, bots, loading } = useAccountUsage();
  const turns = month?.totals.turns ?? 0;
  return (
    <>
      <p>{loading ? "checking what your bots did..." : turns > 0 ? `this month your ${bots.length === 1 ? "bot" : `${bots.length} bots`} took ${turns.toLocaleString("en-US")} turns.` : "your bots haven't done much this month."} a few ways people get more out of it:</p>
      <div className="mt-4 flex flex-col gap-1.5">
        <HelpLink to="/bots" onClick={onHelped}>give a bot a routine, like a morning brief</HelpLink>
        <HelpLink to="/connectors" onClick={onHelped}>connect your email, calendar or slack</HelpLink>
        <HelpLink to="/usage" onClick={onHelped}>see what each bot did this month</HelpLink>
      </div>
    </>
  );
}

/** the ways to keep the plan for less: the one-time discount, and plus for someone on pro */
function Saves({ offer, plus, smaller, work, busy, onDiscount, onDowngrade, catalog, interval }: { offer: { percent: number; cycles: number } | null; plus: { name: string } | null; smaller: Selection | null; work: boolean; busy: string | null; onDiscount(): void; onDowngrade(): void; catalog: PlanCatalog; interval: Selection["interval"] }) {
  return (
    <div className="mt-4 flex flex-col gap-1.5">
      {offer && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[16px] bg-card px-4 py-3">
          <div className="min-w-0 flex-1 basis-[200px]">
            <p className="text-14 text-ink">{offer.percent}% off your next {offer.cycles} months</p>
            <p className="text-13 text-ink-3">your plan stays as it is. one time only.</p>
          </div>
          <Button variant="primary" size="sm" onClick={onDiscount} disabled={busy !== null}>{busy === "discount" ? "applying" : `take ${offer.percent}% off`}</Button>
        </div>
      )}
      {plus && smaller && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[16px] bg-card px-4 py-3">
          <div className="min-w-0 flex-1 basis-[200px]">
            <p className="text-14 text-ink">switch to {plus.name}</p>
            <p className="num text-13 text-ink-3">{cartText(priceCart(smaller, catalog), interval)}, a smaller dusk cloud{work ? ", work license included" : ""}</p>
          </div>
          <Button variant={offer ? "outline" : "primary"} size="sm" onClick={onDowngrade} disabled={busy !== null}>{busy === "downgrade" ? "switching" : `switch to ${plus.name}`}</Button>
        </div>
      )}
    </div>
  );
}

/** account, billing, manage subscription: what ends, why with an offer that fits, then the cancel at the period's end.
 * consumer rules (California's online cancel, US, EU, India) need an online cancel: the reason is optional, the cancel
 * is always one clear button away, and it is at most three screens in. */
export function CancelFlow({ open, onClose, catalog }: { open: boolean; onClose(): void; catalog: PlanCatalog }) {
  const { billing, cancel, keep: renew, changePlan, updateCard, retentionStep, takeDiscount } = useCloud();
  const { toast } = useSession();
  const noteId = useId();
  const [step, setStep] = useState<FlowStep>("before");
  const [reason, setReason] = useState<CancelAnswer | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"discount" | "downgrade" | "cancel" | "restart" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sub = billing?.subscription;
  if (!sub) return null;
  const sel = sub.selection;
  const desk = sel.desktop !== "none";
  const work = sel.license !== "personal";
  // a plan change on a trial ends the trial and bills at once, so a trial cancel always ends the whole plan
  const trial = sub.trialEndsAt !== undefined && sub.trialEndsAt > Date.now();
  const keepsLicense = work && desk && !trial;
  const offer = billing?.retention?.offer ?? null;
  const onPro = sel.desktop === bundleOf(catalog, "pro")?.desktop;
  const plus = bundleOf(catalog, "starter");
  const smaller: Selection = planSelection(catalog, "starter", { interval: sel.interval, region: sel.region, work: false, keep: sel });
  const until = longDate(sub.currentPeriodEnd);
  const keptUntil = longDate(sub.currentPeriodEnd + KEPT_DAYS * DAY);
  const cheaper = onPro && plus && !trial ? plus : null;
  const canSave = Boolean(offer || cheaper);
  const shown = offerFor(reason, { discount: Boolean(offer), cheaper: Boolean(cheaper) });
  const said = note.trim();

  const log = (s: RetentionInput["step"], outcome: RetentionInput["outcome"]) => {
    if (reason) retentionStep({ reason, step: s, outcome, offer: shown, ...(said && outcome !== "shown" ? { note: said } : {}) });
  };
  const keep = () => { if (step === "reason" || step === "confirm") log(step, "kept"); onClose(); };
  const go = (to: FlowStep) => { setError(null); setStep(to); };
  const toConfirm = () => { log("reason", "shown"); go("confirm"); };
  const run = async (kind: NonNullable<typeof busy>, action: () => Promise<void>, after: () => void = onClose) => {
    setBusy(kind); setError(null);
    try { await action(); after(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const discount = () => run("discount", async () => { await takeDiscount(reason ?? "price"); toast(`${offer!.percent}% off your next ${offer!.cycles} months`); });
  const downgrade = () => run("downgrade", async () => {
    await changePlan(smaller, 0);
    log("help", "downgrade");
    toast(`you switch to ${plus?.name ?? "plus"} on ${until}. until then nothing changes.`);
  });
  const stop = () => run("cancel", async () => {
    if (keepsLicense) { await changePlan({ ...sel, desktop: "none", size: null }); log("confirm", "cancelled"); }
    else await cancel(reason ? { answer: reason, offer: shown, ...(said ? { improve: said } : {}) } : null);
  }, () => go("done"));
  const restart = () => run("restart", async () => {
    if (keepsLicense) await changePlan(sel, 0); else await renew();
    if (reason) retentionStep({ reason, step: "confirm", outcome: "kept", offer: shown });
    toast(`your plan renews again on ${until}`);
  });

  const title = step === "before" ? "before you go" : step === "reason" ? "why are you leaving?"
    : step === "confirm" ? (keepsLicense ? "cancel your dusk cloud?" : "cancel your plan?")
      : keepsLicense ? "your dusk cloud is cancelled" : "your plan is cancelled";
  const saves = <Saves offer={offer} plus={cheaper} smaller={cheaper ? smaller : null} work={work} busy={busy} onDiscount={() => void discount()} onDowngrade={() => void downgrade()} catalog={catalog} interval={sel.interval} />;
  const footer = step === "done"
    ? <><Button onClick={() => void restart()} disabled={busy !== null}>{busy === "restart" ? "restarting" : "restart plan"}</Button><Button variant="primary" onClick={onClose}>done</Button></>
    : step === "confirm"
      ? <><Button variant="primary" onClick={keep}>keep my plan</Button><Button variant="danger" onClick={() => void stop()} disabled={busy !== null}>{busy === "cancel" ? "cancelling" : `cancel on ${until}`}</Button></>
      : <><Button variant="primary" onClick={keep}>keep my plan</Button><Button onClick={step === "before" ? () => go("reason") : toConfirm} disabled={busy !== null}>continue to cancel</Button></>;

  return (
    <Modal open={open} onClose={step === "reason" || step === "confirm" ? keep : onClose} title={title} footer={footer} wide>
      {step === "before" && (
        <>
          <p>{keepsLicense ? `if you cancel, your dusk cloud keeps working until ${until}. your work license stays. after that:` : `if you cancel, everything keeps working until ${until}. after that:`}</p>
          <Losses desk={desk} work={work} keepsLicense={keepsLicense} keptUntil={keptUntil} />
          <p className="mt-3">you can restart any time before {until} and nothing changes.</p>
        </>
      )}

      {step === "reason" && (
        <>
          <p>pick the closest one, or skip it. it helps us fix the right thing.</p>
          <fieldset className="mt-4 min-w-0">
            <legend className="sr-only">reason</legend>
            <div className="flex flex-col gap-1">
              {REASONS.map((r) => <Choice key={r.id} name="cancel-reason" value={r.id} checked={reason === r.id} onChange={() => setReason(r.id)} title={r.label} />)}
            </div>
          </fieldset>
          {reason === "price" && (canSave ? saves : <p className="mt-4 rounded-[16px] bg-card px-4 py-3 text-14">you're on our smallest plan. free keeps your bots running on your mac at no cost.</p>)}
          {reason === "unused" && <div className="mt-4"><Unused onHelped={() => log("help", "helped")} />{canSave && <><p className="mt-5">or keep it for less:</p>{saves}</>}</div>}
          {reason === "broken" && (
            <div className="mt-4">
              <p>most problems clear up with a restart, and we answer every message.</p>
              <div className="mt-3 flex flex-col gap-1.5">
                {desk && <HelpLink to="/cloud" onClick={() => log("help", "helped")}>restart your dusk cloud</HelpLink>}
                <HelpLink to="/workspaces" onClick={() => log("help", "helped")}>check that your computers are connected</HelpLink>
                <HelpLink to={`${CONTACT}?subject=${encodeURIComponent("something broke")}`} external onClick={() => log("help", "helped")}>tell us what broke at hello@dusk.bot</HelpLink>
              </div>
            </div>
          )}
          {(reason === "feature" || reason === "switching" || reason === "other") && (
            <div className="mt-4">
              <label htmlFor={noteId} className="mb-1.5 block text-13 text-ink-2">{reason === "other" ? "anything we should know? (optional)" : "what's missing? (optional)"}</label>
              <textarea id={noteId} value={note} maxLength={2000} rows={3} onChange={(e) => setNote(e.target.value)} className="field !h-auto min-h-[88px] resize-y !py-3 !text-14" />
              <p className="mt-2 text-13 text-ink-3">we read every note. keep your plan and we'll write back when it's there.</p>
            </div>
          )}
          {sub.status === "past_due" && <button type="button" className="text-link mt-3 h-9 text-13" onClick={() => void updateCard()}>update your card instead</button>}
        </>
      )}

      {step === "confirm" && (
        <>
          <p>{keepsLicense ? `your dusk cloud ends on ${until}, not today. it keeps working until then and isn't charged again. your work license stays and keeps renewing.`
            : `your plan ends on ${until}, not today. everything keeps working until then, and you won't be charged${trial ? "" : " again"}.`}</p>
          {desk && <p className="mt-3">your dusk cloud files are kept until {keptUntil}, then deleted.</p>}
          <p className="mt-3">you can restart any time before {until}.</p>
        </>
      )}

      {step === "done" && (
        <p role="status">{keepsLicense ? `your dusk cloud works until ${until} and isn't charged again.` : `everything keeps working until ${until}, and you won't be charged again.`} changed your mind? restart it any time before then.</p>
      )}
      {error && <p role="alert" className="mt-3 text-13 text-bad">{error}</p>}
    </Modal>
  );
}
