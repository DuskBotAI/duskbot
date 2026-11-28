import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronDown } from "../icons";
import { cn } from "@/lib/cn";
import { LINE_SPECS, WORKING_LINE, type WorkingLinePick } from "@/lib/working-line";
import { usePrefersReducedMotion } from "@/components/mascot-clock";
import { phraseAt, phraseHoldMs, rotationHoldMs } from "@/lib/live-activity";
import { quietText } from "@/lib/now-steps";
import { t } from "@/lib/i18n";
import { plainWord, startsAnywhere, TYPING_PHASE, workingWord } from "@/lib/friendly-activity";
import { wordGroup } from "@/lib/working-mood";
import type { StepQuiet } from "../../shared/turn-progress";

const FADE_MS = 320;
export const STATUS_EXIT_MS = LINE_SPECS[WORKING_LINE].exitMs;

export function useRotatingPhrase(
  phrases: readonly string[],
  phase: string,
  seed: string,
  active: boolean,
): { current: string; previous: string | null } {
  const phaseSeed = `${seed}|${phase}`;
  const [clock, setClock] = useState({ phaseSeed, step: 0 });
  if (clock.phaseSeed !== phaseSeed) setClock({ phaseSeed, step: 0 });
  const step = clock.phaseSeed === phaseSeed ? clock.step : 0;
  const [previous, setPrevious] = useState<string | null>(null);
  const current = phraseAt(phrases, phaseSeed, step);
  const shown = useRef(current);

  useEffect(() => {
    if (!active || phrases.length < 2) return;
    const timer = setTimeout(() => setClock({ phaseSeed, step: step + 1 }), phraseHoldMs(phaseSeed, step));
    return () => clearTimeout(timer);
  }, [active, phrases.length, phaseSeed, step]);

  useEffect(() => {
    if (shown.current === current) return;
    setPrevious(shown.current);
    shown.current = current;
    const timer = setTimeout(() => setPrevious(null), FADE_MS);
    return () => clearTimeout(timer);
  }, [current]);

  return { current, previous };
}

const SHEEN_PERIOD_MS = 2000;

function ShimmerPhrase({ text, className }: { text: string; className?: string }) {
  const [delay] = useState(() => `-${Date.now() % SHEEN_PERIOD_MS}ms`);
  return (
    <span className={cn("thinking-shimmer [grid-area:1/1]", className)} style={{ "--sheen-period": `${SHEEN_PERIOD_MS}ms`, "--sheen-delay": delay } as CSSProperties}>
      {text}
      <span aria-hidden="true" className="thinking-sheen"><span data-text={text} /></span>
    </span>
  );
}

/** How the line's words change: the old words blur out as the new ones come in from a blur, both in the same cell at
 * once, so the line never shows neither; the cell's width eases from the old words' to the new. */
export const WORD_SWAP = { duration: 880, easing: "cubic-bezier(0.22, 1, 0.36, 1)", blurPx: 4 } as const;
/** How long words stay fully readable once their blur in has ended, before anything may replace them. */
export const WORD_DWELL_MS = 5000;
/** A pool's words rotate only once the turn has run this long; a shorter turn keeps its one phrase. */
export const LONG_TURN_MS = 15_000;

/** The status label rules: the mark comes alone, its first words follow 1.8 to 2.6 s after the send (drawn per turn,
 * about 1.2 to 1.4 s after the mark). Whatever the line says then stays for its swap and a full dwell (STATUS_HOLD_MS)
 * before the next step's words, however fast the steps come: the newest step wins and the ones between are never said.
 * Plain words (Thinking, Working) are the exception: a step's own words take their place once they have been up for a
 * swap (WORD_SWAP.duration). Steps in one coarse group (wordGroup) keep the words they found. In a long turn a pool's
 * words move to another of them 7 to 9 s after the last swap ended. */
export const STATUS_QUIET_MS = { min: 1800, max: 2600 } as const;
export const STATUS_HOLD_MS = WORD_SWAP.duration + WORD_DWELL_MS;
const wordHoldMs = (seed: string, step: number) => WORD_SWAP.duration + rotationHoldMs(seed, step);
export { TYPING_PHASE };

function quietFor(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
  return STATUS_QUIET_MS.min + ((hash >>> 0) % (STATUS_QUIET_MS.max - STATUS_QUIET_MS.min));
}

type ShownLabel = { phase: string; step: number; text: string; at: number; key: string };

/** Words that say nothing about the step: the line's own Thinking and the pools with no lead phrase. */
const plainPhase = (phase: string) => phase === "label:thinking" || startsAnywhere(phase);

/** Writing a reply only moves forward: its words in order, then the last one held, never back to the first. */
export function typingWord(pool: readonly string[], step: number): string {
  return pool[Math.min(step, pool.length - 1)] ?? "";
}

/** The step label the simple status line shows now, or null while the line is still quiet. Plain work rotates through
 * `phrases` with `fun` ones mixed in as the turn runs long (workingWord); a step leads with its own words. */
export function useStatusLabel(phrases: readonly string[] | null, phase: string, seed: string, since: number | null, active: boolean, fun: readonly string[] = NOTHING, wordsAtOnce = false): { key: string; text: string; phase: string } | null {
  const [, wake] = useState(0);
  const shown = useRef<ShownLabel | null>(null);
  const firstSeen = useRef<number | null>(null);
  const now = Date.now();
  if (!active) firstSeen.current = null;
  else firstSeen.current ??= now;
  const typing = phase === TYPING_PHASE;
  const start = since ?? firstSeen.current ?? now;
  const quietUntil = wordsAtOnce ? start : start + quietFor(`${seed}|quiet`);
  const pool = phrases && phrases.length > 0 ? phrases : null;
  const phaseSeed = `${seed}|${phase}`;
  const plain = startsAnywhere(phase);
  const say = (step: number, previous?: string) => !pool ? "" : typing ? typingWord(pool, step) : plain ? workingWord(pool, fun, phaseSeed, step, now - start, previous) : phraseAt(pool, phaseSeed, step);
  const label = (step: number, previous?: string): ShownLabel => ({ phase, step, text: say(step, previous), at: now, key: `${phase}#${step}` });
  const held = shown.current;
  const holdUntil = held ? held.at + STATUS_HOLD_MS : 0;
  const rotateAt = (from: ShownLabel) => Math.max(from.at + wordHoldMs(phaseSeed, from.step), start + LONG_TURN_MS);
  const rotates = (from: ShownLabel) => Boolean(pool && pool.length > 1 && !(typing && from.step >= pool.length - 1));
  // a step's own words take over from plain ones once those have been up for their swap
  const gives = Boolean(held && pool && held.phase !== phase && plainPhase(held.phase) && !plainPhase(phase));
  const givesAt = gives && held ? held.at + WORD_SWAP.duration : 0;
  let next: ShownLabel | null;
  if (held && pool && held.phase !== phase && !gives && wordGroup(held.phase) === wordGroup(phase)) next = { ...held, phase };
  else if (held && (held.phase !== phase || !pool) && now < (gives ? givesAt : holdUntil)) next = held;
  else if (held && pool && held.phase === phase) next = rotates(held) && now >= rotateAt(held) ? label(held.step + 1, held.text) : held;
  else if (!pool || !(typing || now >= quietUntil)) next = null;
  else next = label(0);
  shown.current = next;
  const nextTurn = next && pool && next.phase === phase && rotates(next) ? rotateAt(next) : 0;
  const due = Math.min(...[quietUntil, holdUntil, nextTurn, givesAt].filter((at) => at > now));
  useEffect(() => {
    if (!active || !Number.isFinite(due)) return;
    const timer = setTimeout(() => wake((tick) => tick + 1), due - Date.now());
    return () => clearTimeout(timer);
  }, [active, due]);
  return active && next ? { key: next.key, text: next.text, phase: next.phase } : null;
}

/** Grok's shimmer: the words in 40% ink with a full-ink band swept across them by background-position, 2.2s in 60
 * steps. */
function StatusShimmer({ text }: { text: string }) {
  return <span className="status-shimmer">{text}</span>;
}

type StepWords = { key: string; text: string };

/** The step's words. The first ones rise in with the line; each later change is a WORD_SWAP crossfade, and under
 * reduced motion an instant swap. */
function StepPhrase({ step, hover }: { step: StepWords; hover?: string }) {
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState(step);
  const [leaving, setLeaving] = useState<StepWords | null>(null);
  const [swapped, setSwapped] = useState(false);
  if (shown.key !== step.key || shown.text !== step.text) {
    setLeaving(reduced ? null : shown);
    setShown(step);
    setSwapped(true);
  }
  const cell = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const box = cell.current;
    const out = box?.querySelector<HTMLElement>("[data-word-out]");
    const into = box?.querySelector<HTMLElement>("[data-word-in]");
    if (!leaving || !box || !out || !into || typeof into.animate !== "function") {
      if (leaving) setLeaving(null);
      return;
    }
    const from = out.offsetWidth, to = into.offsetWidth;
    // whole words while the width eases, so no ellipsis slides along them
    for (const word of [out, into]) word.style.width = "max-content";
    const timing = { duration: WORD_SWAP.duration, easing: WORD_SWAP.easing };
    const fade = out.animate([{ opacity: 1 }, { opacity: 0 }], { ...timing, fill: "forwards" });
    into.animate([{ opacity: 0 }, { opacity: 1 }], { ...timing, fill: "backwards" });
    const width = Math.abs(from - to) >= 1 ? box.animate([{ width: `${from}px` }, { width: `${to}px` }], { ...timing, fill: "forwards" }) : null;
    fade.onfinish = () => setLeaving(null);
    return () => {
      fade.onfinish = null;
      fade.cancel();
      width?.cancel();
      into.style.width = "";
    };
  }, [leaving]);
  const word = (words: StepWords, out: boolean) => (
    <span
      key={`${words.key}|${words.text}`}
      className={cn("flex min-w-0 items-center justify-self-start [grid-area:1/1]", !swapped && "turn-label-in")}
      title={out ? undefined : hover}
      aria-hidden={out || undefined}
      data-turn-now={out ? undefined : ""}
      {...(out ? { "data-word-out": "" } : leaving ? { "data-word-in": "" } : {})}
    >
      <StatusShimmer text={words.text} />
    </span>
  );
  return (
    <span ref={cell} className="grid min-w-0">
      {leaving && word(leaving, true)}
      {word(shown, false)}
    </span>
  );
}

const NOTHING: readonly string[] = [];
// The spaces keep copied text readable; the flex gap does the spacing on screen.
const Dot = () => <span aria-hidden="true" className="text-[12px] text-ink-tertiary"> · </span>;

/** "last output 2 min ago" counts on by itself; the other states change only with a new frame. */
function QuietPart({ quiet }: { quiet: StepQuiet }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (quiet.kind !== "output") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [quiet]);
  return <><Dot /><span data-turn-quiet="" className="text-[12px] text-ink-tertiary">{quietText(quiet, now)}</span></>;
}

/** The turn's live status line: "Working · Running scrape.py · busy, no output yet". It never counts seconds. The lead
 * word stays for the whole turn; `phrases` say what is happening now and rotate through their alternates; `size` is how
 * much of the file is written; `quiet` is how a long step is doing. With nothing to say the line is the lead alone. The part that is live shimmers. `simple` draws Simple mode's quiet line instead: the avatar and one phrase for
 * what is happening now. With a `card`, the line is a button that unfolds it underneath. */
export function TurnPresence({
  avatar,
  visible,
  label,
  phrases,
  fun,
  phase,
  seed = "",
  answering = false,
  since = null,
  size,
  simple = false,
  detail,
  hover,
  quiet,
  card,
  cardLabel,
  wordsAtOnce,
  line = WORKING_LINE,
  className,
}: {
  /** a mark before the words; without one the line is the words alone, from its first frame */
  avatar?: ReactNode | ((shownPhase: string | null) => ReactNode);
  /** with a mark, the words still come from the first frame (Thinking) instead of after the mark's quiet beat */
  wordsAtOnce?: boolean;
  visible: boolean;
  label?: string;
  phrases?: readonly string[];
  /** Playful words plain work mixes in as the turn runs long. */
  fun?: readonly string[];
  phase?: string;
  seed?: string;
  answering?: boolean;
  since?: number | null;
  size?: string;
  simple?: boolean;
  /** Simple mode: Advanced's wording for what is happening now, kept in the row's tooltip with the size. */
  detail?: string;
  /** The whole command, query or address behind the phrase. */
  hover?: string;
  quiet?: StepQuiet;
  card?: ReactNode;
  cardLabel?: string;
  line?: WorkingLinePick;
  className?: string;
}) {
  const [mounted, setMounted] = useState(visible);
  const [presencePhase, setPhase] = useState<"think" | "answer" | "out">(answering ? "answer" : "think");
  const [open, setOpen] = useState(false);
  const wasAnswering = useRef(answering);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const cardId = useId();
  const statusId = useId();

  useEffect(() => {
    if (visible) {
      setMounted(true);
      setPhase(answering ? "answer" : "think");
      wasAnswering.current = answering;
      return;
    }
    if (!mounted) return;
    const handoff = wasAnswering.current;
    wasAnswering.current = false;
    if (handoff) {
      setMounted(false);
      return;
    }
    setPhase("out");
    const timer = setTimeout(() => setMounted(false), simple ? LINE_SPECS[line].exitMs : 280);
    return () => clearTimeout(timer);
  }, [visible, answering, mounted, simple, line]);

  const showWorking = presencePhase === "think";
  // grok's line leaves with the words it was saying
  const simpleStatus = simple && (showWorking || presencePhase === "out");
  const expandable = Boolean(card) && showWorking;
  useEffect(() => {
    if (!expandable) setOpen(false);
  }, [expandable]);
  useEffect(() => {
    if (!open) return;
    const fold = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const inside = Boolean(root.current?.contains(document.activeElement));
      if (!inside && document.activeElement && document.activeElement !== document.body) return;
      event.preventDefault();
      setOpen(false);
      if (inside) toggle.current?.focus();
    };
    document.addEventListener("keydown", fold);
    return () => document.removeEventListener("keydown", fold);
  }, [open]);
  const lead = label ?? t("chat.activity.working");
  const now = phrases && phrases.length > 0 ? phrases : null;
  const { current, previous } = useRotatingPhrase(now ?? NOTHING, phase ?? now?.[0] ?? "", seed, !simple && mounted && showWorking && now !== null);
  const marked = avatar !== undefined;
  const wordless = !label && !now;
  const atOnce = wordsAtOnce ?? !marked;
  const step = useStatusLabel(label ? [label] : now ?? (atOnce ? [plainWord("thinking")] : null), label ? `label:${label}` : wordless && atOnce ? "label:thinking" : phase ?? now?.[0] ?? "", seed, since, mounted && simpleStatus, label ? NOTHING : fun, atOnce);
  if (!mounted) return null;
  const mark = typeof avatar === "function" ? avatar(step?.phase ?? null) : avatar;
  const status = simpleStatus ? (
    <span id={statusId} className="turn-label-slot flex h-[22px] min-w-0 items-center gap-x-1.5 text-[13.5px] leading-[21px]" data-turn-status>
      {step && <StepPhrase step={step} hover={hover} />}
      {step && LINE_SPECS[line].ellipsis && <span aria-hidden="true" className="working-ellipsis"><span>.</span><span>.</span><span>.</span></span>}
      {step && quiet && <QuietPart quiet={quiet} />}
    </span>
  ) : showWorking ? (
    <span id={statusId} className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-1 leading-none" data-turn-status>
      {now ? <span className="text-[13px] text-ink-secondary">{lead}</span> : <ShimmerPhrase text={lead} className="text-[13px]" />}
      {now && (
        <>
          <Dot />
          {/* One phrase at a time: a fading old phrase sat out of flow and a longer one drew over the size beside it. */}
          <span className="turn-phrase relative grid min-w-0 max-w-full text-[13px]" title={hover} data-turn-now>
            <ShimmerPhrase
              key={`in:${current}`}
              text={current}
              className={cn("truncate", previous !== null && "turn-phrase-in")}
            />
          </span>
          {size && (
            <>
              <Dot />
              <span className="text-[12px] tabular-nums text-ink-tertiary" data-turn-size>{size}</span>
            </>
          )}
          {quiet && <QuietPart quiet={quiet} />}
        </>
      )}
    </span>
  ) : null;
  return (
    <div ref={root} className={cn("turn-presence flex min-w-0 max-w-full flex-col items-start", className)}>
      <div
        data-working-line={line === "shipped" ? undefined : line}
        title={simple && showWorking ? [lead, detail ?? (now ? current : null), size].filter(Boolean).join(" · ") : undefined}
        className={cn(
          simple ? cn("flex h-9 min-w-0 max-w-full items-center gap-[8.5px]", marked ? "ps-2" : "ps-3") : "flex min-w-0 max-w-full items-center gap-2",
          presencePhase === "think" && (simple ? "turn-status-in" : "turn-mascot-in"),
          presencePhase === "out" && (simple ? "turn-status-out" : "turn-mascot-out"),
        )}
      >
        {/* a px down: the words' optical middle sits between cap and x-height, below their line box's middle */}
        {marked && (simple ? <span className="turn-status-mark relative top-px inline-flex shrink-0">{mark}</span> : mark)}
        {expandable && (!simple || step) ? (
          <button
            ref={toggle}
            type="button"
            aria-expanded={open}
            aria-controls={cardId}
            aria-label={cardLabel}
            aria-describedby={statusId}
            onClick={() => setOpen((shown) => !shown)}
            className="turn-now-toggle"
          >
            {status}
            <ChevronDown aria-hidden="true" size={12} strokeWidth={2} className={cn("turn-now-chevron", open && "rotate-180")} />
          </button>
        ) : status}
      </div>
      {expandable && (!simple || step) && open && (
        <div id={cardId} role="region" aria-label={cardLabel} className="turn-now-card">
          {card}
        </div>
      )}
    </div>
  );
}
