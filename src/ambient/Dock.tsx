// The bot dock: a slim black column of mascots against the right edge of the screen that flares into it at both ends.
// At rest only a sliver shows, ticked where a bot works, replied or waits. The pointer resting at the edge (or a click
// there) slides the column in; passing by, dragging or sliding along the edge does not (edge-intent.ts).
// resting on a bot (or moving onto it) brings out one card beside the column with that bot's status, its ask answered
// right there. The card is one element for the whole visit: it glides and resizes from bot to bot and only goes once
// the pointer has left both. A mascot carries a bubble only for news: an ask, an unseen reply, an unseen failure.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { AnimatePresence, Reorder, motion, useDragControls, useReducedMotion, useTransform } from "motion/react";
import { Plus } from "../icons";
import { createEdgeIntent } from "./edge-intent";
import { dockOrder, isBusy } from "./mood";
import { HISTORY, MiniChat, type ChatScroll } from "./MiniChat";
import { useRowMoments } from "./rows";
import { LOOK_MS, attention, dotOf, eventKey, isFresh, isSeenEvent, newsOf, useSeen, type News } from "./seen";
import { say, type AmbientLabels } from "./say";
import { SPRING } from "@/lib/motion-presets";
import { BotMark, EASE_OUT, FADE, FADE_OUT, LIVELY, SETTLE, useAllClear, useSettledSignal, useTraceTransitions, useAmbientFeed, useNow, usePointerRegion, useSurfaceValue } from "./shared";
import type { AmbientAct, AmbientBot, AmbientBridge, AmbientMessage, DockLayout } from "./types";

export { dotOf, newsOf };

/** How near the right edge the pointer has to be, beside the body, to bring the dock in. */
const EDGE = 14;
/** Off the bots and the card, the card goes almost at once (a slip of the pointer is forgiven); the column follows a
 * good while later, so the two never vanish together. */
export const CARD_LEAVE_MS = 300;
export const HIDE_MS = 730;
/** This much around the card and the column still counts as on them, so heading back never closes anything. */
const GRACE = 16;
/** The first card of a visit waits for intent: resting on a bot this long, or moving this far on the column. */
export const DWELL_MS = 450;
const NUDGE_PX = 6;
/** A bot that starts needing the person, or fails, brings the dock out this long. */
const PEEK_MS = 3600;
const RADIUS = 22;
export const CARD_W = 304;
/** The card's chat at its tallest: a share of the screen's height, never past CHAT_MAX_H (nor under CHAT_MIN_H unless
 * the screen is that short); messages scroll inside, the field stays put. */
export const CHAT_SHARE = 0.6;
export const CHAT_MAX_H = 500;
const CHAT_MIN_H = 360;
/** Moving from bot to bot, the card's words swap in place and settle from slightly faint in this long. */
export const SWAP_MS = 120;
/** The longest stretch of a bot's chat the card keeps between visits. */
const KEPT_MESSAGES = 120;

const CARD_GAP = 10;
const CARD_MARGIN = 8;
/** The card leaves quickly and smoothly, words and all, where it was: a fade with a touch of scale and drift. */
const CARD_OUT = { duration: 0.14, ease: EASE_OUT } as const;
const JUMP = { duration: 0 } as const;
/** The column slides out on the soft spring and away in 250ms on the out curve, after a 60ms beat. */
const COLUMN_AWAY = { duration: 0.25, ease: EASE_OUT, delay: 0.06 } as const;
/** The card grows out of its bot: width first (the stiffer spring), then height. */
const GROW_W = { type: "spring", stiffness: 380, damping: 26, mass: 1 } as const;
const GROW_H = SPRING.height;
/** Hidden, the card waits small beside its bot so it grows out of it next time. */
const SMALL = { scaleX: 0.6, scaleY: 0.5 } as const;
// one empty list for "nothing yet": a fresh [] each render would rerun the order effect forever
const NONE: readonly never[] = [];
const FALLBACK_DOCK: DockLayout["dock"] = { cell: 56, tile: 36, column: 64, open: 404, pad: 8, ear: 18, sliver: 6, margin: 28, overhang: 4 };

export function Dock({ bridge }: { bridge: AmbientBridge }) {
  const { snapshot, layout } = useAmbientFeed(bridge);
  const dock = layout?.surface === "dock" ? layout : null;
  const reduced = useReducedMotion() === true;
  // the same words every summary: kept as one object, so the mascots are not drawn again for each streamed word
  const labelsKey = JSON.stringify(snapshot?.labels ?? {});
  const labels = useMemo(() => JSON.parse(labelsKey) as AmbientLabels, [labelsKey]);
  const bots: readonly AmbientBot[] = snapshot?.bots ?? NONE;
  const lang = snapshot?.lang ?? "";
  const d = dock?.dock ?? FALLBACK_DOCK;
  // the window runs past the screen's edge (ambient-geometry.mjs): the body paints into that strip, so no seam can show
  const over = d.overhang ?? 0;
  const stageW = dock?.width ?? d.open + over;
  const edge = stageW - over;
  const columnLeft = edge - d.column;
  const cardLeft = columnLeft - CARD_GAP - CARD_W;
  const stageH = dock?.height ?? 720;
  const maxBody = dock?.body ?? stageH - 2 * (d.ear + d.margin);

  const [ids, setIds] = useState<string[]>([]);
  const idsNow = useRef(ids);
  idsNow.current = ids;
  const dragging = useRef(false);
  const moved = useRef(false);
  useEffect(() => {
    if (dragging.current) return;
    const next = dockOrder(bots, dock?.order ?? NONE).map((bot) => bot.id);
    // every summary brings new bot objects: the order changing is what counts
    setIds((was) => (was.length === next.length && was.every((id, index) => id === next[index]) ? was : next));
  }, [bots, dock?.order]);
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  const shown = ids.map((id) => byId.get(id)).filter((bot): bot is AmbientBot => Boolean(bot));

  const [out, setOut] = useState(false);
  const [peek, setPeek] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [card, setCard] = useState<string | null>(null);
  // the last bot the card showed, kept while it goes so its words leave with it
  const [lastCard, setLastCard] = useState<string | null>(null);
  useEffect(() => { if (card) setLastCard(card); }, [card]);
  const slidOut = out || peek || pinned || card !== null;

  const { seen, mark } = useSeen(bridge, bots, false);
  useSettledSignal(bridge, slidOut);
  // the dock's side of the trace: the column coming and going, the card showing a bot or leaving
  const traced = useRef({ slidOut: false, card: null as string | null });
  useEffect(() => {
    if (traced.current.slidOut !== slidOut) bridge.trace?.(slidOut ? "state-column-out" : "state-column-closing", `out=${out} peek=${peek} pinned=${pinned}`);
    if (traced.current.card !== card) bridge.trace?.(card ? "state-card" : "state-card-closing", card ? "a bot" : "");
    traced.current = { slidOut, card };
  }, [slidOut, card, out, peek, pinned, bridge]);
  // everything answered or seen: the whole column cheers once
  const { cheer } = useAllClear(attention(bots, seen).some((bot) => bot.status !== "idle"), 2400);

  // someone starts needing the person, or fails: the column comes out for a moment on its own, no card
  const calling = bots.filter((bot) => !bot.quiet && (bot.status === "needs-you" || (bot.status === "error" && isFresh(bot, seen)))).map((bot) => bot.id).join(",");
  const lastCalling = useRef<string | null>(null);
  const peekTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!snapshot) return;
    const first = lastCalling.current === null;
    const before = new Set((lastCalling.current ?? "").split(",").filter(Boolean));
    lastCalling.current = calling;
    // the first summary is how things stand, not news
    if (first || !calling.split(",").some((id) => id && !before.has(id))) return;
    setPeek(true);
    clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => setPeek(false), PEEK_MS);
  }, [calling, snapshot]);
  useEffect(() => () => clearTimeout(peekTimer.current), []);

  // the column is as tall as its bots, centred on the edge, and slides in from the right
  const content = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [contentH, setContentH] = useState(d.cell + 2 * d.pad);
  useLayoutEffect(() => {
    const node = content.current;
    if (!node) return;
    const measure = () => setContentH(node.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const bodyH = Math.min(contentH, maxBody);
  const traceAs = (what: string) => (bridge.trace ? (event: string, detail?: string) => bridge.trace!(`${what}:${event}`, detail) : undefined);
  const h = useSurfaceValue(bodyH, reduced, undefined, undefined, traceAs("height"));
  const slide = useSurfaceValue(slidOut ? 0 : d.column - d.sliver, reduced, slidOut, COLUMN_AWAY, traceAs("column"), SPRING.soft);
  useTraceTransitions(bridge);
  const top = useTransform(h, (value) => Math.round((stageH - value) / 2));
  const clip = useTransform(() => {
    const t = top.get();
    return `inset(${t}px 0px ${Math.max(0, stageH - t - h.get())}px ${Math.max(0, columnLeft)}px round ${RADIUS}px 0px 0px ${RADIUS}px)`;
  });
  const earTop = useTransform(top, (value) => value - d.ear);
  const earBottom = useTransform(() => top.get() + h.get());

  // the card: one element, placed beside the bot it shows and as tall as what it says
  const cardInner = useRef<HTMLDivElement>(null);
  const [cardH, setCardH] = useState(64);
  useLayoutEffect(() => {
    const node = cardInner.current;
    if (!node) return;
    const measure = () => setCardH(node.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const [anchor, setAnchor] = useState(stageH / 2);
  const shownId = card ?? lastCard;
  useLayoutEffect(() => {
    const row = shownId ? list.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(shownId)}"]`) : null;
    if (!row || !list.current) return;
    setAnchor(top.get() + list.current.offsetTop + row.offsetTop - list.current.scrollTop + row.offsetHeight / 2);
  }, [shownId, contentH, ids, bodyH, top]);
  const cardY = Math.round(Math.min(stageH - cardH - CARD_MARGIN, Math.max(CARD_MARGIN, anchor - cardH / 2)));
  const cardShown = card !== null;
  // leaving, the card keeps the place and size it had: its words may still change (the long chat handed back, a reply
  // marked seen) and must not move or resize it while it fades
  const leavingAt = useRef({ y: cardY, h: cardH });
  if (cardShown) leavingAt.current = { y: cardY, h: cardH };
  // gliding is for moving between bots; a card coming out appears where the bot is
  const wasShown = useRef(false);
  const glide = wasShown.current && !reduced ? SPRING.settle : JUMP;
  useEffect(() => { wasShown.current = cardShown; });

  const live = useRef({ slidOut, cardShown, cardY, cardH });
  live.current = { slidOut, cardShown, cardY, cardH };
  const overCard = useCallback((x: number, y: number) => {
    const { cardShown: showing, cardY: cy, cardH: ch } = live.current;
    // the gap between the card and the column counts, so crossing it never closes the card
    return showing && x >= cardLeft - GRACE && x <= columnLeft + 2 && y >= cy - GRACE && y <= cy + ch + GRACE;
  }, [cardLeft, columnLeft]);
  // where clicks land: the column where it is headed (a quick move onto a mascot while it still slides in must not
  // count as leaving), or the card
  const anyBots = useRef(false);
  anyBots.current = bots.length > 0;
  const hit = useCallback((x: number, y: number) => {
    if (!anyBots.current) return false;
    if (overCard(x, y)) return true;
    const t = top.get();
    if (!live.current.slidOut) return y >= t - d.ear && y <= t + h.get() + d.ear && x >= edge - EDGE;
    return y >= t - d.ear - GRACE && y <= t + h.get() + d.ear + GRACE && x >= columnLeft - GRACE;
  }, [overCard, top, h, d.ear, edge, columnLeft]);
  // what takes clicks: only what is drawn (the sliver at rest, the column and the card once out); the edge zone and the
  // grace around them still hear the pointer, but a click there lands in the app underneath
  const solid = useCallback((x: number, y: number) => {
    if (!anyBots.current) return false;
    const { slidOut: outNow, cardShown: showing, cardY: cy, cardH: ch } = live.current;
    if (showing && x >= cardLeft && x <= cardLeft + CARD_W && y >= cy && y <= cy + ch) return true;
    const t = top.get();
    return y >= t - d.ear && y <= t + h.get() + d.ear && x >= (outNow ? columnLeft : edge - d.sliver);
  }, [cardLeft, top, h, d.ear, d.sliver, edge, columnLeft]);

  // a visit: from the column coming out to it going away. Its first card waits for intent; after that, moving from bot
  // to bot moves the card at once.
  const chosen = useRef(false);
  const landing = useRef<{ x: number; y: number; id: string } | null>(null);
  const under = useRef<string | null>(null);
  const dwell = useRef<ReturnType<typeof setTimeout>>(undefined);
  const cardLeave = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pinnedNow = useRef(pinned);
  pinnedNow.current = pinned;
  const show = useCallback((id: string) => {
    clearTimeout(dwell.current);
    clearTimeout(cardLeave.current);
    chosen.current = true;
    setCard(id);
  }, []);
  const letGo = useCallback(() => {
    clearTimeout(dwell.current);
    clearTimeout(cardLeave.current);
    cardLeave.current = setTimeout(() => { if (!pinnedNow.current) setCard(null); }, CARD_LEAVE_MS);
  }, []);
  // judged on real pointer moves only, so arriving from far away is never mistaken for a move on the column
  const consider = useCallback((x: number, y: number) => {
    if (overCard(x, y)) { clearTimeout(cardLeave.current); return; }
    const id = under.current;
    if (!id) { if (live.current.cardShown) letGo(); else clearTimeout(dwell.current); return; }
    clearTimeout(cardLeave.current);
    if (chosen.current || live.current.cardShown) { show(id); return; }
    const land = landing.current;
    if (land && land.id !== id) { show(id); return; }
    if (!land) {
      landing.current = { x, y, id };
      clearTimeout(dwell.current);
      dwell.current = setTimeout(() => { if (under.current) show(under.current); }, DWELL_MS);
      return;
    }
    if (Math.hypot(x - land.x, y - land.y) > NUDGE_PX) show(id);
  }, [overCard, letGo, show]);
  // the edge only brings the column out on purpose; once it is out (or on its way back), being on it keeps it out
  const intent = useMemo(() => createEdgeIntent(() => { clearTimeout(hideTimer.current); setOut(true); }), []);
  const inside = usePointerRegion(bridge, hit, () => {
    if (!live.current.slidOut) return;
    clearTimeout(hideTimer.current);
    setOut(true);
  }, () => {
    clearTimeout(hideTimer.current);
    intent.reset();
    under.current = null;
    letGo();
    hideTimer.current = setTimeout(() => {
      if (dragging.current) return;
      setOut(false);
      chosen.current = false;
      landing.current = null;
    }, HIDE_MS);
  }, undefined, solid);
  const lastPoint = useRef({ x: 0, y: 0 });
  useEffect(() => {
    const move = (event: MouseEvent) => {
      lastPoint.current = { x: event.clientX, y: event.clientY };
      const edgeOnly = !live.current.slidOut;
      intent.point({ x: event.clientX, y: event.clientY, inZone: inside.current && edgeOnly, buttons: event.buttons });
      // a card only once the column is out: the sliver hides the mascots, so resting there is not choosing one
      if (inside.current && !edgeOnly) consider(event.clientX, event.clientY);
    };
    // a click on the sliver is the deliberate way in; it only brings the column out, it never lands on a hidden mascot
    let swallow = false;
    const press = (event: PointerEvent) => {
      swallow = false;
      if (!inside.current || live.current.slidOut) return;
      intent.press();
      swallow = true;
      event.preventDefault();
      event.stopPropagation();
    };
    const click = (event: MouseEvent) => { if (swallow) { swallow = false; event.preventDefault(); event.stopPropagation(); } };
    document.addEventListener("mousemove", move, { passive: true });
    document.addEventListener("pointerdown", press, true);
    document.addEventListener("click", click, true);
    return () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("pointerdown", press, true);
      document.removeEventListener("click", click, true);
    };
  }, [inside, consider, intent]);
  useEffect(() => () => { intent.dispose(); clearTimeout(hideTimer.current); clearTimeout(dwell.current); clearTimeout(cardLeave.current); }, [intent]);
  // the pointer reached a mascot (or left them all): once a card is out it follows at once; the first waits for a move
  const pointAt = (id: string | null) => {
    under.current = id;
    if (id && (chosen.current || live.current.cardShown)) show(id);
    else if (!id && live.current.cardShown && !overCard(lastPoint.current.x, lastPoint.current.y)) letGo();
  };
  // a mascot taking focus shows its card only when the keyboard moved it there: macOS hands this panel the key when
  // another (the island) gives it up, and the page then puts focus back where it last was, which must not open anything
  const keyboard = useRef(false);
  useEffect(() => {
    const key = (event: { key: string }) => { if (event.key === "Tab" || event.key.startsWith("Arrow")) keyboard.current = true; };
    const point = () => { keyboard.current = false; };
    // focus moving to this panel from elsewhere is a window switch, not a reach for the dock; while the pointer already
    // rests on the edge it is that very reach (a click there, or macOS keying the panel), which must not cancel the rest
    const focus = () => { if (!inside.current) intent.quiet(); bridge.trace?.("window-focus", `inside=${inside.current}`); };
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", point, true);
    window.addEventListener("focus", focus);
    return () => { document.removeEventListener("keydown", key, true); document.removeEventListener("pointerdown", point, true); window.removeEventListener("focus", focus); };
  }, [bridge, inside, intent]);
  // a click anywhere else (the window loses focus) puts the dock away, fields and all, and leaves nothing focused to
  // come back to
  useEffect(() => {
    const blur = () => {
      intent.quiet();
      keyboard.current = false;
      setPinned(false);
      bridge.typing?.(false);
      (document.activeElement as HTMLElement | null)?.blur?.();
      if (!inside.current) { setCard(null); setOut(false); chosen.current = false; landing.current = null; }
    };
    window.addEventListener("blur", blur);
    return () => window.removeEventListener("blur", blur);
  }, [inside, bridge, intent]);

  // a card that stayed on a reply or a failure for a real look counts as seeing it
  const since = useRef<{ id: string; at: number } | null>(null);
  useEffect(() => {
    const was = since.current;
    since.current = card ? { id: card, at: Date.now() } : null;
    if (!was || was.id === card || Date.now() - was.at < LOOK_MS) return;
    const bot = byId.get(was.id);
    if (bot && isFresh(bot, seen)) mark([eventKey(bot)]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card]);

  const now = useNow(slidOut);
  const { sent, cheering, markSent } = useRowMoments(bots);
  const save = (next: string[]) => bridge.order(next);
  const nudge = (id: string, step: -1 | 1) => {
    const index = ids.indexOf(id), to = index + step;
    if (index < 0 || to < 0 || to >= ids.length) return;
    const next = [...ids];
    [next[index], next[to]] = [next[to]!, next[index]!];
    setIds(next);
    save(next);
  };
  const act = (bot: AmbientBot, next: AmbientAct) => {
    if (next.kind === "answer" || next.kind === "allow" || next.kind === "deny") markSent(bot);
    bridge.act(next);
  };
  const open = (bot: AmbientBot) => {
    if (moved.current) { moved.current = false; return; }
    if (isFresh(bot, seen)) mark([eventKey(bot)]);
    bridge.open(bot.id, bot.threadId);
  };
  const pin = useCallback((on: boolean) => { setPinned(on); bridge.typing?.(on); }, [bridge]);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    pin(false); setCard(null); setOut(false);
    (document.activeElement as HTMLElement | null)?.blur();
  };
  const listMax = Math.max(d.cell, maxBody - 2 * d.pad - d.cell);
  const shownBot = shownId ? byId.get(shownId) ?? null : null;
  // each bot's chat as far back as the card has seen it this session: back on a bot, its history is there at once
  // instead of the summary's few newest until the long stretch arrives
  const kept = useRef(new Map<string, { chat: AmbientMessage[]; hasMore: boolean }>());
  const scrolls = useRef(new Map<string, ChatScroll>());
  const cardBot = useMemo(() => {
    if (!shownBot) return null;
    const was = kept.current.get(shownBot.id);
    const chat = keepHistory(was?.chat, shownBot.chat ?? NONE);
    const hasMore = shownBot.hasMore ?? (chat.length > (shownBot.chat?.length ?? 0) ? was?.hasMore ?? false : false);
    kept.current.set(shownBot.id, { chat, hasMore });
    return chat === shownBot.chat && hasMore === Boolean(shownBot.hasMore) ? shownBot : { ...shownBot, chat, hasMore };
  }, [shownBot]);
  // the card is a real chat: the app's page sends a long stretch of the bot it shows, further back as the person scrolls
  const [history, setHistory] = useState<{ id: string | null; limit: number }>({ id: null, limit: HISTORY });
  useEffect(() => {
    const id = card;
    setHistory((was) => (was.id === id ? was : { id, limit: HISTORY }));
  }, [card]);
  useEffect(() => {
    bridge.viewing?.(history.id ? { botId: history.id, limit: history.limit } : null);
  }, [bridge, history]);
  const chatMax = Math.round(Math.min(stageH - 2 * CARD_MARGIN, CHAT_MAX_H, Math.max(CHAT_MIN_H, stageH * CHAT_SHARE)));
  // one card, one chat: moving to another bot swaps the words in place (no blank frame, nothing mounted again); they
  // rise the way the pointer moved through a small blur. Coming out, they follow the growing card 90ms later.
  const page = useRef<HTMLDivElement>(null);
  const pageOf = useRef<string | null>(null);
  const shownIds = useRef<string[]>([]);
  shownIds.current = shown.map((bot) => bot.id);
  useLayoutEffect(() => {
    const was = pageOf.current;
    pageOf.current = cardShown ? cardBot?.id ?? null : null;
    if (!cardShown || !cardBot || was === cardBot.id) return;
    const easing = `cubic-bezier(${EASE_OUT.join(", ")})`;
    if (!was || !wasShown.current) {
      page.current?.animate?.(
        reduced ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }],
        { duration: 200, delay: reduced ? 0 : 90, easing, fill: "backwards" },
      );
      return;
    }
    const dir = shownIds.current.indexOf(cardBot.id) >= shownIds.current.indexOf(was) ? 1 : -1;
    page.current?.animate?.(
      reduced ? [{ opacity: 0.5 }, { opacity: 1 }] : [{ opacity: 0, transform: `translateY(${dir * 8}px)` }, { opacity: 1, transform: "none" }],
      { duration: reduced ? SWAP_MS : 200, easing },
    );
  }, [cardBot?.id, cardShown, reduced]);
  // the mascots' handlers, the same functions for the whole visit, so a mascot is drawn again only when it changes
  const handlers = useRef<MascotHandlers>(null!);
  handlers.current = {
    open: (id) => { const bot = byId.get(id); if (bot) open(bot); },
    point: (id) => pointAt(id),
    focus: (id) => { if (keyboard.current) show(id); },
    dragStart: () => { dragging.current = true; moved.current = true; setCard(null); },
    dragEnd: () => { dragging.current = false; save(idsNow.current); },
    press: () => { moved.current = false; },
    move: (id, step) => nudge(id, step),
  };

  return (
    // no bots, no dock: never an empty column or a lone "+" (kept laid out but unseen, so it measures itself when they come)
    <div className="amb-stage" data-empty={bots.length ? undefined : ""} style={{ width: stageW, height: stageH }} onKeyDown={onKeyDown}>
      <motion.div
        className="amb-dock"
        role="region"
        aria-label={say(labels, "dock")}
        data-hidden={slidOut ? undefined : ""}
        style={{ x: slide, width: stageW, height: stageH, ["--amb-over" as string]: `${over}px` }}
      >
        <motion.span aria-hidden className="amb-ear amb-ear-top" style={{ y: earTop, width: d.ear, height: d.ear }} />
        <motion.span aria-hidden className="amb-ear amb-ear-bottom" style={{ y: earBottom, width: d.ear, height: d.ear }} />
        <motion.div className="amb-dock-body" style={{ clipPath: clip }}>
          <motion.div ref={content} className="amb-dock-column" style={{ y: top, left: columnLeft, width: d.column + over, paddingBlock: d.pad }}>
            <Reorder.Group ref={list} as="ul" axis="y" values={ids} onReorder={setIds} className="amb-dock-list" style={{ maxHeight: listMax }} onPointerLeave={() => pointAt(null)}>
              {shown.map((bot, index) => (
                <DockMascot
                  key={bot.id}
                  index={index}
                  cheer={cheer}
                  bot={bot}
                  labels={labels}
                  tile={d.tile}
                  cell={d.cell}
                  live={slidOut}
                  reduced={reduced}
                  showing={card === bot.id}
                  news={newsOf(bot, seen)}
                  state={cheering.has(bot.id) ? "celebrate" : sent.has(bot.id) ? "approving" : isSeenEvent(bot, seen) ? "idle" : undefined}
                  handlers={handlers}
                />
              ))}
            </Reorder.Group>
            <div className="amb-dock-foot" style={{ height: d.cell, width: d.column }}>
              <button type="button" className="amb-dock-plus" aria-label={say(labels, "newBot")} title={say(labels, "newBot")} onClick={() => bridge.act({ kind: "new-bot" })}>
                <Plus size={18} strokeWidth={1.5} aria-hidden />
              </button>
            </div>
          </motion.div>
        </motion.div>
      </motion.div>
      <motion.div
        className="amb-card"
        role="dialog"
        aria-label={cardBot?.name}
        data-card={card ?? undefined}
        inert={!cardShown}
        style={{ left: cardLeft, top: 0, width: CARD_W, transformOrigin: "100% 50%" }}
        initial={reduced ? false : { opacity: 0, ...SMALL }}
        animate={cardShown
          ? { opacity: 1, scaleX: 1, scaleY: 1, x: 0, y: cardY, height: cardH }
          : { opacity: 0, scaleX: reduced ? 1 : 0.97, scaleY: reduced ? 1 : 0.97, x: reduced ? 0 : 6, y: leavingAt.current.y, height: leavingAt.current.h, transitionEnd: reduced ? undefined : SMALL }}
        transition={cardShown
          ? { opacity: { duration: 0.12, ease: EASE_OUT }, scaleX: glide === JUMP && !reduced ? GROW_W : SETTLE, scaleY: glide === JUMP && !reduced ? GROW_H : SETTLE, x: SETTLE, y: glide, height: glide === JUMP ? JUMP : GROW_H }
          : { opacity: CARD_OUT, scaleX: CARD_OUT, scaleY: CARD_OUT, x: CARD_OUT, y: JUMP, height: JUMP }}
      >
        <div ref={cardInner} className="amb-card-inner">
          {cardBot && (
            <div ref={page} className="amb-card-page" data-page={cardBot.id}>
              <MiniChat
                bot={cardBot}
                labels={labels}
                lang={lang}
                now={now}
                sent={sent.has(cardBot.id)}
                fresh={isFresh(cardBot, seen) && !cardBot.quiet}
                onOpen={() => open(cardBot)}
                onAct={(next) => act(cardBot, next)}
                onPin={pin}
                onDismiss={() => mark([eventKey(cardBot)])}
                maxHeight={chatMax}
                scrolls={scrolls.current}
                onMore={() => setHistory((was) => (was.id === cardBot.id ? { id: was.id, limit: Math.max(was.limit, cardBot.chat?.length ?? 0) + HISTORY } : was))}
              />
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}

interface MascotHandlers {
  open: (id: string) => void;
  point: (id: string) => void;
  focus: (id: string) => void;
  dragStart: () => void;
  dragEnd: () => void;
  press: () => void;
  move: (id: string, step: -1 | 1) => void;
}

interface MascotProps {
  index: number; cheer: number; bot: AmbientBot; labels: AmbientLabels; tile: number; cell: number; live: boolean; reduced: boolean; showing: boolean;
  news: News; state: "celebrate" | "approving" | "idle" | undefined; handlers: RefObject<MascotHandlers>;
}

/** What a mascot draws from its bot: everything else in a summary (its chat, its line, the reply it streams) leaves it be. */
const sameMascot = (a: AmbientBot, b: AmbientBot) => a.id === b.id && a.name === b.name && a.color === b.color && a.body === b.body && a.face === b.face
  && a.avatar === b.avatar && a.status === b.status && a.step === b.step && a.asks === b.asks && a.quiet === b.quiet;

const DockMascot = memo(function DockMascot({ index, cheer, bot, labels, tile, cell, live, reduced, showing, news, state, handlers }: MascotProps) {
  const controls = useDragControls();
  const on = () => handlers.current;
  const onKeyDown = (event: KeyboardEvent) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    on().move(bot.id, event.key === "ArrowUp" ? -1 : 1);
  };
  const onPointerDown = (event: ReactPointerEvent) => { on().press(); controls.start(event); };
  // hidden, the sliver still ticks who waits, failed, works or replied; what the person is watching ticks nothing
  const tick = bot.quiet ? null : news ?? (isBusy(bot.status) ? "busy" : null);
  const dot = dotOf(bot, news);
  const bubble = news === "ask" || news === "error" ? news : null;
  return (
    <Reorder.Item
      as="li"
      value={bot.id}
      className="amb-dock-cell"
      data-row={bot.id}
      style={{ height: cell }}
      onPointerEnter={() => on().point(bot.id)}
      dragListener={false}
      dragControls={controls}
      onDragStart={() => on().dragStart()}
      onDragEnd={() => on().dragEnd()}
      whileDrag={reduced ? undefined : { scale: 1.06 }}
      transition={SETTLE}
    >
      <button
        type="button"
        className="amb-dock-bot"
        data-showing={showing || undefined}
        aria-label={`${say(labels, "open", { name: bot.name })}. ${bot.status === "idle" ? "" : `${say(labels, bot.status)}. `}${say(labels, "reorder")}`}
        aria-expanded={showing}
        onPointerDown={onPointerDown}
        onClick={() => on().open(bot.id)}
        onFocus={() => on().focus(bot.id)}
        onKeyDown={onKeyDown}
      >
        <span className="amb-lift">
          {/* sliding out, the mascots follow the column 45ms apart */}
          <motion.span className="amb-dock-mark" whileTap={reduced ? undefined : { scale: 0.96 }}
            initial={false} animate={{ x: live || reduced ? 0 : 12 }}
            transition={live && !reduced ? { ...SPRING.fade, delay: 0.06 + Math.min(index, 8) * 0.045 } : { duration: 0.1 }}>
            <BotMark bot={bot} size={tile} state={state} animated={live} awake={live} index={index} cheer={cheer} />
          </motion.span>
        </span>
        <AnimatePresence initial={false}>
          {bubble && (
            <motion.span
              key={bubble}
              className="amb-bubble"
              data-kind={bubble}
              aria-hidden
              initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.5 }}
              animate={{ opacity: 1, scale: 1, transition: { opacity: FADE, scale: LIVELY } }}
              exit={{ opacity: 0, scale: reduced ? 1 : 0.6, transition: FADE_OUT }}
            >
              {bubble === "ask" ? Math.max(1, bot.asks) : "!"}
            </motion.span>
          )}
        </AnimatePresence>
        {/* how it is doing, on its mascot too, not only by its pose */}
        {dot && <span className="amb-state-dot" data-state={dot} aria-hidden />}
        {tick && <span className="amb-tick" data-kind={tick} aria-hidden />}
      </button>
    </Reorder.Item>
  );
}, (a, b) => sameMascot(a.bot, b.bot) && a.index === b.index && a.cheer === b.cheer && a.labels === b.labels && a.tile === b.tile && a.cell === b.cell
  && a.live === b.live && a.reduced === b.reduced && a.showing === b.showing && a.news === b.news && a.state === b.state && a.handlers === b.handlers);

/** A bot's chat as far back as it has been seen: the summary's newest messages after the older ones kept from before
 * (each message's longer copy wins: a summary for a bot not on show carries only a line of each). */
export function keepHistory(kept: readonly AmbientMessage[] | undefined, chat: readonly AmbientMessage[]): AmbientMessage[] {
  if (!kept?.length || !chat.length) return chat as AmbientMessage[];
  const start = kept.findIndex((message) => message.id === chat[0]!.id);
  if (start < 0) return chat as AmbientMessage[];
  const longer = new Map(kept.slice(start).map((message) => [message.id, message.text]));
  let changed = start > 0;
  const newest = chat.map((message) => {
    const text = longer.get(message.id);
    if (text === undefined || text.length <= message.text.length) return message;
    changed = true;
    return { ...message, text };
  });
  return changed ? [...kept.slice(0, start), ...newest].slice(-KEPT_MESSAGES) : chat as AmbientMessage[];
}
