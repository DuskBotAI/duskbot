import { Children, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { triggerSystemControl, useSystemControl } from "@/lib/system-control";
import { systemMenu } from "@/lib/system-menu";
import { Icon } from "./Icon";
import { useMenuMotion } from "./MenuMotion";
import { Segmented } from "./ui/Segmented";

export type SettingsSelectOption = { value: string; label: ReactNode; disabled?: boolean; preview?: ReactNode };

type Props = {
  value: string;
  onChange: (event: { target: { value: string } }) => void;
  options?: readonly SettingsSelectOption[];
  children?: ReactNode;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
  "data-settings-select"?: string;
  /** two to four short choices read better side by side than behind a menu */
  variant?: "menu" | "segmented";
};

function optionsFrom(children: ReactNode): SettingsSelectOption[] {
  const out: SettingsSelectOption[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const element = child as ReactElement<{ value?: string | number; children?: ReactNode; disabled?: boolean }>;
    if (element.type === "option") out.push({ value: String(element.props.value ?? ""), label: element.props.children, disabled: element.props.disabled });
    else if (element.props.children) out.push(...optionsFrom(element.props.children));
  });
  return out;
}

const GAP = 4;
const MENU_MIN = 200;

/** A filled chip sized to its value (a small preview, the label and a chevron) and a 200px menu under its right edge, 30px
 * rows with an inset highlight, their previews and a check on the chosen one; or, for a few short choices, a segmented pill. */
export function SettingsSelect({ variant = "menu", ...props }: Props) {
  if (variant === "segmented") {
    const options = props.options ?? optionsFrom(props.children);
    return (
      <Segmented
        value={props.value}
        aria-label={props["aria-label"] ?? ""}
        data-settings-select={props["data-settings-select"] ?? ""}
        disabled={props.disabled}
        className={props.className}
        options={options}
        onChange={(value) => props.onChange({ target: { value } })}
      />
    );
  }
  return <SelectMenu {...props} />;
}

function SelectMenu({ value, onChange, options: given, children, disabled, className, "aria-label": label, ...rest }: Omit<Props, "variant">) {
  const options = given ?? optionsFrom(children);
  const selected = options.find((option) => option.value === value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [place, setPlace] = useState<{ top?: number; bottom?: number; right: number; up: boolean } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const plain = options.every((option) => typeof option.label === "string" && !option.preview);
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
          })),
          disabled,
          label,
        }
      : null,
    (next) => {
      if (typeof next !== "string") return;
      const option = options.find((item) => item.value === next);
      if (option && !option.disabled && option.value !== value) onChange({ target: { value: option.value } });
    },
  );

  // the menu stays where it opened while it fades out, as Grok's does
  const motion = useMenuMotion(open);
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    close();
    if (option.value !== value) onChange({ target: { value: option.value } });
  };
  const pressed = useRef(false);
  const show = () => {
    if (disabled) return;
    const openFallback = () => {
      const menu = systemMenu();
      if (menu && trigger.current && plain) {
        void menu(trigger.current.getBoundingClientRect(), options.map((option) => ({
          key: option.value, label: option.label as string, checked: option.value === value, disabled: option.disabled,
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
    if (!open) { if (!motion.shown) setPlace(null); return; }
    if (!trigger.current) return;
    const box = trigger.current.getBoundingClientRect();
    const height = options.length * 32 + 10;
    const up = box.bottom + GAP + height > window.innerHeight - 8 && box.top - GAP - height > 8;
    setPlace({ right: window.innerWidth - box.right, up, ...(up ? { bottom: window.innerHeight - box.top + GAP } : { top: box.bottom + GAP }) });
  }, [open, options.length, motion.shown]);

  const placed = place !== null;
  useEffect(() => {
    if (open && placed) list.current?.focus({ preventScroll: true });
  }, [open, placed]);

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
        ref={trigger}
        type="button"
        role="combobox"
        aria-label={label}
        aria-hidden={system || undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        tabIndex={system ? -1 : undefined}
        disabled={disabled}
        data-settings-select={rest["data-settings-select"] ?? ""}
        data-system-popup={system ? "" : undefined}
        onPointerDown={(event) => {
          if (event.pointerType !== "mouse" || event.button !== 0) return;
          pressed.current = true;
          if (open) close(); else show();
        }}
        // the press must not pull focus back onto the pill after the menu took it, or Escape would close Settings
        onMouseDown={(event) => { if (event.button === 0) event.preventDefault(); }}
        onClick={() => {
          if (pressed.current) { pressed.current = false; return; }
          if (open) close(); else show();
        }}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
            event.preventDefault();
            show();
          }
        }}
        className={cn(
          "group inline-flex h-7 min-w-0 max-w-[240px] shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-ink/[0.06] py-1 pl-3 pr-2 text-[13px] leading-[18px] tracking-[-0.08px] text-ink",
          "[transition:color_100ms_ease,background-color_100ms_ease] hover:bg-ink/[0.09] aria-expanded:bg-ink/[0.09]",
          "outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus",
          "disabled:cursor-default disabled:opacity-50 disabled:hover:bg-ink/4",
          className,
          system && "h-auto min-h-6 max-w-[200px] rounded-none bg-transparent p-0 text-[17px] leading-[22px] opacity-0",
        )}
      >
        {selected?.preview && <span data-select-preview="" className="flex shrink-0 items-center">{selected.preview}</span>}
        <span className="min-w-0 flex-1 truncate text-start">{selected?.label ?? value}</span>
        <Icon name="chevron-down" size={system ? 16 : 10} className="shrink-0 text-ink/[0.66] transition-[rotate] duration-150 ease-out group-aria-expanded:rotate-180 group-aria-expanded:text-ink motion-reduce:transition-none" />
      </button>
      {motion.shown && place && createPortal(
        <div
          ref={list}
          {...motion.exitProps}
          id={`${id}-list`}
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={active >= 0 ? `${id}-${active}` : undefined}
          data-settings-listbox=""
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
            else if (event.key === "Tab") close();
            else if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => step(index, 1)); }
            else if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => step(index, -1)); }
            else if (event.key === "Home") { event.preventDefault(); setActive(step(-1, 1)); }
            else if (event.key === "End") { event.preventDefault(); setActive(step(options.length, -1)); }
            else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(active); }
          }}
          style={{ top: place.top, bottom: place.bottom, right: place.right, minWidth: MENU_MIN, transformOrigin: place.up ? "right bottom" : "right top" }}
          className={cn(motion.className, "fixed z-[2147482000] flex max-h-[min(360px,calc(100vh-16px))] max-w-[320px] flex-col gap-0.5 overflow-y-auto rounded-2xl bg-menu py-1.5 text-[13px] leading-[18px] tracking-[-0.08px] text-ink shadow-(--shadow-popover) outline-none [scrollbar-width:none]")}
        >
          {options.map((option, index) => (
            <div
              key={option.value}
              id={`${id}-${index}`}
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined}
              data-highlighted={index === active ? "" : undefined}
              onPointerMove={() => !option.disabled && setActive(index)}
              onClick={() => choose(index)}
              className={cn(
                "relative flex min-h-[30px] shrink-0 cursor-pointer select-none items-center gap-2 px-3.5 py-1.5",
                "before:pointer-events-none before:absolute before:inset-y-0 before:inset-x-1.5 before:rounded-[10px] before:content-[''] data-highlighted:before:bg-ink/[0.06]",
                "aria-disabled:cursor-default aria-disabled:opacity-50",
              )}
            >
              {option.preview && <span data-select-preview="" className="relative flex shrink-0 items-center">{option.preview}</span>}
              <span className="relative min-w-0 flex-1 truncate">{option.label}</span>
              {option.value === value && <Icon name="check" size={12} className="relative shrink-0" />}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
