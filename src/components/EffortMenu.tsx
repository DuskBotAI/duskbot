import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown } from "../icons";
import type { EffortLevel } from "../../shared/wire";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { triggerSystemControl, useSystemControl } from "@/lib/system-control";
import { effortLabel } from "./ModelPicker";
import { useMenuMotion } from "./MenuMotion";

export interface EffortMenuProps {
  levels: readonly EffortLevel[];
  current?: EffortLevel;
  onPick: (level: EffortLevel) => void;
  onReset: () => void;
}

export function EffortMenu({ levels, current, onPick, onReset }: EffortMenuProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const motion = useMenuMotion(open);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const choices: Array<EffortLevel | undefined> = [undefined, ...levels];
  const name = current ? effortLabel(current) : t("model.effort.default");
  const system = useSystemControl(
    trigger,
    {
      kind: "popup",
      title: name,
      value: current ?? "",
      options: choices.map((level) => ({
        key: level ?? "",
        label: level ? effortLabel(level) : t("model.effort.default"),
      })),
      label: `${t("botSettings.simple.thinking")}: ${name}`,
    },
    (next) => {
      if (typeof next !== "string") return;
      const picked = choices.find((level) => (level ?? "") === next);
      if (picked === current) return;
      if (picked) onPick(picked);
      else onReset();
    },
  );

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus({ preventScroll: true });
  };
  const choose = (index: number) => {
    const level = choices[index];
    close();
    if (level === current) return;
    if (level) onPick(level);
    else onReset();
  };
  const show = () => {
    if (system && trigger.current) {
      void triggerSystemControl(trigger.current).then((triggered) => {
        if (!triggered) {
          setActive(Math.max(0, choices.indexOf(current)));
          setOpen(true);
        }
      });
      return;
    }
    setActive(Math.max(0, choices.indexOf(current)));
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    list.current?.focus({ preventScroll: true });
    list.current?.scrollIntoView?.({ block: "nearest" });
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);

  const onListKey = (event: KeyboardEvent) => {
    const stop = () => { event.preventDefault(); event.stopPropagation(); };
    if (event.key === "Escape") { stop(); close(); }
    else if (event.key === "Tab") close(false);
    else if (event.key === "ArrowDown") { stop(); setActive((at) => (at + 1) % choices.length); }
    else if (event.key === "ArrowUp") { stop(); setActive((at) => (at + choices.length - 1) % choices.length); }
    else if (event.key === "Home") { stop(); setActive(0); }
    else if (event.key === "End") { stop(); setActive(choices.length - 1); }
    else if (event.key === "Enter" || event.key === " ") { stop(); choose(active); }
    else event.stopPropagation();
  };

  return (
    <span ref={root} data-simple-thinking className="absolute right-1 top-1/2 z-10 -translate-y-1/2">
      <button
        ref={trigger}
        type="button"
        data-effort-trigger
        data-system-popup={system ? "" : undefined}
        aria-hidden={system || undefined}
        tabIndex={system ? -1 : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-label={`${t("botSettings.simple.thinking")}: ${name}`}
        title={current ? t("model.simple.thinkingLevel", { level: name }) : t("model.simple.thinkingDefault")}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); event.stopPropagation(); show(); }
          else if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation();
        }}
        className={cn(
          "flex h-6 items-center gap-1 rounded-md px-2 text-[12px] leading-4 text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink aria-expanded:bg-ink/[0.08] aria-expanded:text-ink focus-visible:outline-none focus-visible:ring-[1.5px] focus-visible:ring-focus motion-reduce:transition-none touch:h-8",
          system && "h-auto min-h-6 rounded-none bg-transparent p-0 text-[17px] leading-[22px] opacity-0",
        )}
      >
        <span>{name}</span>
        <ChevronDown size={12} aria-hidden="true" className="shrink-0" />
      </button>
      {motion.shown && (
        <div
          ref={list}
          id={`${id}-list`}
          role="listbox"
          tabIndex={-1}
          aria-label={t("botSettings.simple.thinking")}
          aria-activedescendant={`${id}-${active}`}
          data-effort-listbox
          {...motion.exitProps}
          onKeyDown={onListKey}
          style={{ transformOrigin: "right top" }}
          className={cn(motion.className, "absolute right-0 top-full z-10 mt-1 flex min-w-[148px] flex-col gap-0.5 rounded-xl bg-menu p-1 text-[13px] leading-[18px] text-ink shadow-(--shadow-popover) outline-none")}
        >
          {choices.map((level, index) => (
            <div
              key={level ?? "default"}
              id={`${id}-${index}`}
              role="option"
              aria-selected={level === current}
              data-effort-option={level ?? "default"}
              data-highlighted={index === active ? "" : undefined}
              title={level ? t("model.simple.thinkingLevel", { level: effortLabel(level) }) : t("model.simple.thinkingDefault")}
              onPointerMove={() => setActive(index)}
              onClick={() => choose(index)}
              className="flex h-[30px] cursor-pointer select-none items-center gap-2 rounded-lg px-2 data-highlighted:bg-ink/[0.06] touch:h-10"
            >
              <span className="min-w-0 flex-1 truncate">{level ? effortLabel(level) : t("model.effort.default")}</span>
              {level === current && <Check size={14} className="shrink-0 text-accent" aria-hidden="true" />}
            </div>
          ))}
        </div>
      )}
    </span>
  );
}
