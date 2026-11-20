import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/cn";
import { triggerSystemControl, useSystemControl } from "@/lib/system-control";
import { Icon, type IconName } from "../Icon";
import { useMenuMotion } from "../MenuMotion";
import { systemMenu } from "@/lib/system-menu";

export interface SelectPillOption<V extends string> {
  value: V;
  label: ReactNode;
  disabled?: boolean;
  /** a native tooltip on the row, such as why it cannot be chosen */
  title?: string;
  /** a leading glyph in the menu row, as Grok's menus have; the pill shows the label alone */
  icon?: IconName;
  /** a hairline above the row, setting an action apart from the choices */
  separated?: boolean;
}

const GAP = 4;
const MENU_MIN = 200;
const ROW = 30;
const ROW_GAP = 2;
const MENU_MAX = 360;
const EDGE = 8;

export interface MenuPlace { top?: number; bottom?: number; right: number; up: boolean; maxHeight: number }

export function placeMenu(box: { top: number; bottom: number; right: number }, height: number, viewport: { width: number; height: number }): MenuPlace {
  const wanted = Math.min(height, MENU_MAX);
  const below = viewport.height - EDGE - (box.bottom + GAP);
  const above = box.top - GAP - EDGE;
  const up = wanted > below && above > below;
  const maxHeight = Math.max(0, Math.min(wanted, up ? above : below));
  return { right: viewport.width - box.right, up, maxHeight, ...(up ? { bottom: viewport.height - box.top + GAP } : { top: box.bottom + GAP }) };
}

/** Grok's ghost select in a pane row ("Liora", "1x", "Auto-detect"): a 24px hairline pill sized to its value, and the
 * white 200px listbox under its right edge, 30px rows 2px apart with an inset highlight and a check on the chosen one.
 * Settings draws it as its filled chip (settings.css, [data-select-pill]). */
export function SelectPill<V extends string>({ value, options, onChange, disabled, className, title, "aria-label": label, ...rest }: {
  value: V;
  options: readonly SelectPillOption<V>[];
  onChange: (value: V) => void;
  disabled?: boolean;
  className?: string;
  title?: string;
  "aria-label": string;
  "data-panel-select"?: string;
}) {
  const selected = options.find((option) => option.value === value);
  const [open, setOpen] = useState(false);
  const motion = useMenuMotion(open);
  const [active, setActive] = useState(-1);
  const [place, setPlace] = useState<MenuPlace | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const plain = options.every((option) => typeof option.label === "string");
  const system = useSystemControl(
    trigger,
    plain
      ? {
          kind: "popup",
          title: String(selected?.label ?? value),
          value,
          options: options.map((option) => ({
            key: option.value,
            label: option.label as string,
            disabled: option.disabled,
            separated: option.separated,
          })),
          disabled,
          label,
        }
      : null,
    (next) => {
      if (typeof next !== "string") return;
      const option = options.find((item) => item.value === next);
      if (option && !option.disabled && option.value !== value) onChange(option.value);
    },
  );

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    close();
    if (option.value !== value) onChange(option.value);
  };
  const show = () => {
    if (disabled) return;
    const openFallback = () => {
      const menu = systemMenu();
      if (menu && trigger.current && options.every((option) => typeof option.label === "string")) {
        void menu(trigger.current.getBoundingClientRect(), options.map((option) => ({
          key: option.value, label: option.label as string, checked: option.value === value, disabled: option.disabled, separated: option.separated,
        }))).then((key) => { if (key !== null) choose(options.findIndex((option) => option.value === key)); });
        return;
      }
      setActive(Math.max(0, options.findIndex((option) => option.value === value)));
      setOpen(true);
    };
    if (system && trigger.current) {
      void triggerSystemControl(trigger.current).then((triggered) => { if (!triggered) openFallback(); });
      return;
    }
    openFallback();
  };

  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const box = trigger.current.getBoundingClientRect();
    const height = options.length * (ROW + ROW_GAP) - ROW_GAP + 12 + options.filter((option) => option.separated).length * (9 + ROW_GAP);
    setPlace(placeMenu(box, height, { width: window.innerWidth, height: window.innerHeight }));
  }, [open, options.length]);

  useEffect(() => {
    if (open && place && active >= 0) document.getElementById(`${id}-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, place, active, id]);

  // the listbox mounts once it is placed: focus it then, so its keys (and Escape) are its own
  useEffect(() => {
    if (open && place) list.current?.focus({ preventScroll: true });
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!list.current?.contains(target) && !trigger.current?.contains(target)) close(false);
    };
    const dismiss = () => close(false);
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [open]);

  const step = (from: number, by: number) => {
    for (let index = from + by, tries = 0; tries < options.length; index += by, tries++) {
      const wrapped = (index + options.length) % options.length;
      if (!options[wrapped]?.disabled) return wrapped;
    }
    return from;
  };

  return (
    <>
      <button
        {...rest}
        ref={trigger}
        type="button"
        role="combobox"
        data-select-pill=""
        data-system-popup={system ? "" : undefined}
        aria-label={label}
        aria-hidden={system || undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        tabIndex={system ? -1 : undefined}
        title={title}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            close();
          } else if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
            event.preventDefault();
            show();
          }
        }}
        className={cn(
          "group -my-[3px] -mr-[5px] inline-flex h-6 min-w-0 max-w-[160px] shrink-0 cursor-pointer items-center gap-1 rounded-lg border border-ink/6 bg-transparent py-0.5 pl-1.5 pr-1 text-[13px] leading-[18px] tracking-[-0.08px] text-ink",
          "transition-[color,background-color] duration-100 ease-[ease] hover:bg-ink/6 aria-expanded:bg-ink/6",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
          "disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent",
          className,
          system && "m-0 h-auto min-h-6 max-w-[62%] gap-1.5 rounded-none border-0 bg-transparent p-0 text-[17px] leading-[22px] opacity-0",
        )}
      >
        <span className="min-w-0 flex-1 truncate text-start">{selected?.label ?? value}</span>
        <Icon name="chevron-down" size={system ? 16 : 10} className="shrink-0 text-ink-secondary" />
      </button>
      {typeof document !== "undefined" && createPortal(
          motion.shown && place && (
            <div
              ref={list}
              id={`${id}-list`}
              role="listbox"
              tabIndex={-1}
              aria-label={label}
              aria-activedescendant={active >= 0 ? `${id}-${active}` : undefined}
              data-panel-listbox=""
              {...motion.exitProps}
              onKeyDown={(event) => {
                if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
                else if (event.key === "Tab") close();
                else if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => step(index, 1)); }
                else if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => step(index, -1)); }
                else if (event.key === "Home") { event.preventDefault(); setActive(step(-1, 1)); }
                else if (event.key === "End") { event.preventDefault(); setActive(step(options.length, -1)); }
                else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(active); }
              }}
              style={{ top: place.top, bottom: place.bottom, right: place.right, maxHeight: place.maxHeight, minWidth: MENU_MIN, transformOrigin: place.up ? "right bottom" : "right top" }}
              className={cn(motion.className, "fixed z-[2147482000] flex max-w-[320px] flex-col gap-0.5 overflow-y-auto rounded-2xl bg-menu py-1.5 text-[13px] leading-[18px] tracking-[-0.08px] text-ink shadow-(--shadow-popover) outline-none [scrollbar-width:none]")}
            >
              {options.map((option, index) => (
                <Fragment key={option.value}>
                {option.separated && <div aria-hidden="true" className="mx-3.5 my-1 h-px shrink-0 bg-ink/8" />}
                <div
                  id={`${id}-${index}`}
                  role="option"
                  aria-selected={option.value === value}
                  aria-disabled={option.disabled || undefined}
                  title={option.title}
                  data-highlighted={index === active ? "" : undefined}
                  onPointerMove={() => !option.disabled && setActive(index)}
                  onClick={() => choose(index)}
                  className={cn(
                    "relative flex min-h-[30px] shrink-0 cursor-pointer select-none items-center gap-2 px-3.5 py-1.5",
                    "before:pointer-events-none before:absolute before:inset-y-0 before:inset-x-1.5 before:rounded-[10px] before:content-[''] data-highlighted:before:bg-ink/[0.06]",
                    "aria-disabled:cursor-default aria-disabled:opacity-50",
                  )}
                >
                  {option.icon && <Icon name={option.icon} size={16} className="relative shrink-0" />}
                  <span className="relative min-w-0 flex-1 truncate">{option.label}</span>
                  {option.value === value && <Icon name="check" size={12} className="relative shrink-0" />}
                </div>
                </Fragment>
              ))}
            </div>
          ),
        document.body,
      )}
    </>
  );
}
