import { forwardRef, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ArrowLeft, ArrowRight, Globe, Hand, Keyboard, Loader2, Lock, Maximize, Plus, RotateCw, Shrink, X } from "../../icons";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { blankPage, pageTitle, siteOf, tabLetter } from "@/lib/local-browser";
import { siteIconUrl } from "@/lib/site-icon";
import { systemDialogs } from "@/lib/system-dialog";
import { popoverClosesOnKey, popoverClosesOnPointer } from "@/hooks/use-popover-dismiss";
import type { Bot } from "@/state/store";
import { BotAvatar } from "../Avatar";
import type { BrowserNav, BrowserTab } from "../browser/ChromeRow";
import { confirmCancelCls, mdPrimaryCls } from "../ui/GrokDialog";

export interface StripTab extends BrowserTab {
  /** The person holds this tab: the bot waits on it and keeps working in the others. */
  held?: boolean;
}

/** The frame around the browser: the tabs and the toolbar sit in it, the page is cut from the composer's surface. */
export const FRAME_TONE = "bg-[color-mix(in_srgb,var(--color-composer),var(--color-ink)_6%)]";
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus";
const ICON_BUTTON = cn("flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-[10px] text-ink-secondary transition-[background-color,color] duration-[120ms] ease-[ease]",
  "enabled:hover:bg-ink/6 enabled:hover:text-ink disabled:cursor-default disabled:opacity-40", FOCUS);
const SLIDE = "cubic-bezier(0.2, 0, 0, 1)";

/** Every tab is as wide as the next, so the shown tab's highlight only slides. */
export const TAB_WIDTH = { narrow: 84, wide: 160 } as const;
export const TAB_GAP = 2;

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function tabName(tab: { title: string; url: string }): string {
  return blankPage(tab.url) ? t("browser.panel.newTab") : pageTitle(tab.title, tab.url) || siteOf(tab.url) || t("browser.panel.newTab");
}

export function SiteMark({ title, url }: { title: string; url: string }) {
  const icon = siteIconUrl(siteOf(url));
  const [loaded, setLoaded] = useState<string | null>(null);
  const shown = icon !== null && loaded === icon;
  if (blankPage(url)) return <Globe size={16} aria-hidden="true" className="shrink-0 text-ink/40" />;
  return (
    <span aria-hidden="true" className={cn("relative flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-[4px] text-[10px] font-medium leading-none text-ink-secondary", !shown && "bg-ink/[0.08]")}>
      {!shown && tabLetter(title, url)}
      {icon && <img src={icon} alt="" draggable={false} onLoad={(event) => { if (event.currentTarget.naturalWidth > 1) setLoaded(icon); }}
        className={cn("absolute inset-0 size-full object-contain", !shown && "invisible")} />}
    </span>
  );
}

/** Tabs that moved slide from where they were; a tab that just opened grows in. Transform and opacity only. */
function useTabMotion(box: RefObject<HTMLDivElement | null>, order: string) {
  const lefts = useRef<Map<string, number> | null>(null);
  useLayoutEffect(() => {
    const strip = box.current;
    if (!strip) return;
    const items = [...strip.querySelectorAll<HTMLElement>("[data-local-browser-tab-item]")];
    const before = lefts.current;
    const now = new Map(items.map((item) => [item.dataset.localBrowserTabItem!, item.offsetLeft]));
    lefts.current = now;
    if (!before || reduced() || typeof Element.prototype.animate !== "function") return;
    for (const item of items) {
      const id = item.dataset.localBrowserTabItem!;
      const was = before.get(id);
      if (was === undefined) item.animate([{ opacity: 0, transform: "scale(0.94)" }, { opacity: 1, transform: "none" }], { duration: 200, easing: "ease-out" });
      else if (was !== now.get(id)) item.animate([{ transform: `translateX(${was - now.get(id)!}px)` }, { transform: "none" }], { duration: 220, easing: SLIDE });
    }
  }, [box, order]);
}

/**
 * The bot's tabs, each its site's icon and a short title, the shown one raised in the panel's tone. The strip scrolls
 * sideways (a wheel's up and down scrolls it too), fades at an edge with more beyond, and keeps the shown tab in view.
 */
export function TabStrip({ bot, tabs, selected, wide, ready, onSelect, onClose, onNew }: {
  bot: Pick<Bot, "name">; tabs: readonly StripTab[]; selected: string | null; wide: boolean; ready: boolean;
  onSelect: (tab: StripTab) => void; onClose: (tab: StripTab) => void; onNew: () => void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const width = wide ? TAB_WIDTH.wide : TAB_WIDTH.narrow;
  const index = tabs.findIndex((tab) => tab.tabId === selected);
  useTabMotion(box, `${tabs.map((tab) => tab.tabId).join("\n")}:${width}`);

  useEffect(() => {
    const strip = box.current;
    if (!strip) return;
    const edges = () => {
      strip.toggleAttribute("data-more-start", strip.scrollLeft > 1);
      strip.toggleAttribute("data-more-end", strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1);
    };
    edges();
    strip.addEventListener("scroll", edges, { passive: true });
    const watch = new ResizeObserver(edges);
    watch.observe(strip);
    return () => { strip.removeEventListener("scroll", edges); watch.disconnect(); };
  }, [tabs.length, width]);

  // only the strip scrolls, never the panel around it
  useEffect(() => {
    const strip = box.current;
    const tab = index < 0 ? null : strip?.querySelector<HTMLElement>(`[data-local-browser-tab-item="${CSS.escape(selected ?? "")}"]`);
    if (!strip || !tab) return;
    const left = tab.offsetLeft - 20, right = tab.offsetLeft + tab.offsetWidth + 20;
    const target = left < strip.scrollLeft ? left : right > strip.scrollLeft + strip.clientWidth ? right - strip.clientWidth : null;
    if (target !== null) strip.scrollTo({ left: Math.max(0, target), behavior: reduced() ? "auto" : "smooth" });
  }, [index, selected, tabs.length, width]);

  return (
    <div ref={box} role="tablist" aria-label={t("localBrowser.tabs", { name: bot.name })} data-local-browser-strip=""
      onWheel={(event) => { if (event.deltaY && !event.deltaX && box.current) box.current.scrollLeft += event.deltaY; }}
      className="browser-strip relative flex h-10 shrink-0 items-center overflow-x-auto overflow-y-hidden p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{ gap: TAB_GAP }}>
      {index >= 0 && (
        <span aria-hidden="true" data-local-browser-highlight=""
          className="pointer-events-none absolute left-1 top-1 h-8 rounded-[10px] bg-composer transition-transform duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none"
          style={{ width, transform: `translateX(${index * (width + TAB_GAP)}px)` }} />
      )}
      {tabs.map((tab) => {
        const chosen = tab.tabId === selected;
        const name = tabName(tab);
        return (
          <div key={tab.tabId} role="presentation" data-local-browser-tab-item={tab.tabId} className="group/tab relative shrink-0" style={{ width }}>
            <button type="button" role="tab" aria-selected={chosen} data-local-browser-tab={tab.tabId} title={tab.held ? `${name}, ${t("localBrowser.heldHere")}` : name}
              disabled={!ready} onClick={() => { if (!chosen) onSelect(tab); }}
              className={cn("flex h-8 w-full cursor-pointer items-center gap-1.5 rounded-[10px] px-2 text-left text-[13px] leading-[18px] disabled:cursor-default",
                "transition-[background-color,color] duration-[120ms] ease-[ease] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus",
                chosen ? "text-ink" : "text-ink-secondary [@media(hover:hover)]:hover:bg-ink/[0.05] [@media(hover:hover)]:hover:text-ink")}>
              <span className="relative flex shrink-0">
                <SiteMark title={tab.title} url={tab.url} />
                {tab.held && (
                  <span role="img" data-local-browser-held="" aria-label={t("localBrowser.heldHere")}
                    className="absolute -bottom-1 -right-1 flex size-3 items-center justify-center rounded-full bg-accent text-accent-ink ring-2 ring-[color-mix(in_srgb,var(--color-composer),var(--color-ink)_6%)]">
                    <Hand size={8} aria-hidden="true" />
                  </span>
                )}
              </span>
              <span dir="auto" className="min-w-0 flex-1 truncate group-hover/tab:pe-4 group-focus-within/tab:pe-4">{name}</span>
            </button>
            <button type="button" data-local-browser-tab-close={tab.tabId} aria-label={t("browser.panel.closeTab", { title: name })} title={t("browser.panel.closeTab", { title: name })}
              disabled={!ready} onClick={() => onClose(tab)}
              className={cn("absolute right-1 top-1/2 flex size-[18px] -translate-y-1/2 cursor-pointer items-center justify-center rounded-[6px] text-ink-secondary opacity-0 transition-opacity duration-[120ms] ease-[ease]",
                "hover:bg-ink/8 hover:text-ink focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-focus group-hover/tab:opacity-100 group-focus-within/tab:opacity-100 touch:opacity-100 disabled:hidden")}>
              <X size={11} aria-hidden="true" />
            </button>
          </div>
        );
      })}
      <button type="button" data-local-browser-action="new-tab" aria-label={t("browser.panel.newTab")} title={t("browser.panel.newTab")} disabled={!ready} onClick={onNew} className={ICON_BUTTON}>
        <Plus size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

/** An address as it reads at rest: no scheme, no lone trailing slash. */
export function addressText(url: string): string {
  if (blankPage(url)) return "";
  return url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
}

/** Back, forward, reload and the address of the shown tab; Enter goes to what was typed. */
export const BrowserToolbar = forwardRef<HTMLInputElement, {
  nav: BrowserNav; ready: boolean; onHistory: (delta: -1 | 1) => void; onReload: () => void; onAddress: (text: string) => void;
}>(function BrowserToolbar({ nav, ready, onHistory, onReload, onAddress }, ref) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const secure = nav.url.startsWith("https://");
  return (
    <form data-local-browser-toolbar="" className="flex h-10 shrink-0 items-center gap-0.5 p-1" onSubmit={(event) => {
      event.preventDefault();
      onAddress(draft);
      (event.currentTarget.querySelector("input") as HTMLInputElement | null)?.blur();
    }}>
      <button type="button" data-local-browser-action="back" className={ICON_BUTTON} disabled={!ready || !nav.canGoBack} aria-label={t("browser.panel.back")} title={t("browser.panel.back")} onClick={() => onHistory(-1)}><ArrowLeft size={16} aria-hidden="true" /></button>
      <button type="button" data-local-browser-action="forward" className={ICON_BUTTON} disabled={!ready || !nav.canGoForward} aria-label={t("browser.panel.forward")} title={t("browser.panel.forward")} onClick={() => onHistory(1)}><ArrowRight size={16} aria-hidden="true" /></button>
      <button type="button" data-local-browser-action="reload" className={ICON_BUTTON} disabled={!ready} aria-label={nav.loading ? t("browser.panel.loadingReload") : t("browser.panel.reload")} title={t("screenLoad.reload")} onClick={onReload}>
        {nav.loading ? <Loader2 size={16} aria-hidden="true" className="motion-safe:animate-spin" /> : <RotateCw size={16} aria-hidden="true" />}
      </button>
      <label className="ms-0.5 flex h-8 min-w-0 flex-1 cursor-text items-center gap-1.5 rounded-[10px] bg-composer px-2.5">
        {secure && !editing && <Lock size={12} aria-hidden="true" className="shrink-0 text-ink/40" />}
        <input ref={ref} data-local-browser-address="" aria-label={t("browser.panel.address")} readOnly={!ready} spellCheck={false} autoComplete="off"
          value={editing ? draft : addressText(nav.url)}
          placeholder={t("browser.panel.searchAddress")}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => { setDraft(blankPage(nav.url) ? "" : nav.url); setEditing(true); const field = event.target; queueMicrotask(() => field.select()); }}
          onBlur={() => setEditing(false)}
          onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.currentTarget.blur(); } }}
          className="h-full min-w-0 flex-1 text-ellipsis bg-transparent text-[13px] leading-[18px] text-ink outline-none placeholder:text-ink/40" />
      </label>
    </form>
  );
});

/** The line above the browser: who is using it, the expand toggle and the close, which asks first. */
export function BrowserHeader({ bot, headline, wide, closing, failed, ready = true, onExpand, onClose, onKeyboard }: {
  bot: Bot; headline: "browsing" | "open"; wide: boolean; closing: boolean; failed: boolean; ready?: boolean;
  onExpand: () => void; onClose: () => void; onKeyboard?: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const cancel = useRef<HTMLButtonElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const title = useId();
  useEffect(() => {
    if (!asking) return;
    cancel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (!popoverClosesOnKey(event)) return;
      // the confirm closes first; the wide panel's Escape waits for the next press
      event.preventDefault();
      event.stopImmediatePropagation();
      setAsking(false);
      trigger.current?.focus();
    };
    const onDown = (event: PointerEvent) => { if (popoverClosesOnPointer(event.target, root.current)) setAsking(false); };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown);
    return () => { window.removeEventListener("keydown", onKey, true); window.removeEventListener("pointerdown", onDown); };
  }, [asking]);
  const askClose = () => {
    const dialogs = systemDialogs();
    if (dialogs) {
      void dialogs.alert({
        title: t("localBrowser.closeAsk"),
        message: t("localBrowser.closeBody", { name: bot.name }),
        confirmLabel: t("localBrowser.closeConfirm"),
        cancelLabel: t("localBrowser.cancel"),
      }).then((outcome) => { if (outcome === "confirm") onClose(); });
      return;
    }
    setAsking((on) => !on);
  };
  const words = headline === "browsing" ? t("localBrowser.browsing", { name: bot.name }) : t("localBrowser.open");
  return (
    <div data-local-browser-header={headline} className="flex h-8 items-center gap-1">
      <span className="flex min-w-0 flex-1 items-center gap-2 ps-1">
        <span className="flex shrink-0"><BotAvatar bot={bot} size={16} animated={false} trackPointer={false} /></span>
        <span data-local-browser-status="" aria-live="polite" className="min-w-0 truncate text-[13px] leading-[18px] text-ink-secondary">{words}</span>
      </span>
      {onKeyboard && (
        <button type="button" data-local-browser-action="keyboard" aria-label={t("desktopViewer.keyboard")} title={t("desktopViewer.keyboard")}
          disabled={!ready} onClick={onKeyboard} className={ICON_BUTTON}>
          <Keyboard size={16} aria-hidden="true" />
        </button>
      )}
      <button type="button" data-local-browser-action="expand" aria-pressed={wide} aria-label={t(wide ? "localBrowser.narrow" : "localBrowser.expand")} title={t(wide ? "localBrowser.narrow" : "localBrowser.expand")}
        onClick={onExpand} className={cn(ICON_BUTTON, "max-md:hidden")}>
        {wide ? <Shrink size={16} aria-hidden="true" /> : <Maximize size={16} aria-hidden="true" />}
      </button>
      <div ref={root} className="relative">
        <button ref={trigger} type="button" data-local-browser-action="close" aria-haspopup="dialog" aria-expanded={asking} aria-label={t("localBrowser.close")} title={t("localBrowser.close")}
          disabled={closing} onClick={askClose} className={ICON_BUTTON}>
          {closing ? <Loader2 size={16} aria-hidden="true" className="motion-safe:animate-spin" /> : <X size={16} aria-hidden="true" />}
        </button>
        {asking && (
          <div role="alertdialog" aria-labelledby={title} data-local-browser-confirm=""
            className="absolute right-0 top-full z-30 mt-1 w-[248px] origin-top-right rounded-[14px] bg-menu p-3 text-ink shadow-[var(--shadow-popover)] transition-[opacity,transform] duration-150 ease-out starting:scale-[0.97] starting:opacity-0 motion-reduce:starting:scale-100">
            <p id={title} className="m-0 text-[13px] leading-[18px]">
              <span className="font-medium">{t("localBrowser.closeAsk")}</span>{" "}
              <span className="text-ink-secondary">{t("localBrowser.closeBody", { name: bot.name })}</span>
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <button ref={cancel} type="button" data-local-browser-action="close-cancel" className={confirmCancelCls} onClick={() => { setAsking(false); trigger.current?.focus(); }}>{t("localBrowser.cancel")}</button>
              <button type="button" data-local-browser-action="close-confirm" className={mdPrimaryCls} onClick={() => { setAsking(false); onClose(); }}>{t("localBrowser.closeConfirm")}</button>
            </div>
          </div>
        )}
      </div>
      {failed && <p role="alert" className="sr-only">{t("localBrowser.closeFailed")}</p>}
    </div>
  );
}

/** The gray pill a closed browser leaves: the sidebar spot's size and type, in the browser frame's own tone. */
export const StartPill = forwardRef<HTMLButtonElement, { onStart: () => void; disabled?: boolean }>(function StartPill({ onStart, disabled }, ref) {
  return (
    <button ref={ref} type="button" data-local-browser-action="start" disabled={disabled} onClick={onStart}
      className={cn("flex h-10 w-fit cursor-pointer items-center gap-2.5 rounded-full ps-3.5 pe-4 text-start text-ink", FRAME_TONE,
        "transition-[background-color,transform] duration-150 ease-[ease] hover:bg-[color-mix(in_srgb,var(--color-composer),var(--color-ink)_10%)] active:scale-[0.98] motion-reduce:active:scale-100",
        "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-progress")}>
      <Globe size={20} aria-hidden="true" className="shrink-0 text-ink-secondary" />
      <span className="truncate text-[14px] font-medium leading-5">{t("localBrowser.start")}</span>
    </button>
  );
});
