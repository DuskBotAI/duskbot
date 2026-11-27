import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, X } from "../icons";

import type { CloudCancelAnswer, CloudCancelSurvey, CloudRenewalResult, CloudRetentionOffer, CloudRetentionStep } from "../../electron/cloud-account.mjs";
import type { CloudUsage } from "../../electron/cloud-home.mjs";
import type { CloudRenewal } from "../../electron/cloud-list.mjs";
import { cn } from "@/lib/cn";
import { activeLocale, t } from "@/lib/i18n";
import { meterAmounts, meterLabel } from "@/lib/usage-meter";
import type { LocaleKey } from "@/locales";

/** The six reasons the sheet asks, in this order; an older answer (setup, later, other) is never offered again. */
const ANSWERS = ["price", "unused", "feature", "switching", "broken", "skip"] as const satisfies readonly CloudCancelAnswer[];
type Answer = (typeof ANSWERS)[number];
const ANSWER_LABEL: Record<Answer, LocaleKey> = {
  price: "cloudCancel.answer.price", unused: "cloudCancel.answer.unused", feature: "cloudCancel.answer.feature",
  switching: "cloudCancel.answer.switching", broken: "cloudCancel.answer.broken", skip: "cloudCancel.answer.skip",
};
const BOX_MAX = 2_000, DAY_MS = 86_400_000;
export const CANCEL_HELP_URL = "https://dusk.bot/support";
export const CANCEL_MAIL = "hello@dusk.bot";

/** Main cancels and keeps the plan; the page only says what the person answered. `retention` logs a step for the save rate
 * (best effort, absent on an older app). */
export interface CloudRenewalActions {
  cancel(survey: CloudCancelSurvey | null): Promise<CloudRenewalResult>;
  keep(): Promise<CloudRenewalResult>;
  retention?(step: CloudRetentionStep): Promise<boolean>;
}

/** What the one offer may use: this month's use of the plan, a cheaper plan to look at, and the browser. */
export interface CloudCancelOffers {
  usage?: CloudUsage | null;
  /** the name of a cheaper plan the person could move to (not on a trial), when there is one */
  cheaper?: string | null;
  openPlans?: () => Promise<unknown>;
  openLink?: (url: string) => Promise<unknown>;
}

const day = (value: number) => new Intl.DateTimeFormat(activeLocale(), { dateStyle: "medium" }).format(new Date(value));
const endsAt = (renewal: CloudRenewal) => renewal.endsAt ?? renewal.renewsAt;

export function endedLine(renewal: CloudRenewal): string {
  const at = endsAt(renewal);
  if (renewal.trial) return at ? t("cloudCancel.endedTrial", { date: day(at) }) : t("cloudCancel.endedTrialNoDate");
  return at ? t("cloudCancel.endedPlan", { date: day(at) }) : t("cloudCancel.endedPlanNoDate");
}

export function stopsLine(renewal: CloudRenewal): string {
  const stops = renewal.team ? t("cloudCancel.teamStops", { team: renewal.team }) : t("cloudCancel.stops");
  const kept = renewal.keptDays;
  if (kept === null) return stops;
  const files = kept <= 0 ? t("cloudCancel.keptNone") : !Number.isInteger(kept) ? t("cloudCancel.keptHours", { hours: Math.max(1, Math.round(kept * 24)) })
    : kept === 1 ? t("cloudCancel.keptDay") : t("cloudCancel.keptDays", { days: kept });
  return `${stops} ${files}`;
}

/** what stops with the plan: the team's cloud, the bots while the Mac sleeps, the routines */
export function lossLines(renewal: CloudRenewal): string[] {
  return [renewal.team ? t("cloudCancel.teamStops", { team: renewal.team }) : null, t("cloudCancel.lossBots"), t("cloudCancel.lossRoutines")].filter((line): line is string => line !== null);
}

/** when the files go, from the real end of the period and the days they are kept */
export function filesLine(renewal: CloudRenewal): string | null {
  const at = endsAt(renewal), kept = renewal.keptDays;
  if (kept === null) return null;
  if (kept <= 0) return t("cloudCancel.lossFilesNone");
  return at ? t("cloudCancel.lossFilesUntil", { date: day(at + kept * DAY_MS) }) : null;
}

/** what the bots used of the plan this month, one line a meter, the ones that moved */
function usedLines(usage: CloudUsage | null | undefined): string[] {
  return (usage?.meters ?? []).filter(meter => meter.kind !== "storage" && meter.used > 0).map(meter => `${meterLabel(meter.kind)}: ${meterAmounts(meter)}`);
}

type OfferView = { offer: CloudRetentionOffer; title: LocaleKey; body?: string; lines?: string[]; action: { label: LocaleKey; outcome: CloudRetentionStep["outcome"]; run?: () => Promise<unknown> } };

/** The one offer for the reason, only what this app can really do. */
export function offerFor(answer: Answer, renewal: CloudRenewal, offers: CloudCancelOffers, note: string): OfferView {
  const keep = { label: "cloudCancel.keep", outcome: "kept" } as const;
  switch (answer) {
    case "price": return offers.cheaper && offers.openPlans && !renewal.trial
      ? { offer: "downgrade", title: "cloudCancel.offer.cheaperTitle", body: t("cloudCancel.offer.cheaper", { plan: offers.cheaper }), action: { label: "cloudCancel.offer.seePlans", outcome: "helped", run: offers.openPlans } }
      : { offer: "help", title: "cloudCancel.offer.freeTitle", body: t("cloudCancel.help.price"), action: keep };
    case "unused": {
      const used = usedLines(offers.usage);
      return used.length
        ? { offer: "help", title: "cloudCancel.offer.usedTitle", body: t("cloudCancel.offer.used"), lines: used, action: keep }
        : { offer: "help", title: "cloudCancel.offer.moreTitle", body: t("cloudCancel.help.later"), action: keep };
    }
    case "feature": {
      const mail = `mailto:${CANCEL_MAIL}?${new URLSearchParams({ subject: t("cloudCancel.offer.mailSubject"), ...(note.trim() ? { body: note.trim() } : {}) }).toString().replace(/\+/g, "%20")}`;
      return { offer: "note", title: "cloudCancel.offer.featureTitle", body: t("cloudCancel.offer.feature"),
        action: { label: "cloudCancel.offer.tellUs", outcome: "helped", ...(offers.openLink ? { run: () => offers.openLink!(mail) } : {}) } };
    }
    case "broken": return { offer: "help", title: "cloudCancel.offer.brokenTitle", body: t("cloudCancel.offer.broken"),
      action: { label: "cloudCancel.offer.openHelp", outcome: "helped", ...(offers.openLink ? { run: () => offers.openLink!(CANCEL_HELP_URL) } : {}) } };
    case "switching": case "skip": return { offer: "losses", title: "cloudCancel.offer.lossesTitle", lines: [...lossLines(renewal), ...[filesLine(renewal)].filter((line): line is string => line !== null)], action: keep };
  }
}

/** Plan & billing's foot: a quiet Cancel subscription that opens the sheet, or, once cancelled, when it ends and Resume. */
export function CloudCancelPlan({ renewal, actions, offers = {}, onChanged }: { renewal: CloudRenewal | undefined; actions: CloudRenewalActions | null; offers?: CloudCancelOffers; onChanged?: () => void }) {
  const [opened, setOpened] = useState<CloudRenewal | null>(null);
  const [keeping, setKeeping] = useState(false), [note, setNote] = useState<"failed" | "browser" | null>(null);
  if (!renewal || !actions) return null;
  const keep = () => {
    setKeeping(true); setNote(null);
    void actions.keep().then(result => {
      if (result.outcome === "kept") onChanged?.();
      else setNote(result.outcome === "browser" ? "browser" : "failed");
    }, () => setNote("failed")).finally(() => setKeeping(false));
  };
  return <>
    {renewal.cancelled
      ? <div data-cloud-cancel="cancelled" className="flex flex-col items-start gap-2 self-start">
        <p role="status" className="text-[13px] text-ink">{endedLine(renewal)}</p>
        <button type="button" className="ui-button" disabled={keeping} onClick={keep}>{t(keeping ? "cloudCancel.keeping" : "cloudCancel.resume")}</button>
        {note && <p role={note === "failed" ? "alert" : "status"} className={cn("text-[13px]", note === "failed" ? "text-danger" : "text-ink-secondary")}>
          {t(note === "failed" ? "cloudCancel.failed" : "cloudCancel.browser")}</p>}
      </div>
      : <button type="button" data-cloud-cancel="renewing" onClick={() => { setNote(null); setOpened(renewal); }}
        className="self-start rounded-sm text-[12px] text-ink-secondary underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
        {t("cloudCancel.cancelSubscription")}</button>}
    {opened && <CloudCancelSheet renewal={opened} actions={actions} offers={offers} onClose={changed => { setOpened(null); if (changed) onChanged?.(); }} />}
  </>;
}

type Step = { step: "why" } | { step: "offer" } | { step: "confirm" } | { step: "done"; renewal: CloudRenewal } | { step: "browser" };

export function CloudCancelSheet({ renewal, actions, offers = {}, onClose }: { renewal: CloudRenewal; actions: CloudRenewalActions; offers?: CloudCancelOffers; onClose: (changed: boolean) => void }) {
  const [picked, setPicked] = useState<Answer | null>(null), [missing, setMissing] = useState(false);
  const [note, setNote] = useState("");
  const [state, setState] = useState<Step>({ step: "why" });
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  const changed = useRef(false), dialog = useRef<HTMLDivElement>(null), named = useId();
  const offer = picked ? offerFor(picked, renewal, offers, note) : null;
  const log = (step: CloudRetentionStep["step"], outcome: CloudRetentionStep["outcome"]) => {
    const said = note.trim();
    void actions.retention?.({ reason: picked ?? "skip", step, outcome, ...(offer && step !== "reason" ? { offer: offer.offer } : {}), ...(said ? { note: said.slice(0, BOX_MAX) } : {}) }).catch(() => false);
  };
  const close = () => { if (!busy) onClose(changed.current); };
  /** Keep my plan, from any step before the cancel: nothing changed, so the sheet just closes */
  const stay = (step: CloudRetentionStep["step"]) => { if (busy) return; if (picked) log(step, "kept"); onClose(changed.current); };
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);
  useEffect(() => { dialog.current?.querySelector<HTMLElement>("[data-cloud-cancel-first]")?.focus(); }, [state.step]);
  const run = (work: () => Promise<void>) => {
    setBusy(true); setFailed(false);
    void work().catch(() => setFailed(true)).finally(() => setBusy(false));
  };
  const toOffer = () => {
    if (!picked) { setMissing(true); dialog.current?.querySelector<HTMLElement>("input[type=radio]")?.focus(); return; }
    log("reason", "shown");
    setFailed(false); setState({ step: "offer" });
  };
  const take = () => {
    if (!offer) return;
    log("help", offer.action.outcome);
    if (offer.action.run) void offer.action.run().catch(() => {});
    onClose(changed.current);
  };
  const noThanks = () => { log("help", "shown"); setFailed(false); setState({ step: "confirm" }); };
  const cancel = () => run(async () => {
    const said = note.trim();
    const result = await actions.cancel({ answer: picked ?? "skip", ...(offer ? { offer: offer.offer } : {}), ...(said ? { improve: said } : {}) });
    if (result.outcome === "cancelled") {
      changed.current = true;
      setState({ step: "done", renewal: result.renewal ?? { ...renewal, cancelled: true, endsAt: renewal.renewsAt, renewsAt: null } });
    } else if (result.outcome === "browser") setState({ step: "browser" });
    else setFailed(true);
  });
  const resume = () => run(async () => {
    const result = await actions.keep();
    if (result.outcome === "kept") { changed.current = true; onClose(true); }
    else if (result.outcome === "browser") setState({ step: "browser" });
    else setFailed(true);
  });
  const at = endsAt(renewal), files = filesLine(renewal);
  const title = state.step === "why" ? t("cloudCancel.whyTitle") : state.step === "offer" && offer ? t(offer.title)
    : state.step === "done" ? t("cloudCancel.doneTitle") : state.step === "browser" ? t("cloudCancel.cancelSubscription") : t(renewal.trial ? "cloudCancel.titleTrial" : "cloudCancel.titlePlan");
  const alert = failed && <p role="alert" className="mt-3 text-[13px] text-danger">{t("cloudCancel.failed")}</p>;
  const list = (lines: string[]) => <ul className="mt-3 flex list-disc flex-col gap-1.5 ps-5 text-[13px] leading-relaxed text-ink-secondary">{lines.map(line => <li key={line}>{line}</li>)}</ul>;
  const box = "mt-1.5 w-full rounded-lg border border-transparent bg-inset px-3 py-2 text-[14px] text-ink outline-none focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-60";
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-scrim p-4" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="cloud-cancel-title" aria-busy={busy} tabIndex={-1} data-cloud-cancel-sheet={state.step}
        data-cloud-cancel-offer={state.step === "offer" ? offer?.offer : undefined}
        className="flex max-h-[90vh] w-full max-w-[480px] flex-col overflow-hidden rounded-2xl border border-transparent bg-panel text-ink shadow-2xl outline-none"
        onKeyDown={event => {
          if (event.key === "Escape") { event.stopPropagation(); close(); }
          if (event.key === "Tab") {
            const controls = [...dialog.current?.querySelectorAll<HTMLElement>("a[href], textarea:enabled, button:enabled, input:enabled") ?? []]
              .filter(control => !(control instanceof HTMLInputElement && control.type === "radio" && !control.checked && control.name && dialog.current?.querySelector(`input[name="${control.name}"]:checked`)));
            if (!controls.length) return;
            const first = controls[0]!, last = controls[controls.length - 1]!;
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
          }
        }}>
        <header className="flex items-start justify-between gap-3 px-6 pb-1 pt-5">
          <h2 id="cloud-cancel-title" className="text-[17px] font-semibold">{title}</h2>
          <button type="button" aria-label={t("cloudCancel.close")} disabled={busy} onClick={close} className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised focus-visible:outline-2 focus-visible:outline-focus"><X size={18} /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5 pt-1">
          {state.step === "why" && <>
            <fieldset className="mt-1" aria-describedby={missing ? `${named}-missing` : undefined}>
              <legend className="text-[13px] leading-relaxed text-ink-secondary">{t("cloudCancel.whyLegend")}</legend>
              <div className="mt-2.5 flex flex-col gap-1">
                {ANSWERS.map(answer => <label key={answer} data-cloud-cancel-answer={answer}
                  className={cn("flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-[14px] text-ink hover:bg-ink/[0.04] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus", picked === answer && "bg-ink/[0.06]")}>
                  <input type="radio" name={`${named}-answer`} value={answer} checked={picked === answer} onChange={() => { setPicked(answer); setMissing(false); }}
                    className="size-4 shrink-0 cursor-pointer accent-[var(--color-ink)] outline-none" />
                  {t(ANSWER_LABEL[answer])}
                </label>)}
              </div>
            </fieldset>
            {missing && <p id={`${named}-missing`} role="alert" className="mt-2 text-[13px] text-danger">{t("cloudCancel.pickOne")}</p>}
            <label className="mt-4 block text-[13px] text-ink">{t("cloudCancel.note")} <span className="text-ink-secondary">{t("cloudCancel.optional")}</span>
              <textarea rows={2} maxLength={BOX_MAX} value={note} onChange={event => setNote(event.target.value)} className={box} /></label>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button type="button" data-cloud-cancel-first className="ui-button ui-button-primary" onClick={() => stay("reason")}>{t("cloudCancel.keep")}</button>
              <button type="button" data-cloud-cancel-next className="ui-button" onClick={toOffer}>{t("cloudCancel.continue")}</button>
            </div>
          </>}
          {state.step === "offer" && offer && <>
            {offer.body && <p className="text-[13px] leading-relaxed text-ink">{offer.body}</p>}
            {offer.lines && list(offer.lines)}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button type="button" data-cloud-cancel-first data-cloud-cancel-take className="ui-button ui-button-primary gap-1.5" onClick={take}>
                {t(offer.action.label)}{offer.action.run && <ArrowUpRight size={13} aria-hidden="true" />}</button>
              <button type="button" data-cloud-cancel-next className="ui-button" onClick={noThanks}>{t("cloudCancel.noThanks")}</button>
            </div>
          </>}
          {state.step === "confirm" && <>
            <p className="text-[13px] leading-relaxed text-ink">{t("cloudCancel.confirmLoses")}</p>
            {list(lossLines(renewal))}
            <p className="mt-3 text-[13px] leading-relaxed text-ink">{at ? t("cloudCancel.accessUntil", { date: day(at) }) : t("cloudCancel.accessNoDate")}</p>
            {files && <p className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">{files}</p>}
            {alert}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button type="button" data-cloud-cancel-first className="ui-button ui-button-primary" disabled={busy} onClick={() => stay("confirm")}>{t("cloudCancel.keep")}</button>
              <button type="button" data-cloud-cancel-confirm className="ui-button border-transparent bg-danger text-white hover:brightness-110" disabled={busy} onClick={cancel}>
                {t(busy ? "cloudCancel.cancelling" : "cloudCancel.cancelSubscription")}</button>
            </div>
          </>}
          {state.step === "done" && <>
            {(() => { const end = endsAt(state.renewal); return <p role="status" className="text-[14px] font-medium text-ink">{end ? t("cloudCancel.accessUntil", { date: day(end) }) : t("cloudCancel.accessNoDate")}</p>; })()}
            <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">{t("cloudCancel.resumeAnytime")}</p>
            {alert}
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <button type="button" className="ui-button" disabled={busy} onClick={resume}>{t(busy ? "cloudCancel.keeping" : "cloudCancel.resume")}</button>
              <button type="button" data-cloud-cancel-first className="ui-button ui-button-primary ms-auto" disabled={busy} onClick={close}>{t("cloudCancel.done")}</button>
            </div>
          </>}
          {state.step === "browser" && <>
            <p role="status" className="text-[13px] leading-relaxed text-ink">{t("cloudCancel.browser")}</p>
            <div className="mt-5 flex justify-end"><button type="button" data-cloud-cancel-first className="ui-button ui-button-primary" onClick={close}>{t("cloudCancel.done")}</button></div>
          </>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
