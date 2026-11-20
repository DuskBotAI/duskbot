import { useEffect, useRef } from "react";
import { motion, useIsPresent } from "motion/react";
import { MotionDiv, useMotionReduced } from "./ui/SheetMotion";
import { overlaySlide } from "./bot-panel/overlay-slide";

import { useStore, type Bot } from "@/state/store";
import { useBotSettingsDerived } from "./bot-settings/useBotSettingsDerived";
import { BotPanel } from "./bot-panel/PanelShell";
import { BOT_PANEL_ID, sidePanelCls } from "./bot-panel/side-panel";
import { escapeIsUnclaimed } from "@/lib/composer-focus";
import { phoneApp } from "@/lib/store-app";

/** What the panel that just unmounted would have handed focus back to, taken by the next bot's panel when it mounts. */
let focusHandoff: HTMLElement | null = null;

export function BotSettingsDialog({ bot, overlay = false, slideIn = true }: {
  bot: Bot;
  overlay?: boolean;
  /** as an overlay, it slides in; false when it takes over from another bot's overlay already open */
  slideIn?: boolean;
}) {
  const { state, dispatch } = useStore();
  const section = state.botSettingsSection;
  const derived = useBotSettingsDerived(bot);
  const dialogRef = useRef<HTMLElement | null>(null);
  const collapsed = !state.botSettingsExpandAccordion;
  const linkedSection = !collapsed && !state.botSettingsExpandRemembered ? section : null;

  useEffect(() => {
    if (collapsed) return;
    dialogRef.current?.querySelector(`[data-bot-settings-section="${section}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [collapsed, section]);

  useEffect(() => {
    const inherited = focusHandoff;
    focusHandoff = null;
    const previousFocus = inherited ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const dialog = dialogRef.current;
    // opened, it takes focus; swapped for the next bot's panel as chats change, focus stays with the chat box
    if (!inherited) dialog?.focus();

    const onKey = (event: KeyboardEvent) => {
      const nested = dialog?.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');
      if (nested && nested.getClientRects().length > 0) return;
      // focus outside the panel: a dialog portalled to document.body, a field or a menu keeps the key; an Escape on the
      // conversation or a plain button still closes the panel
      if (dialog && event.target instanceof Node && !dialog.contains(event.target)) {
        const page = event.target === document.body || event.target === document.documentElement;
        if (event.key !== "Escape" || !escapeIsUnclaimed(event.target as Element, page)) return;
      }
      // A popover or field inside that already handled this Escape keeps the panel open.
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        dispatch({ type: "toggleSettings", open: false });
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      // swapped for the next bot's panel, it hands its return target on; a close returns focus only if it left with the
      // panel, since refocusing a row the person clicked away from scrolls the sidebar back to it
      focusHandoff = previousFocus;
      queueMicrotask(() => {
        if (focusHandoff !== previousFocus) return;
        focusHandoff = null;
        const active = document.activeElement;
        if (!active || active === document.body || dialog?.contains(active)) previousFocus?.focus();
      });
    };
  }, [dispatch]);

  const reduced = useMotionReduced();
  const leaving = !useIsPresent();
  const Scrim = overlay ? MotionDiv : "div";
  const Aside = overlay ? motion.aside : "aside";
  const sliding = overlay ? overlaySlide(reduced, slideIn) : null;

  return (
    <>
    {/* too narrow to dock, the panel lies over the chat: the chat dims behind it, as under any sheet, and a click there
        closes it, so its cut-off rows read as covered rather than clipped */}
    {overlay && <Scrim {...sliding?.scrim} aria-hidden="true" data-panel-scrim="" data-raw-dialog="" className="ui-scrim-light ui-dialog-scrim-panel absolute inset-0 z-40 hidden md:block" onMouseDown={() => !leaving && dispatch({ type: "toggleSettings", open: false })} />}
    <Aside
      {...sliding?.panel}
      inert={leaving || undefined}
      ref={dialogRef}
      id={BOT_PANEL_ID}
      role={phoneApp() ? undefined : "dialog"}
      aria-labelledby={phoneApp() ? undefined : "bot-settings-title"}
      tabIndex={-1}
      className={sidePanelCls(overlay)}
    >
      <BotPanel
        bot={bot}
        derived={derived}
        linkedSection={linkedSection}
        computerRequest={state.computerTabRequest}
        onClose={() => dispatch({ type: "toggleSettings", open: false })}
      />
    </Aside>
    </>
  );
}
