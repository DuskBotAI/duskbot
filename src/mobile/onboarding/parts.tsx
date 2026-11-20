import type { ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ChevronLeft, CircleAlert, X } from "../../icons";
import { t } from "@/lib/i18n";
import { dur, ease } from "../motion";
import { BAR_RANK, useNativeBar } from "../chrome";
import { usePlatform } from "../platform";

/** one filled action per screen; disabled reads as disabled in both looks */
export const PRIMARY = "mobile-press flex h-[52px] w-full items-center justify-center gap-2 rounded-full bg-ink text-[17px] font-semibold text-app disabled:bg-ink/[0.08] disabled:text-ink-tertiary";
/** an equal-weight choice next to others: tonal, never outranking the primary */
export const TONAL = "mobile-press flex h-[52px] w-full items-center justify-center gap-2.5 rounded-full bg-ink/[0.05] text-[17px] font-semibold text-ink disabled:opacity-50";
/** a quiet way out or around */
export const QUIET = "mobile-press flex h-11 w-full items-center justify-center rounded-full text-[15px] font-semibold text-ink-secondary disabled:opacity-50";
export const FIELD = "h-[52px] w-full min-w-0 rounded-[16px] bg-ink/[0.05] px-4 text-[17px] text-ink placeholder:text-ink-tertiary focus:bg-ink/[0.08] disabled:opacity-60 aria-[invalid=true]:bg-danger/[0.08]";
export const HEADLINE = "text-[26px] font-semibold leading-[1.15] tracking-tight text-ink";
export const LINE = "mx-auto mt-2.5 max-w-[310px] text-[16px] leading-[1.5] text-ink-secondary";

/** step swap: in from y 6, out to y -4, opacity on its own clock */
export function StepPane({ id, children }: { id: string; children: ReactNode }) {
  const reduced = useReducedMotion();
  return (
    <motion.div key={id} data-step={id} className="absolute inset-0 flex flex-col"
      initial={{ opacity: 0, y: reduced ? 0 : 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduced ? 0 : -4, transition: { duration: dur.fast } }}
      transition={{ duration: dur.base, ease: ease.out }}>
      {children}
    </motion.div>
  );
}

/** Every onboarding screen: a top row that only holds back or close, a centred middle, actions at the bottom. */
export function Screen({ top, art, children, actions, align = "center" }: { top?: ReactNode; art?: ReactNode; children: ReactNode; actions: ReactNode; align?: "center" | "top" }) {
  return (
    <>
      <div className="mobile-screen-top flex h-[calc(var(--m-safe-top)+60px)] shrink-0 items-end px-4 pb-2">{top}</div>
      <div className={`flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-7 text-center ${align === "center" ? "justify-center" : "pt-4"} ${actions ? "" : "pb-[calc(max(var(--m-kb,0px),var(--m-safe-bottom))+16px)]"}`}>
        {art && <div className="mb-7 flex justify-center">{art}</div>}
        {children}
      </div>
      {actions && <div className="flex shrink-0 flex-col items-center gap-2 px-6 pb-[calc(max(var(--m-kb,0px),var(--m-safe-bottom))+16px)] pt-4">{actions}</div>}
    </>
  );
}

/** Back or close at the top of a covering screen: a button in the system's bar where there is one. */
export function BackButton({ onClick, close = false }: { onClick: () => void; close?: boolean }) {
  const label = t(close ? "mobile.sheet.close" : "mobile.sheet.back");
  const system = useNativeBar(BAR_RANK.screen, usePlatform().chrome ? {
    leading: [close ? { id: "leave", role: "close", label } : { id: "leave", symbol: "chevron.backward", label }],
    trailing: [],
  } : null, { leave: onClick });
  if (system) return null;
  return (
    <button type="button" onClick={onClick} aria-label={t(close ? "mobile.sheet.close" : "mobile.sheet.back")} className="mobile-press flex size-11 items-center justify-center rounded-full bg-ink/[0.06] text-ink">
      {close ? <X size={20} /> : <ChevronLeft size={21} />}
    </button>
  );
}

/** A problem said next to what caused it: the danger colour and an icon, never colour alone. */
export function ErrorLine({ id, children, action }: { id?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div id={id} role="alert" className="mt-3 flex w-full items-start gap-2 text-left text-[15px] leading-[1.45] text-danger">
      <CircleAlert size={18} aria-hidden className="mt-px shrink-0" />
      <div className="min-w-0 flex-1">{children}{action}</div>
    </div>
  );
}
