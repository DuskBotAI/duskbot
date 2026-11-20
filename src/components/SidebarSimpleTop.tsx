import { Search, X } from "../icons";
import type { Ref } from "react";

import { t } from "@/lib/i18n";
import { Icon } from "./Icon";

/** Keyboard focus: the neutral 2px focus ring, 1px off a control's edge, drawn inside a row's. The mouse leaves none. */
// the offsets are important: the global :focus-visible rule in styles.css is unlayered and outranks plain utilities
export const GROK_FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1! focus-visible:outline-focus";

/** Keyboard focus on a Simple row or tile: the focus ring drawn inside its edge. */
export const SIMPLE_ROW_FOCUS = "focus-visible:outline-2 focus-visible:-outline-offset-2! focus-visible:outline-focus";

const SIMPLE_TOP = "flex size-10 shrink-0 items-center justify-center rounded-full border border-ink/[0.08] bg-composer text-ink/[0.92] transition-[background-color,color] duration-[120ms] ease-out";
/** grok lays its hover over the fill as a 6% ink image, at once, with no fade */
export const GROK_HOVER_TINT = "hover:bg-[linear-gradient(rgba(28,28,28,0.035),rgba(28,28,28,0.035))]";
const SIMPLE_TOP_TINT = GROK_HOVER_TINT;
const SIMPLE_TOP_FOCUS = GROK_FOCUS;
export const SIMPLE_TOP_BUTTON = `${SIMPLE_TOP} ${SIMPLE_TOP_TINT} aria-expanded:bg-[linear-gradient(rgba(28,28,28,0.06),rgba(28,28,28,0.06))] ${SIMPLE_TOP_FOCUS}`;
/** The same round control for the button of the window's rail, which is shown most of the time: its aria-expanded never
 * wears the tint of an open menu. */
export const SIMPLE_TOP_TOGGLE = `${SIMPLE_TOP} ${SIMPLE_TOP_TINT} ${SIMPLE_TOP_FOCUS}`;

/** Search and New in the top corner of Simple's sidebar in a framed window: plain icons, each its own button. */
export const SIMPLE_CORNER_BUTTON = `flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink aria-expanded:bg-ink/[0.06] aria-expanded:text-ink ${SIMPLE_TOP_FOCUS}`;

/** The round control at either end of the phone bot list's top row. */
export const PHONE_TOP_BUTTON = "flex size-10 shrink-0 items-center justify-center rounded-full border border-hairline bg-card text-ink hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

export const SIMPLE_RAIL_BUTTON = "flex size-9 shrink-0 items-center justify-center rounded-xl text-ink-secondary hover:bg-raised/60 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

export function SidebarSearchToggle({ open, onToggle, corner = false, ref }: { open: boolean; onToggle: () => void; corner?: boolean; ref?: Ref<HTMLButtonElement> }) {
  return (
    <button
      ref={ref}
      type="button"
      data-sidebar-search-toggle
      onClick={onToggle}
      aria-label={t("sidebar.grok.search")}
      aria-expanded={corner ? open : undefined}
      title={t("sidebar.grok.search")}
      className={corner ? SIMPLE_CORNER_BUTTON : SIMPLE_TOP_BUTTON}
    >
      {corner ? <Search size={17} strokeWidth={1.5} aria-hidden="true" /> : <Icon name="search" size={16} />}
    </button>
  );
}

export function SidebarSearchPill({ query, onQuery, onClose }: { query: string; onQuery: (query: string) => void; onClose: () => void }) {
  return (
    <div data-sidebar-search-pill className="px-3 pb-2 pt-0.5">
      <div className="flex h-[34px] items-center gap-2 rounded-full border border-ink/10 bg-transparent pl-3 pr-1.5 text-ink-secondary ">
        <Search size={15} aria-hidden="true" className="shrink-0" />
        <input
          autoFocus
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            onClose();
          }}
          placeholder={t("sidebar.searchAria")}
          aria-label={t("sidebar.searchAria")}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-ink placeholder:text-ink-tertiary focus:outline-none"
        />
        <button
          type="button"
          onClick={onClose}
          aria-label={t("sidebar.searchClose")}
          title={t("sidebar.searchClose")}
          className="flex size-6 shrink-0 items-center justify-center rounded-full text-ink-tertiary hover:bg-raised hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
