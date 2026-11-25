// The notch island: black around the camera (or a floating pill on a display without a notch). It wakes on its own only
// for what needs the person or earns a look (wake.ts): the bot it is about on the left, an emoji for why on the right,
// and only for what happens out of sight: what the person is watching in the app never shows here, and a change has to
// hold a moment before it does. Under the pointer it grows into a panel,
// on one spring (its width, height, corners and the two flares where it meets the top of the screen all ride it): every
// bot's mascot in a wrapping grid with its state, and below it any ask waiting on the person, answered in place.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion, useTransform } from "motion/react";
import { Check, Plus } from "../icons";
import { MOOD_EMOJI, isBusy, rankBots, shortAgo } from "./mood";
import { MOMENT_POSE, WAKE_EMOJI, WAKE_MOMENT, wakeCount, wakesOf, type WakeKind, type WakeMoment } from "./wake";
import { Reveal, rowLine, trayFor, useRowMoments } from "./rows";
import { attention, dotOf, eventKey, isFresh, isSeenEvent, newsOf, useSeen } from "./seen";
import { say, type AmbientLabels } from "./say";
import { BotMark, EASE_OUT, FADE, FADE_OUT, HOLD_MS, ISLAND_EXIT, useSettledSignal, useTraceTransitions, LIVELY, SETTLE, SETTLE_MS, useAllClear, useSteady, useSurfaceValue, useAmbientFeed, useChangeMoment, useNow, usePointerRegion, useStill } from "./shared";
import type { AmbientAct, AmbientBot, AmbientBridge, IslandLayout } from "./types";
import type { AmbientLabel } from "./say";

const PANEL_W = 432;
/** The flares where a notch island meets the top edge of the screen. */
const EAR = 10;
/** The island stays this long after the pointer leaves, and keeps a little margin around it while open. */
export const HOVER_OUT_MS = 260;
export const GRACE = 16;
/** The island widens this much for a moment when it wakes for something new. */
const NUDGE = 22;
const NUDGE_MS = 1600;
/** Everything answered or seen: the island smiles this long, then shrinks back to the bare notch. */
export const SMILE_MS = 2400;
const FALLBACK: IslandLayout["collapsed"] = { kind: "pill", width: 208, height: 34, top: 6, notch: 0, notchHeight: 0 };

export interface IslandProps {
  bridge: AmbientBridge;
  /** Drawn inside a page (the setup's showcase), not in its own window: the pointer is measured from the island's stage,
   * and the window losing focus means nothing. */
  embedded?: boolean;
  /** Holds the panel open, as a showcase does. */
  forceOpen?: boolean;
}

export function Island({ bridge, embedded = false, forceOpen = false }: IslandProps) {
  const { snapshot, layout } = useAmbientFeed(bridge);
  const island = layout?.surface === "island" ? layout : null;
  const reduced = useReducedMotion() === true;
  const bots = useMemo(() => snapshot?.bots ?? [], [snapshot]);
  const shown = bots;
  const labels = snapshot?.labels ?? {};

  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hovered || pinned || forceOpen;
  // a reply or failure the person has seen anywhere stops asking for their attention here
  const { seen, mark } = useSeen(bridge, bots, open);
  useSettledSignal(bridge, open);
  const live = attention(shown, seen);
  const wakes = wakesOf(live, seen);
  const [nudged, setNudged] = useState(false);

  // the most important wake, held steady: no taking turns, no swapping on every blip
  const wakeKey = useSteady(wakes[0] ? `${wakes[0].bot.id}|${wakes[0].kind}` : "", SETTLE_MS, HOLD_MS);
  const [focusId = "", focusKind = ""] = wakeKey.split("|");
  const awake = wakeKey !== "";
  // once everything that woke it is answered or seen, a smile for a moment, then only the notch
  const { smiling, cheer: allClear } = useAllClear(awake, SMILE_MS);
  const minimal = !awake && !smiling;
  const lastWake = useRef(wakeKey);
  useEffect(() => {
    const was = lastWake.current;
    lastWake.current = wakeKey;
    if (was === wakeKey || !wakeKey) return;
    setNudged(true);
    const timer = setTimeout(() => setNudged(false), NUDGE_MS);
    return () => clearTimeout(timer);
  }, [wakeKey]);

  const c = island?.collapsed ?? FALLBACK;
  const notch = c.kind === "notch";
  const stageW = island?.width ?? 560;
  const stageH = island?.height ?? 500;
  const panelW = Math.max(PANEL_W, c.width + 48);
  const maxH = stageH - c.top - 20;
  const [contentH, setContentH] = useState(0);
  const openH = Math.min(maxH, c.height + contentH);
  const restW = minimal ? (notch ? c.notch : c.height + 20) : c.width + (nudged && !reduced ? NUDGE : 0);
  const targetW = open ? panelW : restW;
  const restH = minimal && notch ? c.notchHeight || c.height : c.height;
  const targetH = open ? openH : restH;

  const traceAs = (what: string) => (bridge.trace ? (event: string, detail?: string) => bridge.trace!(`${what}:${event}`, detail) : undefined);
  const w = useSurfaceValue(targetW, reduced, undefined, ISLAND_EXIT, traceAs("width"));
  const h = useSurfaceValue(targetH, reduced, undefined, ISLAND_EXIT, traceAs("height"));
  useTraceTransitions(bridge);
  const tracedOpen = useRef<boolean | null>(null);
  useEffect(() => {
    if (tracedOpen.current === open) return;
    if (tracedOpen.current !== null) bridge.trace?.(open ? "state-open" : "state-closing", `hovered=${hovered} pinned=${pinned}`);
    tracedOpen.current = open;
  }, [open, hovered, pinned, bridge]);

  const closedR = notch ? Math.min(14, Math.round(c.height * 0.38)) : c.height / 2;
  const openR = notch ? 26 : 24;
  const r = useTransform(h, [c.height, Math.max(c.height + 1, openH)], [closedR, openR], { clamp: true });
  const clip = useTransform(() => {
    const side = Math.max(0, (panelW - w.get()) / 2);
    const bottom = Math.max(0, maxH - h.get());
    const round = r.get();
    return `inset(0px ${side}px ${bottom}px ${side}px round ${notch ? 0 : round}px ${notch ? 0 : round}px ${round}px ${round}px)`;
  });
  const leftEdge = useTransform(w, (value) => stageW / 2 - value / 2);
  const rightEdge = useTransform(w, (value) => stageW / 2 + value / 2);
  // at rest the island hides behind the camera housing, flares and all: they grow in as it widens past it
  const ear = useTransform(w, [c.notch, c.notch + 2 * EAR], [0, EAR], { clamp: true });
  const leftEar = useTransform(() => leftEdge.get() - ear.get());
  const tile = island?.tile ?? 20;
  const inset = notch ? 12 : Math.max(6, Math.round((c.height - tile) / 2) + 1);
  const tileX = useTransform(leftEdge, (value) => value + inset);
  const emojiX = useTransform(rightEdge, (value) => value - inset - tile);

  // where the island is right now, mid-spring included: only there do clicks land
  const stage = useRef<HTMLDivElement>(null);
  // open, a little margin around it still counts: brushing its edge does not fold it away
  const openNow = useRef(open);
  openNow.current = open;
  const anyBots = useRef(false);
  anyBots.current = bots.length > 0;
  const hit = useCallback((x: number, y: number) => {
    if (!anyBots.current) return false;
    const grace = openNow.current ? GRACE : 0;
    const half = w.get() / 2 + (notch ? EAR : 0) + 2 + grace;
    return Math.abs(x - stageW / 2) <= half && y >= c.top - 2 && y <= c.top + h.get() + 4 + grace;
  }, [w, h, notch, stageW, c.top]);
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hovering = usePointerRegion(bridge, hit, () => {
    clearTimeout(leaveTimer.current);
    setHovered(true);
  }, () => {
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => setHovered(false), HOVER_OUT_MS);
  }, embedded ? { ref: stage, width: stageW } : undefined);
  useEffect(() => () => clearTimeout(leaveTimer.current), []);
  // a click anywhere else (the window loses focus) puts the island away, fields and all
  useEffect(() => {
    if (embedded) return;
    const blur = () => { setPinned(false); if (!hovering.current) setHovered(false); };
    window.addEventListener("blur", blur);
    return () => window.removeEventListener("blur", blur);
  }, [hovering, embedded]);

  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = panel.current;
    if (!node) return;
    const measure = () => setContentH(Math.ceil(node.scrollHeight));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // while the person is elsewhere the mark holds still, except open, or for a moment after it changes
  const still = useStill(bridge);
  const focus = awake ? live.find((bot) => bot.id === focusId) ?? null : null;
  const kind = (awake ? focusKind : null) as WakeKind | null;
  const moment: WakeMoment | null = kind ? WAKE_MOMENT[kind] : null;
  // all clear: a smile, not the finish's party
  const emoji = smiling ? MOOD_EMOJI.idle : kind ? WAKE_EMOJI[kind] : null;
  const changed = useChangeMoment(wakeKey);
  const moving = !still || open || changed;
  // the compact island shows the most urgent; this many more wait behind it
  const more = Math.max(0, wakeCount(wakes) - 1);
  const islandLabel = more ? `${say(labels, "island")}, ${say(labels, "more", { count: more })}` : say(labels, "island");
  const close = () => { setPinned(false); setHovered(false); };
  const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };

  return (
    // no bots, no island: never an empty panel or a placeholder face (kept laid out but unseen, so it measures itself)
    <div ref={stage} className="amb-stage" data-open={open || undefined} data-empty={bots.length ? undefined : ""} style={{ width: stageW, height: stageH }} onKeyDown={onKeyDown}>
      {notch && (
        <>
          <motion.div aria-hidden className="amb-ear amb-ear-left" style={{ x: leftEar, width: ear, height: ear }} />
          <motion.div aria-hidden className="amb-ear amb-ear-right" style={{ x: rightEdge, width: ear, height: ear }} />
        </>
      )}
      <motion.section
        className="amb-island"
        data-kind={c.kind}
        data-open={open || undefined}
        aria-label={say(labels, "island")}
        style={{ left: (stageW - panelW) / 2, top: c.top, width: panelW, height: maxH, clipPath: clip }}
      >
        {/* only while closed: open, the panel's own controls take over, and nothing outlines the notch */}
        {!open && (
          <button
            type="button"
            className="amb-island-hit"
            aria-expanded={false}
            aria-label={islandLabel}
            style={{ height: c.height, left: (panelW - c.width) / 2, width: c.width }}
            onClick={() => setHovered(true)}
          />
        )}
        <motion.div
          className="amb-panel"
          inert={!open}
          style={{ paddingTop: c.height }}
          initial={false}
          animate={open ? { opacity: 1, y: 0 } : { opacity: 0, y: reduced ? 0 : -6 }}
          transition={open ? { opacity: { ...FADE, delay: 0.05 }, y: SETTLE } : { opacity: { duration: 0.2, ease: EASE_OUT }, y: ISLAND_EXIT }}
        >
          <div ref={panel}>
            <PanelBody bots={shown} seen={seen} mark={mark} cheer={allClear} labels={labels} lang={snapshot?.lang ?? ""} open={open} bridge={bridge} onPin={setPinned} />
          </div>
        </motion.div>
      </motion.section>
      {focus && !minimal && (
        <motion.div className="amb-compact amb-compact-tile" style={{ x: tileX, top: c.top + (c.height - tile) / 2, width: tile, height: tile }}>
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              key={wakeKey}
              className="amb-compact-mark"
              data-moment={moment ?? undefined}
              initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.9, y: -8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={reduced ? { opacity: 0, transition: FADE_OUT } : { opacity: 0, scale: 0.9, y: -4, transition: FADE_OUT }}
              transition={{ opacity: FADE, filter: FADE, scale: LIVELY, y: LIVELY }}
            >
              <MomentMotion moment={moment} reduced={reduced}>
                <BotMark bot={focus} size={tile} state={moment ? MOMENT_POSE[moment].state : undefined} animated={moving} moment={moment ? { key: wakeKey, reactions: MOMENT_POSE[moment].reactions } : undefined} />
              </MomentMotion>
            </motion.span>
          </AnimatePresence>
          {more > 0 && <span className="amb-more" aria-hidden>+{more}</span>}
        </motion.div>
      )}
      <motion.div className="amb-compact amb-emoji" aria-live="polite" style={{ x: emojiX, top: c.top + (c.height - tile) / 2, width: tile, height: tile, fontSize: Math.round(tile * 0.86) }}>
        <AnimatePresence initial={false} mode="popLayout">
          {emoji && <motion.span
            key={emoji}
            className="amb-emoji-glyph"
            role="img"
            data-wake={smiling ? undefined : kind ?? undefined}
            aria-label={say(labels, smiling || !kind ? "quiet" : WAKE_LABEL[kind])}
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.5, y: 6, rotate: moment === "celebrate" ? -24 : 0 }}
            animate={{ opacity: 1, scale: 1, y: 0, rotate: 0 }}
            exit={reduced ? { opacity: 0, transition: FADE_OUT } : { opacity: 0, scale: 0.96, transition: FADE_OUT }}
            transition={{ opacity: FADE, filter: FADE, scale: LIVELY, y: LIVELY, rotate: LIVELY }}
          >
            {emoji}
          </motion.span>}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}

const WAKE_LABEL: Record<WakeKind, AmbientLabel> = {
  question: "wakeQuestion", approval: "wakeApproval", "sign-in": "wakeSignIn", review: "wakeReview", "needs-you": "wakeNeedsYou",
  failed: "wakeFailed", "long-done": "wakeLongDone", scheduled: "wakeScheduled",
};

/** One beat as the mascot lands on the island: a tilt for an ask, a hop and sway for a long task done, a small shiver for
 * a failure. Played once per wake; reduced motion keeps only the fade. */
const MOMENT_MOVES: Record<WakeMoment, { keyframes: Record<string, number[]>; duration: number }> = {
  nudge: { keyframes: { rotate: [0, -12, 10, -6, 0] }, duration: 0.7 },
  celebrate: { keyframes: { y: [0, -5, 0, -2, 0], rotate: [0, -8, 8, -3, 0] }, duration: 0.85 },
  worried: { keyframes: { x: [0, -1.5, 1.5, -1, 1, 0], y: [0, 1, 1, 1, 0.5, 0] }, duration: 0.5 },
};

function MomentMotion({ moment, reduced, children }: { moment: WakeMoment | null; reduced: boolean; children: ReactNode }) {
  const move = moment && !reduced ? MOMENT_MOVES[moment] : null;
  return (
    <motion.span
      className="amb-moment"
      initial={false}
      animate={move ? move.keyframes : {}}
      transition={move ? { duration: move.duration, ease: "easeInOut", delay: 0.18 } : undefined}
    >
      {children}
    </motion.span>
  );
}

/** The open island: every bot as a mascot in a grid that wraps onto as many rows as it needs (past four it scrolls), the
 * most urgent first, each with its state as the dock shows it (blue working, green unseen reply, a numbered bubble for
 * asks, "!" for a failure). A click opens that bot in the app; an ask waiting on the person is answered below the grid,
 * only for that bot. */
function PanelBody({ bots, seen, mark, cheer, labels, lang, open, bridge, onPin }: {
  bots: readonly AmbientBot[]; seen: ReadonlySet<string>; mark: (keys: string[]) => void; cheer: number; labels: AmbientLabels; lang: string; open: boolean;
  bridge: AmbientBridge; onPin: (pinned: boolean) => void;
}) {
  const all = rankBots(attention(bots, seen));
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  const { sent, cheering, markSent } = useRowMoments(bots);
  const openChat = (bot: AmbientBot) => {
    if (isFresh(bot, seen)) mark([eventKey(bot)]);
    bridge.open(bot.id, bot.threadId);
  };
  const act = (bot: AmbientBot, next: AmbientAct) => {
    if (next.kind === "answer" || next.kind === "allow" || next.kind === "deny") markSent(bot);
    bridge.act(next);
  };
  // asks are answered here even for a bot the person is watching in the app, as the rows did
  const asking = all.map((shown) => byId.get(shown.id) ?? shown).filter((bot) => bot.status === "needs-you");

  // no line under a hovered mascot: in a grid a tip either covers the next row or runs past the panel's clipped edge
  const now = useNow(open);

  return (
    <div className="amb-panel-body amb-strip-wrap">
      <ul className="amb-strip" aria-label={say(labels, "island")}>
        {all.map((shown, index) => {
          const bot = byId.get(shown.id) ?? shown;
          const news = newsOf(bot, seen);
          const dot = dotOf(bot, news);
          const bubble = news === "ask" || news === "error" ? news : null;
          const state = statusLine(bot, seen, labels, lang, now);
          const word = statusLine(bot, seen, labels, lang, now, true);
          return (
            <li key={bot.id} className="amb-strip-cell" data-row={bot.id} data-status={shown.status}>
              <button
                type="button"
                className="amb-strip-bot"
                aria-label={[say(labels, "open", { name: bot.name }), state].filter(Boolean).join(". ")}
                onClick={() => openChat(bot)}
              >
                <span className="amb-strip-mark">
                  <span className="amb-lift">
                    <BotMark bot={bot} size={28} state={cheering.has(bot.id) ? "celebrate" : sent.has(bot.id) ? "approving" : isSeenEvent(bot, seen) ? "idle" : undefined} animated={open} awake={open} shown={open} index={index} cheer={cheer} />
                  </span>
                  {bubble && <span className="amb-bubble" data-kind={bubble} aria-hidden>{bubble === "ask" ? Math.max(1, bot.asks) : "!"}</span>}
                  {dot && <span className="amb-state-dot" data-state={dot} aria-hidden />}
                </span>
                <span className="amb-strip-name" aria-hidden>{bot.name}</span>
                <span className="amb-strip-state" data-status={bot.status} aria-hidden>{word}</span>
              </button>
            </li>
          );
        })}
        <li className="amb-strip-cell">
          <button type="button" className="amb-strip-plus" aria-label={say(labels, "newBot")} title={say(labels, "newBot")} onClick={() => bridge.act({ kind: "new-bot" })}>
            <Plus size={16} strokeWidth={1.5} aria-hidden />
          </button>
        </li>
      </ul>
      <AnimatePresence initial={false}>
        {asking.map((bot) => (
          <Reveal key={bot.id} className="amb-tray-wrap">
            <Ask bot={bot} labels={labels} open={open} sent={sent.has(bot.id)} onAct={(next) => act(bot, next)} onOpen={() => openChat(bot)} onPin={onPin} />
          </Reveal>
        ))}
      </AnimatePresence>
    </div>
  );
}

/** A grid cell's status in a word or two: what it is doing, its fresh reply or failure with when, or (resting, or
 * news already seen) only when it was last active. `short`: the one word drawn under a 48px mascot (an ask is
 * "waiting", a fresh reply drops its when), the full line staying in the cell's name for a screen reader. */
export function statusLine(bot: AmbientBot, seen: ReadonlySet<string>, labels: AmbientLabels, lang: string, now: number, short = false): string {
  const ago = shortAgo(bot.at, now, lang, say(labels, "now"));
  if (short && bot.status === "needs-you") return say(labels, "waiting") || say(labels, bot.status);
  if (isBusy(bot.status) || bot.status === "needs-you") return say(labels, bot.status);
  if (bot.status === "done" && isFresh(bot, seen)) return short ? say(labels, "done") : [say(labels, "done"), ago].filter(Boolean).join(" ");
  if (bot.status === "error" && isFresh(bot, seen)) return say(labels, "error");
  return ago;
}

/** One bot's ask under the row: whose it is and what it asks, answered in place. */
function Ask({ bot, labels, open, sent, onAct, onOpen, onPin }: {
  bot: AmbientBot; labels: AmbientLabels; open: boolean; sent: boolean; onAct: (act: AmbientAct) => void; onOpen: () => void; onPin: (pinned: boolean) => void;
}) {
  const [field, setField] = useState<"reply" | "answer" | null>(null);
  useEffect(() => { if (!open) setField(null); }, [open]);
  useEffect(() => { if (field === "answer" && !bot.question?.custom) setField(null); }, [field, bot.question]);
  const tray = sent ? null : trayFor(bot, labels, field, setField, (next) => { setField(null); onAct(next); }, onOpen, onPin);
  return (
    <div className="amb-ask" data-ask={bot.id}>
      <p className="amb-ask-line" dir="auto">
        <span className="amb-ask-name">{bot.name}</span>
        {sent ? <span className="amb-ask-sent"><Check size={12} strokeWidth={2.25} aria-hidden />{say(labels, "sent")}</span> : <span>{rowLine(bot, labels).text}</span>}
      </p>
      {tray && <div className="amb-tray">{tray}</div>}
    </div>
  );
}
