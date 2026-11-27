// Screen 1: the one reason to buy, the plans side by side as the site's pricing cards (each under its own landscape),
// one button that names the plan picked, and the money once, under it.
import { useState } from "react";
import type { CloudOffer, CloudOfferPlan } from "../../../electron/cloud-home.mjs";
import islands from "@/assets/pixel-art/plan-islands.webp";
import meadow from "@/assets/pixel-art/plan-meadow.webp";
import peaks from "@/assets/pixel-art/plan-peaks.webp";
import cat from "@/assets/pixel-art/plan-cat.webp";
import { Check, Minus } from "@/icons";
import { cn } from "@/lib/cn";
import { moneyBackShort, planCards, usd, type CloudPlanCard } from "@/lib/cloud-plan";
import { activeLocale, t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { WhatMovesPanel } from "../WhatMoves";
import { buyLabel } from "./buy-label";
import { LINK, PRIMARY_WIDE, Tag } from "./parts";

const WHY: Record<string, LocaleKey> = { starter: "cloudBuy.big.why.starter", pro: "cloudBuy.big.why.pro", team: "cloudBuy.big.why.team" };
const WORK = new Set(["pro", "max"]);
const LANDSCAPES = [{ art: meadow, lip: "cloud-plan-lime" }, { art: peaks, lip: "cloud-plan-sky" }, { art: islands, lip: "cloud-plan-pink" }];

/** The plan picked first: the Admin's recommended one, else the first the person can buy. */
function firstPick(cards: readonly CloudPlanCard[]): string | null {
  return (cards.find(card => card.popular && card.action) ?? cards.find(card => card.action))?.tier ?? null;
}

const gb = (mb: number) => new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: 1 }).format(Math.round(mb / 102.4) / 10);
/** A plan's four lines, every number from the Admin's allowances: machine, disk, how it wakes, who may use it.
 * `oldAdmin`: an Admin that says nothing of sleeping or seats, so Plus wakes on its own in under a minute and Team's seats are its catalog's. */
function specs(plan: CloudOfferPlan | undefined, oldAdmin: boolean): Array<{ key: string; text: string; quiet?: true }> {
  const a = plan?.allowances;
  if (!plan || !a) return [];
  const team = plan.tier === "team" || Boolean(a.seats);
  const cpus = t("cloudBuy.plan.cpus", { count: a.cpus });
  const sleeps = a.sleeps === true || (oldAdmin && plan.tier === "starter");
  return [
    { key: "machine", text: t(team ? "cloudBuy.big.machineDedicated" : "cloudBuy.big.machine", { cpus, memory: gb(a.memoryMb) }) },
    { key: "disk", text: a.maxDiskGb > a.diskGb ? t("cloudBuy.row.storageGrows", { gb: a.diskGb, max: a.maxDiskGb }) : t("cloudBuy.row.storage", { gb: a.diskGb }) },
    { key: "wake", text: t(sleeps ? "cloudBuy.big.wakes" : "cloudBuy.big.priority") },
    a.seats && a.includedSeats && a.extraSeatCents
      ? { key: "license", text: t("cloudBuy.big.seats", { included: a.includedSeats, price: usd(a.extraSeatCents / 100), seats: a.seats }) }
      : a.seats ? { key: "license", text: t("cloudBuy.point.team", { seats: a.seats }) }
      : team ? { key: "license", text: t("cloudBuy.big.teamSeats") }
      : WORK.has(plan.tier) ? { key: "license", text: t("cloudBuy.big.workLicense") }
      : { key: "license", text: t("cloudBuy.big.noLicense"), quiet: true },
  ];
}

export function ChooseScreen({ offer, current = null, own = null, busy, signedOut, notice, pending = null, moving = false, onStart, onSignIn, onResume }: {
  offer: CloudOffer;
  /** The person's own plan tier, and that plan when it is no longer on sale: its card says Your plan and cannot be picked. */
  current?: string | null; own?: CloudOfferPlan | null;
  now?: number; busy: boolean; signedOut: boolean; notice: string | null;
  /** A checkout left open: its plan's name, for a quiet Finish your checkout beside the terms. */
  pending?: string | null;
  /** Opened to move this computer's bots: paying moves them, so the sheet says what moves. */
  moving?: boolean;
  onStart: (tier: string) => void; onSignIn: () => void; onResume?: () => void;
}) {
  const cards = planCards(offer, { current, own });
  const [chosen, setChosen] = useState<string | null>(null);
  const pick = cards.find(card => card.tier === chosen && card.action) ?? cards.find(card => card.tier === firstPick(cards)) ?? null;
  const trial = offer.plans.some(plan => plan.trialDays);
  const moneyBack = moneyBackShort(offer);
  const oldAdmin = !offer.plans.some(entry => entry.allowances?.sleeps || entry.allowances?.seats);
  const all = [...offer.plans, ...(own ? [own] : [])];
  const buy = pick && (pick.trialDays
    ? t(pick.trialDays === 1 ? "cloudBuy.buyTrial.one" : "cloudBuy.buyTrial.many", { plan: pick.name, days: pick.trialDays })
    : buyLabel(pick.name, pick.price));
  return <div data-cloud-add={trial ? "offer-trial" : "offer"} className="cloud-plans flex flex-col gap-6 px-7 pb-7 pt-6">
    <header className="flex flex-col gap-1 pe-12">
      <p className="text-[13px] leading-[18px] text-ink-tertiary">{t("pro.name")}</p>
      <h2 id="cloud-add-title" tabIndex={-1} className="text-[21px] font-medium leading-[27px] tracking-[-0.014em] text-ink outline-none! [text-wrap:balance]">{t("cloudBuy.headline")}</h2>
    </header>
    {notice && <p role="status" className="-mt-2 text-[13px] leading-[18px] text-ink">{notice}</p>}
    <div role="radiogroup" aria-label={t("cloudBuy.choose")}
      className={cn("grid grid-cols-[repeat(auto-fit,minmax(176px,1fr))] gap-2.5", cards.some(card => card.tier === "pro") && "pt-7")}>
      {cards.map((card, index) => <PlanCard key={card.tier} card={card} on={card.tier === pick?.tier} land={LANDSCAPES[index % LANDSCAPES.length]!}
        lines={specs(all.find(entry => entry.tier === card.tier), oldAdmin)} onPick={setChosen} />)}
    </div>
    {moving && <WhatMovesPanel />}
    <div className="flex flex-col gap-3">
      {pick && buy && <button type="button" data-plan-buy={pick.tier} className={PRIMARY_WIDE} disabled={busy} onClick={() => onStart(pick.tier)}>{buy}</button>}
      <div aria-live="polite" className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5 text-[12px] leading-4 text-ink-tertiary">
        <p data-plan-terms="">{pick?.trialDays && pick.terms ? pick.terms : t("cloudBuy.terms")}{moneyBack && <> {t("cloudBuy.moneyBackLine", { days: offer.refundDays! })}</>}</p>
        {signedOut && <button type="button" className={cn(LINK, "text-[12px]")} onClick={onSignIn}>{t("cloudBuy.haveAccount")}</button>}
        {!signedOut && pending && onResume && <button type="button" data-plan-pending="" className={cn(LINK, "text-[12px]")} disabled={busy} onClick={onResume}>{t("cloudBuy.pending", { plan: pending })}</button>}
      </div>
    </div>
  </div>;
}

/** One plan as the site's pricing card: its landscape, name, reason, price and lines. The whole card is its radio; the
 * person's own plan is shown but cannot be picked. Only the picked radio is in the tab order, the arrow keys move between them. */
function PlanCard({ card, on, land, lines, onPick }: {
  card: CloudPlanCard; on: boolean; land: (typeof LANDSCAPES)[number]; lines: ReturnType<typeof specs>; onPick: (tier: string) => void;
}) {
  const why = Object.hasOwn(WHY, card.tier) ? t(WHY[card.tier]!) : card.promise;
  const about = `cloud-plan-${card.tier}-about`;
  return <label data-plan={card.tier} data-plan-on={on ? "" : undefined}
    className={cn("cloud-plan relative flex min-w-0 flex-col rounded-[18px] p-1.5 pb-5", land.lip,
      card.current ? "cursor-default bg-ink/[0.035]" : on ? "cursor-pointer bg-ink/[0.065]" : "cursor-pointer bg-ink/[0.035] hover:bg-ink/[0.055]")}>
    <input type="radio" name="cloud-plan" value={card.tier} data-plan-pick={card.tier} checked={on} disabled={card.current} tabIndex={on ? 0 : -1}
      aria-label={`${card.name}, ${t("cloudBuy.big.priceLabel", { price: card.price })}`} aria-describedby={about}
      onChange={() => card.action && onPick(card.tier)} className="sr-only" />
    {card.tier === "pro" && <img src={cat} alt="" className="cloud-plan-art pointer-events-none absolute -top-[43px] end-4 w-[92px]" />}
    <span className="relative block h-[86px] overflow-hidden rounded-[13px]">
      <img src={land.art} alt="" className="cloud-plan-art size-full object-cover" />
      <span aria-hidden="true" className="cloud-plan-dim absolute inset-0" />
    </span>
    <span className="flex flex-col px-3.5">
      <span className="mt-4 flex items-center justify-between gap-2">
        <span className="truncate text-[18px] font-medium leading-6 text-ink">{card.name}</span>
        {card.current ? <Tag data-plan-mine="">{t("cloudBuy.card.current")}</Tag>
          : <span aria-hidden="true" className={cn("grid size-[18px] shrink-0 place-items-center rounded-full transition-colors duration-150 motion-reduce:transition-none", on ? "bg-ink" : "bg-ink/[0.1]")}>
            <span className={cn("size-1.5 rounded-full bg-app", !on && "opacity-0")} />
          </span>}
      </span>
      <span id={about} className="flex flex-col">
        {why && <span data-plan-promise="" className="mt-0.5 min-h-[36px] text-[13px] leading-[18px] text-ink-secondary [text-wrap:pretty]">{why}</span>}
        <span className="mt-3 flex flex-wrap items-baseline gap-x-1.5" aria-hidden="true">
          <span className="text-[38px] font-medium leading-none tracking-[-0.045em] tabular-nums text-ink">{card.price}</span>
          <span data-plan-trial={card.trialDays ? "" : undefined} className="text-[13px] text-ink-tertiary">
            {card.trialDays ? t("cloudBuy.big.perMonthTrial", { days: card.trialDays }) : t("cloudBuy.big.perMonth")}</span>
        </span>
        {lines.length > 0 && <span role="list" data-plan-spec={card.tier} className="mt-4 flex flex-col gap-1.5 text-[13px] leading-[17px] text-ink-secondary">
          {lines.map(line => <span role="listitem" key={line.key} data-plan-line={line.key} className={cn("flex gap-2 [text-wrap:pretty]", line.quiet && "text-ink-tertiary")}>
            {line.quiet ? <Minus size={14} strokeWidth={2} aria-hidden="true" className="mt-px shrink-0" />
              : <Check size={14} strokeWidth={2} aria-hidden="true" className="mt-px shrink-0 text-ink" />}
            <span className="min-w-0">{line.text}</span>
          </span>)}
        </span>}
      </span>
    </span>
  </label>;
}
