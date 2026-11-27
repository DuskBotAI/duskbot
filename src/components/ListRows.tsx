import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type MouseEventHandler, type ReactElement, type ReactNode, type Ref } from "react";
import { Check, ChevronRight, Copy, type GlyphIcon } from "../icons";

import { cn } from "@/lib/cn";
import { useCopyFeedback } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { plainDialogText, systemDialogs, type SystemFormOptions } from "@/lib/system-dialog";
import { BAR_RANK, useChrome, useNativeBar, useSheetPushDepth } from "@/mobile/chrome";
import { useNativeTrail } from "@/mobile/native-push";
import type { MobileChrome } from "@/mobile/platform";
import { Icon } from "./Icon";
import { DialogPane, fieldLabelCls, GrokDialog, rowButtonCls, rowPrimaryCls } from "./ui/GrokDialog";
import { SelectPill, type SelectPillOption } from "./ui/SelectPill";
import { Toggle } from "./ui/Toggle";
import { ArtState, HeadArt, type ArtName } from "./ui/Art";
import { SettingGlyph, type SettingGlyphName } from "./ui/SettingGlyph";

/* The one row list the side panel, Settings and the settings sheets all draw: a small grey label over a white 12px card,
   30px rows inside it with the name on the left in ink, the value on the right in secondary ink, a small chevron, and a
   soft rounded pill on hover. Nothing else sits in a row; anything bigger opens a menu, a page or a small form. */

export const rowCls = "flex min-h-[30px] items-center gap-2 rounded-lg px-2 py-1.5";
const focusCls = "outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus";
const titleCls = "text-[13px] leading-[18px] tracking-[0.015em] text-ink";
const hintCls = "text-[13px] leading-[18px] tracking-[0.015em] text-ink-secondary";
const valueCls = "min-w-0 max-w-[50%] shrink-0 truncate text-[13px] leading-[18px] tracking-[0.015em] text-ink-secondary";

/** Grok's elevated 36px icon button (Share, Close): a white circle on a hairline, a 6% ink wash laid over it on hover. */
export const roundButtonCls = "flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full border-[0.5px] border-edge bg-composer text-ink/[0.92] transition-[background-color,color] duration-[120ms] ease-[ease-out] hover:bg-linear-to-b hover:from-ink/[0.06] hover:to-ink/[0.06] aria-expanded:bg-linear-to-b aria-expanded:from-ink/[0.06] aria-expanded:to-ink/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";
/** The quiet 30px pill, and the ink one for the single action that commits. */
export const pillCls = rowButtonCls;
export const pillPrimaryCls = cn(rowButtonCls, "bg-ink text-app shadow-none enabled:hover:bg-[color-mix(in_srgb,var(--color-ink)_88.5%,var(--color-menu))] disabled:bg-ink/15 disabled:text-ink/30");

export const sectionGapCls = (labelled: boolean) => (labelled ? "mt-[22px]" : "mt-3");

export function CardLabel({ children, action, id, art }: { children: ReactNode; action?: ReactNode; id?: string; art?: ArtName }) {
  return (
    <div data-settings-group-head="" className="mb-2.5 flex min-h-[18px] items-center gap-3 px-3 text-[13px] leading-[18px] tracking-normal text-ink-secondary">
      {art && <HeadArt name={art} />}
      <div className="flex min-w-0 flex-1 items-center justify-between gap-1">
        <h3 id={id} data-settings-heading="" className="m-0 min-w-0 truncate text-[13px] font-normal leading-[18px]">{children}</h3>
        {action}
      </div>
    </div>
  );
}

export function LabelAction({ children, onClick, ...rest }: { children: ReactNode; onClick: () => void; "aria-label"?: string; "data-panel-action"?: string; "data-panel-page"?: string }) {
  return (
    <button type="button" {...rest} onClick={onClick} className="-my-px shrink-0 rounded-md px-1.5 py-px text-[13px] leading-[18px] text-ink-secondary transition-colors duration-100 hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
      {children}
    </button>
  );
}

const InSections = createContext(false);

/** A page's sections in Grok's one rhythm: 22px between each, whatever it is (a card, a labelled card, an empty line). The
 * cards inside drop their own margins; a wrapper of several cards passes them through with `contents`. */
export function PanelSections({ children, className, ...rest }: { children: ReactNode; className?: string; "data-panel-tabpanel"?: string }) {
  return (
    <InSections.Provider value={true}>
      <div {...rest} data-panel-sections="" className={cn("flex flex-col gap-[22px]", className)}>{children}</div>
    </InSections.Provider>
  );
}

/** A labelled white card of rows. */
export function Card({ label, art, action, anchor, footnote, className, children, ...rest }: {
  label?: ReactNode;
  art?: ArtName;
  action?: ReactNode;
  anchor?: string;
  footnote?: ReactNode;
  className?: string;
  children: ReactNode;
  "data-settings-block"?: string;
  "data-sheet-group"?: string;
}) {
  const inSections = useContext(InSections);
  const labelId = useId();
  return (
    <section
      {...rest}
      data-panel-card={anchor}
      data-settings-art={art}
      aria-labelledby={typeof label === "string" ? labelId : undefined}
      className={cn("scroll-mt-4", !inSections && cn(sectionGapCls(Boolean(label)), "first:mt-0"), className)}
    >
      {label && <CardLabel id={labelId} action={action} art={art}>{label}</CardLabel>}
      <div data-panel-card-surface="" className="flex flex-col overflow-hidden rounded-[12px] border-[0.5px] border-edge bg-composer p-1">
        {children}
      </div>
      {footnote && <p data-settings-footnote="" className="mt-2 px-3 text-[12px] leading-4 tracking-[0.01em] text-ink-tertiary">{footnote}</p>}
    </section>
  );
}

/** Grok's empty tab: centred 13/18 copy at 56% ink, right under the tabs and 16px in from each side. */
/** A list with nothing in it yet. Given art and a title, the pixel drawing, the title and this line as its hint. */
export function PanelEmpty({ children, art, title, ...rest }: { children: ReactNode; art?: ArtName; title?: ReactNode; "data-panel-empty"?: string }) {
  if (art && title) return <ArtState {...rest} data-art-state={rest["data-panel-empty"]} art={art} title={title}>{children}</ArtState>;
  return (
    <div {...rest} className="flex flex-col gap-2.5 px-4 py-4">
      <p className="text-pretty text-center text-[13px] leading-[18px] tracking-[0.015em] text-ink/[0.56]">{children}</p>
    </div>
  );
}

export function RowText({ title, hint, tone, titleId, hintId, wrapHint = false }: { title: ReactNode; hint?: ReactNode; tone?: "danger" | "warn"; titleId?: string; hintId?: string; wrapHint?: boolean }) {
  return (
    <div className="min-w-0 flex-1">
      <div id={titleId} data-row-title="" className={cn(titleCls, tone === "danger" && "text-danger", tone === "warn" && "text-warning")}>{title}</div>
      {hint && <div id={hintId} data-row-hint="" className={cn(hintCls, wrapHint ? "text-pretty" : "truncate")}>{hint}</div>}
    </div>
  );
}

export function RowIcon({ icon: Icon }: { icon: GlyphIcon }) {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-md text-ink-secondary" aria-hidden="true">
      <Icon size={15} />
    </span>
  );
}

function RowValue({ value, id }: { value?: ReactNode; id?: string }) {
  if (value === undefined || value === null || value === "" || value === false) return null;
  return <span id={id} data-panel-value="" className={valueCls}>{value}</span>;
}

/** A row that goes somewhere or does one thing: the name, its value, a chevron (or an out arrow for a web page). */
export function NavRow({ title, hint, value, icon, pixel, onClick, drill = true, external = false, danger = false, disabled, tooltip, ...rest }: {
  title: ReactNode;
  hint?: ReactNode;
  value?: ReactNode;
  icon?: GlyphIcon;
  /** a one-colour pixel glyph (or a drawn mark of the same size) in the row's leading slot */
  pixel?: SettingGlyphName | ReactElement;
  onClick: () => void;
  drill?: boolean;
  external?: boolean;
  danger?: boolean;
  disabled?: boolean;
  tooltip?: string;
  ref?: Ref<HTMLButtonElement>;
  "aria-label"?: string;
  "aria-expanded"?: boolean;
  "data-panel-row"?: string;
  "data-panel-page"?: string;
  "data-panel-gear"?: boolean;
  "data-settings-open"?: string;
  "data-settings-advanced"?: string;
  "data-sheet-row"?: string;
}) {
  // the row's name is its title and value; the grey line under the title describes it
  const id = useId();
  const named = value !== undefined && value !== null && value !== "" && value !== false;
  return (
    <button
      type="button"
      aria-labelledby={rest["aria-label"] ? undefined : named ? `${id}-title ${id}-value` : `${id}-title`}
      aria-describedby={hint ? `${id}-hint` : undefined}
      {...rest}
      disabled={disabled}
      title={tooltip}
      onClick={onClick}
      className={cn(rowCls, focusCls, "w-full cursor-pointer text-left enabled:hover:bg-ink/[0.035] enabled:active:bg-ink/[0.05] disabled:cursor-default disabled:opacity-45")}
    >
      {icon && <RowIcon icon={icon} />}
      {pixel && <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center">{typeof pixel === "string" ? <SettingGlyph name={pixel} /> : pixel}</span>}
      <RowText title={title} hint={hint} tone={danger ? "danger" : undefined} titleId={`${id}-title`} hintId={`${id}-hint`} />
      <RowValue value={value} id={`${id}-value`} />
      {external
        ? <Icon name="link-external" size={12} className="shrink-0 text-ink-tertiary" />
        : drill && <ChevronRight size={14} className="-mr-0.5 shrink-0 text-ink-tertiary rtl:-scale-x-100" aria-hidden="true" />}
    </button>
  );
}

/** A row that only shows something: the name and its value, or a control of its own on the right. */
export function ItemRow({ title, hint, value, icon, pixel, tone, children, ...rest }: {
  title: ReactNode;
  hint?: ReactNode;
  value?: ReactNode;
  icon?: GlyphIcon;
  /** a one-colour pixel glyph (or a drawn mark of the same size) in the row's leading slot */
  pixel?: SettingGlyphName | ReactElement;
  tone?: "danger" | "warn";
  children?: ReactNode;
  onClick?: MouseEventHandler<HTMLDivElement>;
  "data-panel-row"?: string;
  "data-sheet-row"?: string;
}) {
  return (
    <div {...rest} className={rowCls}>
      {icon && <RowIcon icon={icon} />}
      {pixel && <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center">{typeof pixel === "string" ? <SettingGlyph name={pixel} /> : pixel}</span>}
      <RowText title={title} hint={hint} tone={tone} />
      <RowValue value={value} />
      {children}
    </div>
  );
}

/** A plain on/off: the name, and Grok's switch on the right (a bot's own colours when given). */
export function SwitchRow({ title, hint, checked, onChange, disabled, tone, label, tooltip, extra, ...rest }: {
  title: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  tone?: { on: string; hover: string };
  label?: string;
  tooltip?: string;
  extra?: ReactNode;
  "data-panel-row"?: string;
  "data-sheet-row"?: string;
}) {
  return (
    <div {...rest} className={rowCls}>
      <RowText title={title} hint={hint} />
      {extra}
      <Toggle
        tone={tone}
        checked={checked}
        disabled={disabled}
        title={tooltip}
        aria-label={label ?? (typeof title === "string" ? title : undefined)}
        onClick={onChange}
        className="disabled:cursor-not-allowed"
      />
    </div>
  );
}

/** A pick-one value: the whole row opens the panel's menu under its right edge, the value and a small chevron on the right. */
export function SelectRow<V extends string>({ title, hint, value, options, onChange, disabled, label, tooltip, ...rest }: {
  title: ReactNode;
  hint?: ReactNode;
  value: V;
  options: readonly SelectPillOption<V>[];
  onChange: (value: V) => void;
  disabled?: boolean;
  label?: string;
  tooltip?: string;
  "data-panel-row"?: string;
  "data-panel-select"?: string;
  "data-sheet-row"?: string;
}) {
  return (
    <div
      data-panel-row={rest["data-panel-row"]}
      data-sheet-row={rest["data-sheet-row"]}
      data-select-row=""
      className={cn(
        rowCls,
        "relative",
        "has-[[role=combobox]:focus-visible]:outline-2 has-[[role=combobox]:focus-visible]:-outline-offset-2 has-[[role=combobox]:focus-visible]:outline-focus has-[[role=combobox]:disabled]:opacity-45",
      )}
    >
      <RowText title={title} hint={hint} />
      <SelectPill
        data-panel-select={rest["data-panel-select"]}
        aria-label={label ?? (typeof title === "string" ? title : "")}
        title={tooltip}
        value={value}
        options={options}
        disabled={disabled}
        onChange={onChange}
        className={cn(
          "static my-0 mr-0 h-auto max-w-[50%] gap-1.5 rounded-none border-0 bg-transparent p-0 text-ink-secondary",
          "hover:bg-transparent aria-expanded:bg-transparent focus-visible:ring-0 disabled:opacity-100",
          "after:absolute after:inset-0 after:rounded-lg after:content-['']",
        )}
      />
    </div>
  );
}

/** One of several to choose: the name, and Grok's small check on the right only when chosen. */
export function CheckRow({ title, hint, leading, checked, onClick, disabled, role = "checkbox", ...rest }: {
  title: ReactNode;
  hint?: ReactNode;
  leading?: ReactNode;
  checked: boolean;
  onClick: () => void;
  disabled?: boolean;
  role?: "checkbox" | "radio" | "option";
  "data-panel-choice"?: string;
  "data-sheet-row"?: string;
  "data-bot-id"?: string;
  "aria-label"?: string;
}) {
  return (
    <button
      type="button"
      {...rest}
      role={role}
      aria-checked={role === "option" ? undefined : checked}
      aria-selected={role === "option" ? checked : undefined}
      disabled={disabled}
      onClick={onClick}
      className={cn(rowCls, focusCls, "w-full cursor-pointer text-left enabled:hover:bg-ink/[0.035] enabled:active:bg-ink/[0.05] disabled:cursor-default disabled:opacity-45")}
    >
      {leading}
      <RowText title={title} hint={hint} />
      <span className="flex w-3 shrink-0 justify-end text-ink">{checked && <Icon name="check" size={12} />}</span>
    </button>
  );
}

/** A command or address to copy: its name, the text itself as the row's quiet mono line, and a small copy button. The
 * one way Settings shows a command. */
export function CopyRow({ title, text, copyLabel, multiline = false, ...rest }: { title: ReactNode; text: string; copyLabel?: string; multiline?: boolean; "data-sheet-row"?: string; "data-copy-row"?: string }) {
  const { state, copy } = useCopyFeedback(text);
  const label = state === "failed" ? t("common.copyFailed") : state === "copied" ? t("settings.s2.copied")
    : copyLabel ?? t("settings.s2.copy", { what: text });
  return (
    <div {...rest} data-copy-row={rest["data-copy-row"] ?? ""} className={rowCls}>
      <div className="min-w-0 flex-1">
        <div data-row-title="" className={titleCls}>{title}</div>
        <code data-copy-text="" className={cn("block font-mono text-[12px] leading-4 text-ink-secondary select-all", multiline ? "overflow-x-auto whitespace-pre" : "truncate")}>{text}</code>
      </div>
      <button type="button" onClick={copy} aria-label={label} title={label}
        className={cn("flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-ink-secondary hover:bg-ink/[0.035] hover:text-ink", focusCls)}>
        {state === "copied" ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
      </button>
    </div>
  );
}

export function NoteRow({ children, tone, ...rest }: { children: ReactNode; tone?: "warn" | "danger"; "data-sheet-row"?: string }) {
  return (
    <div {...rest} role={tone ? "alert" : undefined} className={rowCls}>
      <div className={cn("min-w-0 text-[13px] leading-[18px] tracking-[0.015em] [overflow-wrap:anywhere]", tone === "danger" ? "text-danger" : tone === "warn" ? "text-warning" : "text-ink-secondary")}>{children}</div>
    </div>
  );
}

/* pages inside a pane: a row opens one, it slides in over the list with a back chevron in the header */

export interface SubPage { id: string; title: string }
interface SubPageNav { at: string | undefined; open: (id: string, title: string) => void; back: () => void; stack?: readonly SubPage[] }

export const SubPageContext = createContext<SubPageNav>({ at: undefined, open: () => {}, back: () => {} });

/** The page of the pane this is drawn in (undefined on the pane's own list), and the way into another or back out. */
export function useSubPage(): SubPageNav {
  return useContext(SubPageContext);
}

export const WIPE_MS = 200;
export const reducedMotion = () => document.documentElement.dataset.reducedMotion === "true" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/** The page on screen as it is drawn now, without ids: the outgoing layer of a wipe shows this copy, so leaving a page never
 * mounts it a second time (its effects, reads and prompts would all run again for a 200ms slide). */
export function snapshotLayer(layer: HTMLElement | null): DocumentFragment | null {
  if (!layer) return null;
  const copy = document.createDocumentFragment();
  for (const child of layer.childNodes) copy.append(child.cloneNode(true));
  copy.querySelectorAll("[id]").forEach((element) => element.removeAttribute("id"));
  return copy;
}

/** Grok's in-dialog push between a list and a page of it (200ms, the app "out" curve): the incoming layer slides over the
 * outgoing one on push, the outgoing slides off it on pop. A change of `group` (another pane) swaps without motion. The
 * outgoing layer is a still copy of what was on screen, inert; `layer(at, false)` draws it only when there is none. */
export function WipeStack({ at, depth, group, layer }: { at: string; depth: number; group: string; layer: (at: string, live: boolean) => ReactNode }) {
  const [shown, setShown] = useState({ at, depth, group });
  const [wipe, setWipe] = useState<{ direction: "push" | "pop" | "fade"; from: string; scrollTop: number; id: number } | null>(null);
  const live = useRef<HTMLDivElement>(null);
  const still = useRef<{ id: number; copy: DocumentFragment } | null>(null);
  if (at !== shown.at) {
    setShown({ at, depth, group });
    const within = group === shown.group && depth !== shown.depth;
    const scroller = live.current?.querySelector<HTMLElement>("[data-wipe-scroll]");
    const copy = within ? snapshotLayer(live.current) : null;
    still.current = copy ? { id: (wipe?.id ?? 0) + 1, copy } : null;
    // with reduced motion the page only fades in, no slide
    setWipe(within ? { direction: reducedMotion() ? "fade" : depth > shown.depth ? "push" : "pop", from: shown.at, scrollTop: scroller?.scrollTop ?? 0, id: (wipe?.id ?? 0) + 1 } : null);
  }
  useLayoutEffect(() => {
    if (shown.group !== group) return;
    live.current?.querySelector<HTMLElement>("[data-wipe-scroll]")?.scrollTo({ top: 0 });
  }, [at, group, shown.group]);
  useEffect(() => {
    if (!wipe) return;
    // focus left with the old layer: it lands on the new heading
    const active = document.activeElement;
    const heading = live.current?.querySelector<HTMLElement>(".settings-pane-title");
    if (heading && (!active || active === document.body || active.closest("[inert]"))) {
      heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: true });
      heading.addEventListener("blur", () => heading.removeAttribute("tabindex"), { once: true });
    }
    const timer = window.setTimeout(() => setWipe((current) => (current?.id === wipe.id ? null : current)), WIPE_MS + 50);
    return () => window.clearTimeout(timer);
  }, [wipe]);
  return (
    <div className="settings-wipe">
      <div ref={live} className="settings-wipe-layer" data-wipe={wipe?.direction}>{layer(at, true)}</div>
      {wipe && (
        <div
          key={`out:${wipe.id}`}
          aria-hidden="true"
          inert
          className="settings-wipe-layer"
          data-wipe={wipe.direction}
          data-wipe-out=""
          ref={(element) => {
            if (element && still.current?.id === wipe.id && !element.childNodes.length) element.append(still.current.copy);
            const scroller = element?.querySelector<HTMLElement>("[data-wipe-scroll]");
            if (scroller) scroller.scrollTop = wipe.scrollTop;
          }}
          onAnimationEnd={(event) => { if (event.target === event.currentTarget) setWipe((current) => (current?.id === wipe.id ? null : current)); }}
        >
          {still.current?.id === wipe.id ? null : layer(wipe.from, false)}
        </div>
      )}
    </div>
  );
}

export function BackButton({ onBack, label = t("common.back") }: { onBack: () => void; label?: string }) {
  return (
    <button
      type="button"
      data-settings-back=""
      onClick={onBack}
      aria-label={label}
      title={label}
      className={cn(
        "-ms-1 inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-ink/[0.56] transition-colors duration-150 ease-[ease] hover:bg-ink/[0.06] hover:text-ink-secondary",
        "outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus",
      )}
    >
      <Icon name="chevron-left" size={14} className="rtl:-scale-x-100 max-sm:in-[.settings-pane-header]:hidden" />
      <Icon name="arrow-left" size={22} className="hidden rtl:-scale-x-100 max-sm:in-[.settings-pane-header]:inline-flex" />
    </button>
  );
}

/** A pane's header: its title, or a page's title behind a back chevron. */
export function PaneHeader({ title, onBack, backLabel, headingId, children }: { title: ReactNode; onBack?: () => void; backLabel?: string; headingId?: string; children?: ReactNode }) {
  return (
    <header className="settings-pane-header">
      <div className="flex min-w-0 items-center gap-1.5">
        {onBack && <BackButton onBack={onBack} label={backLabel} />}
        <h2 id={headingId} className={cn("settings-pane-title truncate outline-none", onBack && "ps-0")}>{title}</h2>
      </div>
      {children}
    </header>
  );
}

/** Inside Settings, the depth of Settings' page stack a sheet pane was opened at: its own pages go on that stack, under
 * Settings' header, instead of a header and stack of its own. */
export const SheetInSettings = createContext<number | null>(null);

/** One pane of a bot's or a room's settings: Settings' header and scrolling list, and pages a row opens sliding in over
 * it. The page component reads `useSubPage().at` to draw the list or the page it is on. */
export function SheetPane({ title, footer, children, ...rest }: { title: string; footer?: ReactNode; children: ReactNode; "data-panel-modal"?: string }) {
  const base = useContext(SheetInSettings);
  const outer = useContext(SubPageContext);
  if (base !== null) {
    const nav: SubPageNav = { at: (outer.stack?.length ?? 0) > base ? outer.stack!.at(-1)!.id : undefined, open: outer.open, back: outer.back, stack: outer.stack?.slice(base) };
    return (
      <section {...rest} className="contents">
        <SubPageContext.Provider value={nav}>{children}</SubPageContext.Provider>
        {footer && !nav.at && <div className="flex shrink-0 items-center justify-end gap-2">{footer}</div>}
      </section>
    );
  }
  return <OwnSheetPane title={title} footer={footer} {...rest}>{children}</OwnSheetPane>;
}

function OwnSheetPane({ title, footer, children, ...rest }: { title: string; footer?: ReactNode; children: ReactNode; "data-panel-modal"?: string }) {
  const chrome = useChrome();
  if (chrome?.beginPush && chrome.commitPush && chrome.popPage) {
    return <NativeOwnSheetPane chrome={chrome} title={title} footer={footer} {...rest}>{children}</NativeOwnSheetPane>;
  }
  return <WebOwnSheetPane title={title} footer={footer} {...rest}>{children}</WebOwnSheetPane>;
}

function NativeOwnSheetPane({ chrome, title, footer, children, ...rest }: {
  chrome: MobileChrome;
  title: string;
  footer?: ReactNode;
  children: ReactNode;
  "data-panel-modal"?: string;
}) {
  const pushDepth = useSheetPushDepth();
  const [committed, setCommitted] = useState<SubPage[]>([]);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const trail = useNativeTrail<SubPage>(chrome, (_removed, remaining) => setCommitted(remaining));

  const open = useCallback((id: string, pageTitle: string) => {
    trail.push(() => ({ id, title: pageTitle }), (page, pushedTrail) => {
      setCommitted(pushedTrail ?? ((current) => [...current, page]));
      scrollerRef.current?.scrollTo({ top: 0 });
    });
  }, [trail]);

  const back = useCallback(() => {
    if (!trail.back()) setCommitted((current) => current.slice(0, -1));
  }, [trail]);

  const top = committed.at(-1);
  const rank = BAR_RANK.sheetPushed + (pushDepth + committed.length) * 0.01;
  useNativeBar(rank, top ? {
    title: top.title,
    leading: [{ id: "back", symbol: "chevron.backward", label: t("mobile.sheet.back") }],
    trailing: [],
  } : null, { back });

  const nav = useMemo<SubPageNav>(() => ({
    at: top?.id,
    open,
    back,
    stack: committed,
  }), [top?.id, open, back, committed]);

  return (
    <section {...rest} aria-labelledby={titleId} className="flex min-h-0 flex-1 flex-col">
      <PaneHeader title={top?.title ?? title} headingId={titleId} />
      <div ref={scrollerRef} data-wipe-scroll="" className="settings-scroll">
        <div className="settings-pane">
          <SubPageContext.Provider value={nav}>
            <PanelSections>{children}</PanelSections>
          </SubPageContext.Provider>
          {footer && !top && <div className="flex shrink-0 items-center justify-end gap-2">{footer}</div>}
        </div>
      </div>
    </section>
  );
}

function WebOwnSheetPane({ title, footer, children, ...rest }: { title: string; footer?: ReactNode; children: ReactNode; "data-panel-modal"?: string }) {
  const [stack, setStack] = useState<SubPage[]>([]);
  const titleId = useId();
  const at = JSON.stringify(stack);
  const layer = (key: string, live: boolean) => {
    const pages = JSON.parse(key) as SubPage[];
    const top = pages.at(-1);
    const nav: SubPageNav = {
      at: top?.id,
      open: (id, pageTitle) => setStack([...pages, { id, title: pageTitle }]),
      back: () => setStack(pages.slice(0, -1)),
    };
    return (
      <>
        <PaneHeader title={top?.title ?? title} headingId={live ? titleId : undefined} onBack={top ? nav.back : undefined} />
        <div data-wipe-scroll="" className="settings-scroll">
          <div className="settings-pane">
            <SubPageContext.Provider value={nav}>
              <PanelSections>{children}</PanelSections>
            </SubPageContext.Provider>
            {footer && !top && <div className="flex shrink-0 items-center justify-end gap-2">{footer}</div>}
          </div>
        </div>
      </>
    );
  };
  return (
    <section {...rest} aria-labelledby={titleId} className="flex min-h-0 flex-1 flex-col">
      <WipeStack at={at} depth={stack.length} group="" layer={layer} />
    </section>
  );
}

/** Grok's compact form dialog for typing something in (a name, a key, a login): fields, then a quiet Cancel and an ink
 * Save on the right. Always its own sheet, even when opened from inside a railed sheet's pane. */
export function FormDialog({ title, description, saveLabel, cancelLabel, canSave = true, busy = false, error, width = 400, onSave, onClose, nativeForm, children, ...rest }: {
  title: ReactNode;
  description?: ReactNode;
  saveLabel?: string;
  cancelLabel?: string;
  canSave?: boolean;
  busy?: boolean;
  error?: ReactNode;
  width?: number;
  /** without it the dialog has only a Done that closes it, for fields that save as they change */
  onSave?: () => void | Promise<unknown>;
  onClose: () => void;
  /** When supplied on iOS, presents a native SwiftUI modal Form sheet instead of a web dialog. */
  nativeForm?: Omit<SystemFormOptions, "title" | "description" | "saveLabel" | "cancelLabel"> & {
    onSaved?: (values: Record<string, string>) => void;
  };
  children: ReactNode;
  "data-panel-modal"?: string;
}) {
  const formId = useId();
  const dialogs = systemDialogs();
  const nativeTitle = dialogs && nativeForm ? plainDialogText(title)?.trim() : null;
  if (dialogs && nativeForm && nativeTitle) {
    const nativeDesc = description ? plainDialogText(description)?.trim() || undefined : undefined;
    return (
      <NativeFormDialog
        title={nativeTitle}
        description={nativeDesc}
        saveLabel={saveLabel}
        cancelLabel={cancelLabel}
        nativeForm={nativeForm}
        onClose={onClose}
      />
    );
  }
  const runSave = () => {
    if (!onSave) { onClose(); return; }
    if (!canSave || busy) return;
    void onSave();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    runSave();
  };
  return (
    <DialogPane.Provider value={false}>
      <GrokDialog
        {...rest}
        title={title}
        description={description}
        width={width}
        onClose={onClose}
        nativeAction={{
          label: onSave ? saveLabel ?? t("common.save") : t("common.done"),
          role: onSave ? "confirm" : "done",
          disabled: Boolean(onSave) && (!canSave || busy),
          onPress: runSave,
        }}
        footer={(
          <>
            {onSave && <button type="button" className={rowButtonCls} onClick={onClose}>{cancelLabel ?? t("common.cancel")}</button>}
            <button type="submit" form={formId} disabled={Boolean(onSave) && (!canSave || busy)} className={rowPrimaryCls}>{onSave ? saveLabel ?? t("common.save") : t("common.done")}</button>
          </>
        )}
      >
        <form id={formId} onSubmit={submit} className="flex flex-col gap-3">
          {children}
          {error && <p role="alert" className="m-0 text-[12px] leading-4 text-danger">{error}</p>}
        </form>
      </GrokDialog>
    </DialogPane.Provider>
  );
}

function NativeFormDialog({ title, description, saveLabel, cancelLabel, nativeForm, onClose }: {
  title: string;
  description?: string;
  saveLabel?: string;
  cancelLabel?: string;
  nativeForm: Omit<SystemFormOptions, "title" | "description" | "saveLabel" | "cancelLabel"> & {
    onSaved?: (values: Record<string, string>) => void;
  };
  onClose: () => void;
}) {
  const latest = useRef({ nativeForm, onClose });
  latest.current = { nativeForm, onClose };

  useEffect(() => {
    const dialogs = systemDialogs();
    if (!dialogs) return;
    let alive = true;
    const { onSaved: _, onSubmit, fields, requireChange } = latest.current.nativeForm;
    void dialogs.form({
      title,
      description,
      saveLabel,
      cancelLabel,
      fields,
      requireChange,
      ...(onSubmit ? { onSubmit: (values) => latest.current.nativeForm.onSubmit?.(values) } : {}),
    }).then((result) => {
      if (!alive) return;
      if (result.saved) latest.current.nativeForm.onSaved?.(result.values);
      latest.current.onClose();
    });
    return () => {
      alive = false;
      dialogs.dismissForm?.();
    };
  }, [title, description, saveLabel, cancelLabel]);

  return null;
}

/** A labelled field inside a FormDialog. */
export function FormField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className={fieldLabelCls}>{label}</span>
      {children}
    </label>
  );
}
