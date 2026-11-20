import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useSystemControl } from "@/lib/system-control";
import { useStretch } from "@/lib/use-stretch";
import { MotionSpan, useMotionReduced } from "./SheetMotion";

export interface SegmentedOption<V extends string> {
  value: V;
  label: ReactNode;
  disabled?: boolean;
}

/** A pick-one of two to four short choices, all visible at once: a soft track and the chosen one lifted onto the card
 * (white in a light skin, a lighter tone of ink in a dark one: see .segmented-fill).
 * The lifted card is one pill that stretches to the chosen option: its leading edge runs ahead on a stiff spring and
 * the back edge catches up (use-stretch.ts); springs retarget, so a quick second pick carries on from where it is.
 * Reduced motion drops the slide. */
export function Segmented<V extends string>({ value, options, onChange, disabled, className, "aria-label": label, ...rest }: {
  value: V;
  options: readonly SegmentedOption<V>[];
  onChange: (value: V) => void;
  disabled?: boolean;
  className?: string;
  "aria-label": string;
  "data-settings-select"?: string;
  "data-panel-select"?: string;
}) {
  const group = useRef<HTMLDivElement>(null);
  const plain = options.every((option) => typeof option.label === "string" && !option.disabled);
  const system = useSystemControl(
    group,
    plain
      ? {
          kind: "segmented",
          items: options.map((option) => option.label as string),
          selected: Math.max(0, options.findIndex((option) => option.value === value)),
          disabled,
          label,
        }
      : null,
    (index) => {
      const option = typeof index === "number" ? options[index] : undefined;
      if (option && !option.disabled && option.value !== value) onChange(option.value);
    },
  );
  const [pill, setPill] = useState<{ x: number; y: number; width: number; height: number; value: V; moved: boolean } | null>(null);
  const reduced = useMotionReduced();
  useLayoutEffect(() => {
    if (system) return;
    const root = group.current;
    if (!root) return;
    const place = () => {
      const chosen = root.querySelector<HTMLElement>(`[data-value="${CSS.escape(value)}"]`);
      if (!chosen || !chosen.offsetWidth) return setPill(null);
      const next = { x: chosen.offsetLeft, y: chosen.offsetTop, width: chosen.offsetWidth, height: chosen.offsetHeight };
      // the first placement, and a resize, land without a slide; only a new pick animates
      setPill((last) => last && last.x === next.x && last.y === next.y && last.width === next.width && last.height === next.height ? last : { ...next, value, moved: last !== null && last.value !== value });
    };
    place();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(place);
    watch.observe(root);
    return () => watch.disconnect();
  }, [value, options.length, system]);
  const stretch = useStretch(pill ? { start: pill.x, end: pill.x + pill.width } : null, reduced || !pill?.moved);
  const enabled = options.filter((option) => !option.disabled);
  const move = (event: KeyboardEvent, by: number) => {
    event.preventDefault();
    const at = enabled.findIndex((option) => option.value === value);
    const next = enabled[(at + by + enabled.length) % enabled.length];
    if (!next) return;
    onChange(next.value);
    group.current?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(next.value)}"]`)?.focus();
  };
  if (system) {
    return (
      <div {...rest} ref={group} aria-hidden="true" data-segmented-room="" className={cn("inline-flex h-9 shrink-0 items-center", className)} style={{ visibility: "hidden" }}>
        {options.map((option) => (
          <span key={option.value} className="whitespace-nowrap px-3.5 text-[15px] font-medium">{option.label}</span>
        ))}
      </div>
    );
  }
  return (
    <div
      {...rest}
      ref={group}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      data-segmented=""
      style={{ "--seg-count": options.length, "--seg-index": Math.max(0, options.findIndex((option) => option.value === value)) } as CSSProperties}
      onKeyDown={(event) => {
        const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
        if (event.key === "ArrowRight" || event.key === "ArrowDown") move(event, rtl && event.key === "ArrowRight" ? -1 : 1);
        else if (event.key === "ArrowLeft" || event.key === "ArrowUp") move(event, rtl && event.key === "ArrowLeft" ? 1 : -1);
      }}
      className={cn("relative isolate inline-flex h-7 shrink-0 items-center gap-0.5 rounded-full bg-ink/[0.06] p-0.5", disabled && "opacity-50", className)}
    >
      {pill && (
        <MotionSpan
          aria-hidden="true"
          data-segmented-pill=""
          style={{ x: stretch.start, y: pill.y, width: stretch.size, height: pill.height }}
          className="pointer-events-none absolute left-0 top-0 -z-10 rounded-full segmented-fill"
        />
      )}
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            data-value={option.value}
            tabIndex={checked ? 0 : -1}
            disabled={disabled || option.disabled}
            onClick={() => !checked && onChange(option.value)}
            className={cn(
              "h-6 min-w-0 cursor-pointer whitespace-nowrap rounded-full px-2.5 text-[13px] leading-6 text-ink-secondary",
              "transition-[background-color,color,box-shadow,scale] duration-[120ms] ease-[ease] enabled:hover:text-ink",
              "outline-none focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus",
              "disabled:cursor-default enabled:active:scale-[0.96] motion-reduce:enabled:active:scale-100",
              checked && "text-ink",
              checked && !pill && "segmented-fill",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
