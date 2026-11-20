import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { animate, motion, useMotionValue, useTransform, type Transition } from "motion/react";

import { cn } from "@/lib/cn";
import { useSystemControl } from "@/lib/system-control";

export interface SegmentedTab<V extends string> {
  value: V;
  label: ReactNode;
}

/** Grok's segmented tabs: 26px pills on the page, the chosen one filled at once (Grok draws no sliding fill). Given
 * `slide`, one fill glides under the chosen tab on that transition instead (null: it jumps, for reduced motion). */
export function SegmentedTabs<V extends string>({ tabs, value, onChange, label, attr, className, slide }: {
  tabs: readonly SegmentedTab<V>[];
  value: V;
  onChange: (value: V) => void;
  label: string;
  attr?: string;
  className?: string;
  slide?: Transition | null;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const sliding = slide !== undefined;
  // until the fill has measured its tab (a sheet still laying out, a font still loading) the chosen tab wears its own
  // fill, so the first frame already shows it in place
  const [filled, setFilled] = useState(false);
  const plain = tabs.every((tab) => typeof tab.label === "string");
  const system = useSystemControl(listRef, plain ? { kind: "segmented", items: tabs.map((tab) => tab.label as string), selected: Math.max(0, tabs.findIndex((tab) => tab.value === value)), label } : null,
    (index) => { const tab = typeof index === "number" ? tabs[index] : undefined; if (tab && tab.value !== value) onChange(tab.value); });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const edge = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
    if (!step && edge < 0) return;
    event.preventDefault();
    const at = tabs.findIndex((tab) => tab.value === value);
    const next = edge >= 0 ? edge : (at + step + tabs.length) % tabs.length;
    onChange(tabs[next]!.value);
    listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };

  // the device's own segmented control is drawn in this room, and is what assistive technology meets
  if (system) return <div ref={listRef} aria-hidden="true" data-segmented-room="" className={cn("h-9 max-w-full", className)} style={{ width: tabs.length * 120 }} />;
  return (
    <div
      ref={listRef} role="tablist" aria-label={label} onKeyDown={onKeyDown} className={cn("flex gap-0.5", sliding && "relative", className)}
      data-segmented="" style={{ "--seg-count": tabs.length, "--seg-index": Math.max(0, tabs.findIndex((tab) => tab.value === value)) } as CSSProperties}
    >
      {sliding && <SlidingFill index={tabs.findIndex((tab) => tab.value === value)} transition={slide} shown={filled} onPlaced={() => setFilled(true)} />}
      {tabs.map((tab) => {
        const selected = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            {...(attr ? { [attr]: tab.value } : {})}
            onClick={() => onChange(tab.value)}
            className={cn(
              "h-[26px] min-w-0 shrink truncate rounded-full px-2 py-1 text-[13px] leading-[18px] tracking-normal",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
              sliding ? cn("relative transition-colors duration-150 ease-[ease]", selected ? "text-ink" : "text-ink-secondary", selected && !filled && "bg-ink/[0.06]")
                : selected ? "bg-ink/[0.06] text-ink" : "text-ink-secondary hover:bg-ink/[0.06]",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/** The chosen tab's fill, moved and stretched by transform only. Its corners are counter-scaled so the pill keeps its
 * round ends while it stretches between tabs of different widths. */
function SlidingFill({ index, transition, shown, onPlaced }: { index: number; transition: Transition | null; shown: boolean; onPlaced: () => void }) {
  const base = useRef(0);
  const x = useMotionValue(0);
  const scaleX = useMotionValue(1);
  const radius = useTransform(scaleX, (s) => `${9999 / Math.max(s, 0.01)}px / 9999px`);
  const fill = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);
  const placedOnce = useRef(onPlaced);
  placedOnce.current = onPlaced;

  useLayoutEffect(() => {
    const row = fill.current?.parentElement;
    if (!row) return;
    const place = (glide: boolean) => {
      const tab = row.querySelectorAll<HTMLElement>('[role="tab"]')[index];
      if (!tab || !fill.current || !tab.offsetWidth) return;
      if (!base.current) {
        base.current = tab.offsetWidth;
        fill.current.style.width = `${base.current}px`;
      }
      const to = { x: tab.offsetLeft, scaleX: tab.offsetWidth / base.current };
      if (glide && transition && placed.current) {
        animate(x, to.x, transition);
        animate(scaleX, to.scaleX, transition);
      } else {
        x.jump(to.x);
        scaleX.jump(to.scaleX);
      }
      if (!placed.current) placedOnce.current();
      placed.current = true;
    };
    place(true);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { if (!x.isAnimating()) place(false); });
    for (const tab of row.querySelectorAll('[role="tab"]')) observer.observe(tab);
    return () => observer.disconnect();
  }, [index, transition, x, scaleX]);

  return (
    <motion.span
      ref={fill}
      aria-hidden="true"
      data-tab-fill=""
      className="pointer-events-none absolute inset-y-0 left-0 bg-ink/[0.06]"
      style={{ x, scaleX, borderRadius: radius, transformOrigin: "0 50%", opacity: shown ? 1 : 0 }}
    />
  );
}
