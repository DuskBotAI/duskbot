import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "../ui/kit";
import { useReducedMotion } from "../ui/motion";
import { Figure } from "../ui/Figure";
import { RowMenu, type MenuItem } from "../ui/table";
import { Delta } from "./kit";
import { TINTS, TINT_STYLE, loadLayout, moveTo, saveLayout, slotAt, tintOf, type KpiId, type KpiLayout, type Tint } from "./kpi-layout";

export interface KpiCard {
  id: KpiId; value: number | null; format(v: number): string; now?: number | null; before?: number | null; invert?: boolean;
  toggle?: { on: boolean; flip(): void; colour: string }; note?: string; hint?: string;
  /** said under the number instead of the change on the window before */
  change?: ReactNode;
}

const SETTLE = "transform 240ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 240ms ease";
const HOLD_MS = 280, SLOP = 4, TOUCH_SLOP = 8;

type Press = { id: KpiId; pointer: number; touch: boolean; sx: number; sy: number; grab: { x: number; y: number }; active: boolean; timer?: number; off(): void };

/** the strip's order and colours, kept per browser; the page holds them so the chart can follow the green card */
export const useKpiLayout = () => useState<KpiLayout>(() => loadLayout());

/** the strip of numbers over the chart; cards drag into a new order and take a colour from their menu */
export function KpiRow({ cards, layout, onLayout: setLayout }: { cards: KpiCard[]; layout: KpiLayout; onLayout(next: KpiLayout): void }) {
  const [dragging, setDragging] = useState<KpiId | null>(null);
  const [said, setSaid] = useState("");
  const reduced = useReducedMotion() ?? false;
  const grid = useRef<HTMLDivElement>(null);
  const slots = useRef(new Map<KpiId, HTMLDivElement>());
  const lifts = useRef(new Map<KpiId, HTMLDivElement>());
  const before = useRef<Map<KpiId, DOMRect> | null>(null);
  const press = useRef<Press | null>(null);
  const point = useRef({ x: 0, y: 0 });
  const swallowClick = useRef(false);
  const current = useRef(layout);
  current.current = layout;
  const byId = new Map(cards.map((card) => [card.id, card]));
  const order = layout.order.filter((id) => byId.has(id));

  const commit = (next: KpiLayout) => { current.current = next; setLayout(next); saveLayout(next); };
  const snapshot = (skip: KpiId | null) => {
    if (reduced) return;
    before.current = new Map([...lifts.current].filter(([id]) => id !== skip).map(([id, el]) => [id, el.getBoundingClientRect()]));
  };

  const place = (id: KpiId) => {
    const slot = slots.current.get(id), lift = lifts.current.get(id), p = press.current;
    if (!slot || !lift || !p) return;
    lift.style.transition = "none";
    lift.style.transform = `translate(${point.current.x - p.grab.x - slot.offsetLeft}px, ${point.current.y - p.grab.y - slot.offsetTop}px)`;
  };

  // after a reorder, every card that moved glides from where it was to its new slot
  useLayoutEffect(() => {
    const was = before.current;
    before.current = null;
    if (was) {
      for (const [id, el] of lifts.current) {
        const from = was.get(id);
        if (!from || id === press.current?.id) continue;
        el.style.transition = "none";
        el.style.transform = "";
        const to = el.getBoundingClientRect();
        const dx = from.left - to.left, dy = from.top - to.top;
        if (!dx && !dy) continue;
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        void el.offsetWidth;
        el.style.transition = SETTLE;
        el.style.transform = "";
      }
    }
    if (dragging) place(dragging);
  }, [layout.order]);

  useEffect(() => () => press.current?.off(), []);

  function onMove(e: PointerEvent) {
    const p = press.current, box = grid.current;
    if (!p || e.pointerId !== p.pointer || !box) return;
    const far = Math.hypot(e.clientX - p.sx, e.clientY - p.sy);
    if (!p.active) {
      if (p.touch) { if (far > TOUCH_SLOP) end(false); return; }
      if (far < SLOP) return;
      begin();
    }
    const r = box.getBoundingClientRect();
    point.current = { x: e.clientX - r.left, y: e.clientY - r.top };
    place(p.id);
    const ids = current.current.order.filter((id) => slots.current.has(id));
    const boxes = ids.map((id) => { const s = slots.current.get(id)!; return { left: s.offsetLeft, top: s.offsetTop, width: s.offsetWidth, height: s.offsetHeight }; });
    const at = slotAt(boxes, point.current.x, point.current.y);
    if (at !== null && ids[at] !== p.id) {
      snapshot(p.id);
      const l = current.current;
      current.current = { ...l, order: moveTo(l.order, p.id, l.order.indexOf(ids[at]!)) };
      setLayout(current.current);
    }
  }

  function begin() {
    const p = press.current;
    if (!p) return;
    p.active = true;
    setDragging(p.id);
  }

  const onUp = (e: PointerEvent) => { if (press.current && e.pointerId === press.current.pointer) end(e.type === "pointerup"); };
  const blockScroll = (e: TouchEvent) => { if (press.current?.active) e.preventDefault(); };

  function end(dropped: boolean) {
    const p = press.current;
    if (!p) return;
    p.off();
    window.clearTimeout(p.timer);
    press.current = null;
    if (!p.active) return;
    const lift = lifts.current.get(p.id);
    if (lift) { lift.style.transition = reduced ? "none" : SETTLE; lift.style.transform = ""; }
    setDragging(null);
    if (dropped) {
      swallowClick.current = true;
      window.setTimeout(() => { swallowClick.current = false; }, 0);
    }
    saveLayout(current.current);
  }

  const onDown = (id: KpiId) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (press.current || (e.pointerType === "mouse" && e.button !== 0) || (e.target as HTMLElement).closest("button")) return;
    const slot = e.currentTarget, box = grid.current!.getBoundingClientRect();
    const touch = e.pointerType === "touch";
    press.current = { id, pointer: e.pointerId, touch, sx: e.clientX, sy: e.clientY, grab: { x: e.clientX - box.left - slot.offsetLeft, y: e.clientY - box.top - slot.offsetTop }, active: false, off: () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("touchmove", blockScroll);
    } };
    point.current = { x: e.clientX - box.left, y: e.clientY - box.top };
    if (touch) press.current.timer = window.setTimeout(() => { begin(); place(id); }, HOLD_MS);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("touchmove", blockScroll, { passive: false });
  };

  const shift = (id: KpiId, by: number) => {
    const at = layout.order.indexOf(id);
    snapshot(null);
    commit({ ...layout, order: moveTo(layout.order, id, at + by) });
    setSaid(`${id} moved to ${at + by + 1} of ${layout.order.length}`);
  };

  return (
    <div ref={grid} className="relative grid grid-cols-7 gap-1.5 max-xl:grid-cols-4 max-sm:grid-cols-2">
      {order.map((id, i) => {
        const card = byId.get(id)!, tint = tintOf(layout, id);
        const items: MenuItem[] = [
          { label: "move left", disabled: i === 0, onSelect: () => shift(id, -1) },
          { label: "move right", disabled: i === order.length - 1, onSelect: () => shift(id, 1) },
          ...TINTS.map((t) => ({
            label: t === "none" ? "plain" : TINT_STYLE[t].label, checked: tint === t, onSelect: () => commit({ ...layout, tints: { ...layout.tints, [id]: t } }),
            lead: <span aria-hidden className="size-3 shrink-0 rounded-full" style={{ background: t === "none" ? "var(--card-2)" : TINT_STYLE[t].accent }} />,
          })),
        ];
        return (
          <div key={id} ref={(el) => { if (el) slots.current.set(id, el); else slots.current.delete(id); }} className="min-w-0 touch-manipulation"
            onPointerDown={onDown(id)} onClickCapture={(e) => { if (swallowClick.current) { e.preventDefault(); e.stopPropagation(); } }}>
            <div ref={(el) => { if (el) lifts.current.set(id, el); else lifts.current.delete(id); }} className={cx("group relative h-full rounded-[16px]", dragging === id ? "z-10 cursor-grabbing" : "cursor-grab")}
              style={{ boxShadow: dragging === id ? "var(--pop-shadow)" : undefined }}>
              <Kpi label={id} card={card} tint={tint} />
              <div className="absolute right-1.5 top-1.5 opacity-0 transition-opacity duration-150 has-[:focus-visible]:opacity-100 group-hover:opacity-100 has-[[aria-expanded=true]]:opacity-100">
                <RowMenu label={`${id} card options`} items={items} />
              </div>
            </div>
          </div>
        );
      })}
      <p className="sr-only" aria-live="polite">{said}</p>
    </div>
  );
}

function Kpi({ label, card, tint }: { label: string; card: KpiCard; tint: Tint }) {
  const { value, format, now, before, invert, toggle, note, hint, change } = card;
  const style = tint !== "none" ? TINT_STYLE[tint] : null;
  return (
    <div title={hint} className="h-full min-w-0 select-none rounded-[16px] bg-pop px-4 py-3.5 transition-colors duration-200 [-webkit-touch-callout:none]" style={style && toggle?.on !== false ? { background: style.wash } : undefined}>
      {toggle ? (
        <label className="flex cursor-pointer items-center gap-2 pe-7 text-13 font-medium text-ink-2">
          <input type="checkbox" checked={toggle.on} onChange={toggle.flip} className="size-3.5 cursor-pointer rounded-[4px]" style={{ accentColor: style?.accent ?? toggle.colour }} />{label}
        </label>
      ) : <div className="truncate pe-7 text-13 font-medium text-ink-3">{label}</div>}
      <div className="mt-1 truncate font-mono text-[26px] font-medium leading-9 tracking-[-0.045em] text-ink num" style={style ? { color: style.ink } : undefined}>{value === null ? "-" : <Figure value={format(value)} className="!font-mono !text-[26px] !leading-9 !tracking-[-0.045em] ![color:inherit]" />}</div>
      <div className="mt-0.5 h-5 truncate leading-5">{change ?? (now !== undefined && <Delta now={now ?? null} before={before ?? null} invert={invert} />)}</div>
      {note && <div className="mt-0.5 truncate text-12 leading-4 text-ink-3">{note}</div>}
    </div>
  );
}
