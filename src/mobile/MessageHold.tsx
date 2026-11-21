import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Copy, ExternalLink, Scan, Share } from "../icons";
import { copyText } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { phoneBridge } from "@/lib/phone-bridge";
import { inAppLink } from "./viewers/ViewerHost";
import { ContextMenu, holdSink, type ContextAction, type ContextReaction } from "./ContextMenu";
import { haptic } from "./haptics";
import { useNativeHold, type HeldMenu, type NativeHold } from "./native-menu";
import { usePlatform } from "./platform";

const HOLD_MS = 400;
const MOVE_CANCEL = 8;
const BUBBLE = "[data-mobile-chat] [data-message-row] [data-chat-bubble]";

type Held = { bubble: HTMLElement; rect: DOMRect; radius: string; end: boolean; actions: ContextAction[]; reactions: ContextReaction[] };

/** React commits a click's state on a microtask; a few turns are enough, a frame at most. */
async function settle<T>(read: () => T | null): Promise<T | null> {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
    const value = read();
    if (value) return value;
  }
  await new Promise((resolve) => requestAnimationFrame(resolve));
  return read();
}

const iconOf = (button: Element): Node | null => button.querySelector("svg")?.cloneNode(true) ?? null;

function Icon({ node }: { node: Node | null }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !node) return;
    el.replaceChildren(node.cloneNode(true));
  }, [node]);
  return <span ref={ref} className="flex size-[18px] items-center justify-center [&>svg]:size-[18px]" />;
}

/** What a message offers, read from its own action bar (reply, the "..." menu, the reaction picker) so the phone's
 * menu always matches it; choosing one presses that same control. The bar is hidden while it is read, so nothing
 * flashes behind the menu. */
export async function readMessageActions(row: HTMLElement): Promise<{ actions: ContextAction[]; reactions: ContextReaction[] }> {
  const bar = row.querySelector<HTMLElement>("[data-testid='message-actions']");
  if (!bar) return { actions: [], reactions: [] };
  const hide = <R,>(run: () => Promise<R>) => async () => {
    const active = document.activeElement;
    bar.style.visibility = "hidden";
    try {
      return await run();
    } finally {
      if (document.activeElement instanceof HTMLElement && bar.contains(document.activeElement) && document.activeElement !== active) {
        document.activeElement.blur();
      }
      bar.style.visibility = "";
    }
  };
  const buttons = [...bar.querySelectorAll<HTMLButtonElement>(":scope > button, :scope > div > button")];
  const react = buttons.find((button) => button.getAttribute("aria-label") === t("chat.react"));
  const more = buttons.find((button) => button.getAttribute("aria-label") === t("chat.messageActions"));
  const actions: ContextAction[] = [];
  const reactions: ContextReaction[] = [];
  for (const button of buttons) {
    if (button === react || button === more) continue;
    const label = button.getAttribute("aria-label");
    if (!label) continue;
    const icon = iconOf(button);
    actions.push({ key: `bar:${label}`, label, icon: <Icon node={icon} />, onSelect: () => button.click() });
  }
  await hide(async () => {
    if (more) {
      more.click();
      const items = await settle(() => { const found = [...bar.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]; return found.length ? found : null; });
      for (const [index, item] of (items ?? []).entries()) {
        const label = item.textContent?.trim() ?? "";
        if (!label) continue;
        const icon = iconOf(item);
        actions.push({
          key: `menu:${index}:${label}`,
          label,
          disabled: item.disabled,
          icon: <Icon node={icon} />,
          onSelect: () => void hide(async () => {
            more.click();
            const again = await settle(() => [...bar.querySelectorAll<HTMLButtonElement>("[role='menuitem']")].find((one) => one.textContent?.trim() === label) ?? null);
            again?.click();
          })(),
        });
      }
      if (items) more.click();
    }
    if (react) {
      react.click();
      const choices = await settle(() => { const found = [...bar.querySelectorAll<HTMLButtonElement>("[role='toolbar'] button")]; return found.length ? found : null; });
      for (const choice of choices ?? []) {
        const label = choice.getAttribute("aria-label") ?? "";
        reactions.push({ key: label, label, glyph: choice.textContent?.trim() ?? "", selected: choice.getAttribute("aria-pressed") === "true" });
      }
      if (choices) react.click();
    }
    await settle(() => true);
  })();
  const copy = actions.findIndex((action) => action.label === t("chat.copyMessage")) + 1;
  actions.splice(copy || actions.length, 0, ...textActions(row));
  return { actions, reactions };
}

/** What a message's words read as, without the marks drawn beside them (a link's site icon, a code block's keys). */
export function messageText(bubble: HTMLElement): string {
  const copy = bubble.cloneNode(true) as HTMLElement;
  for (const el of copy.querySelectorAll("[data-copy-skip], [data-code-plate], [data-code-label], .sr-only, [aria-hidden='true'], button")) el.remove();
  return (copy.innerText || copy.textContent || "").trim();
}

/** The phone's own way into a message's words: select them in a sheet, or hand them to another app. */
function textActions(row: HTMLElement): ContextAction[] {
  const bubble = row.querySelector<HTMLElement>("[data-chat-bubble]");
  const phone = phoneBridge();
  const text = bubble ? messageText(bubble) : "";
  if (!phone || !text) return [];
  const actions: ContextAction[] = [{ key: "phone:select", label: t("mobile.select.title"), icon: <Scan size={18} />, onSelect: () => phone.view({ kind: "text", text }) }];
  if (phone.share) actions.push({ key: "phone:share", label: t("mobile.message.share"), icon: <Share size={18} />, onSelect: () => void phone.share!({ text }).catch(() => {}) });
  return actions;
}

/** A link held in a message: open it, copy its address or share it, as a held link does in Safari. */
export function linkActions(url: string): ContextAction[] {
  const phone = phoneBridge();
  const actions: ContextAction[] = [
    { key: "link:open", label: t("mobile.link.open"), icon: <ExternalLink size={18} />, onSelect: () => phone?.openLink(url) },
    { key: "link:copy", label: t("mobile.link.copy"), icon: <Copy size={18} />, onSelect: () => void copyText(url) },
  ];
  if (phone?.share) actions.push({ key: "link:share", label: t("mobile.link.share"), icon: <Share size={18} />, onSelect: () => void phone.share!({ url }).catch(() => {}) });
  return actions;
}

export function pickReaction(row: HTMLElement, label: string): void {
  const bar = row.querySelector<HTMLElement>("[data-testid='message-actions']");
  const react = bar && [...bar.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label") === t("chat.react"));
  if (!bar || !react) return;
  bar.style.visibility = "hidden";
  react.click();
  void settle(() => [...bar.querySelectorAll<HTMLButtonElement>("[role='toolbar'] button")].find((one) => one.getAttribute("aria-label") === label) ?? null)
    .then((choice) => { choice?.click(); })
    .finally(() => { bar.style.visibility = ""; });
}

/** SF Symbols for a message's actions, by the label it shows. */
function symbolFor(label: string): string | undefined {
  const symbols: Record<string, string> = {
    [t("chat.replyToMessage")]: "arrowshape.turn.up.left",
    [t("chat.copyMessage")]: "doc.on.doc",
    [t("chat.speak.read")]: "speaker.wave.2",
    [t("chat.speak.stop")]: "stop.circle",
    [t("chat.regenerate")]: "arrow.clockwise",
    [t("chat.pinMessage")]: "pin",
    [t("chat.unpinMessage")]: "pin.slash",
    [t("chat.editMessage")]: "pencil",
    [t("chat.reportReply")]: "exclamationmark.bubble",
    [t("mobile.select.title")]: "selection.pin.in.out",
    [t("mobile.message.share")]: "square.and.arrow.up",
    [t("mobile.link.open")]: "safari",
    [t("mobile.link.copy")]: "link",
    [t("mobile.link.share")]: "square.and.arrow.up",
  };
  return symbols[label];
}

/** A message's actions and reactions for the system menu: the same ones its own bar offers, each pressing that control. */
export async function nativeMessageMenu(row: HTMLElement, link?: string | null): Promise<HeldMenu | null> {
  const { actions, reactions } = link ? { actions: linkActions(link), reactions: [] } : await readMessageActions(row);
  if (!actions.length && !reactions.length) return null;
  return {
    content: {
      items: actions.map((action) => ({ key: action.key, title: action.label, icon: symbolFor(action.label), disabled: action.disabled })),
      reactions: reactions.map((reaction) => ({ key: reaction.key, title: reaction.label, glyph: typeof reaction.glyph === "string" ? reaction.glyph : "", selected: reaction.selected })).filter((reaction) => reaction.glyph),
    },
    select: (key) => actions.find((action) => action.key === key)?.onSelect(),
    react: (key) => pickReaction(row, key),
  };
}

/** Reading a message's menu opens its own small menus out of sight, so it waits until the finger has held still a beat,
 * short enough to finish before UIKit asks for the menu configuration. */
const NATIVE_PREFETCH_MS = 80;

/** The held message under a touch, or null when the touch belongs to something else in it (a button, a field). */
export function heldBubble(target: EventTarget | null): { bubble: HTMLElement; row: HTMLElement } | null {
  const el = target instanceof Element ? target : null;
  const bubble = el?.closest<HTMLElement>(BUBBLE);
  if (!bubble || el?.closest("button, input, textarea, [contenteditable='true'], [aria-hidden='true'], [data-selectable]")) return null;
  const row = bubble.closest<HTMLElement>("[data-message-row]");
  if (!row?.querySelector("[data-testid='message-actions']")) return null;
  return { bubble, row };
}

/** iOS 26: the system's context menu lifts the message and shows its actions; the page only says what is under the finger. */
function useNativeMessageHold(rootRef: RefObject<HTMLElement | null>, hold: NativeHold | undefined) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !hold) return;
    const html = document.documentElement;
    html.dataset.nativeMenu = "";
    let start: { x: number; y: number } | null = null;
    const onTouchStart = (event: TouchEvent) => {
      start = null;
      if (event.touches.length !== 1) { hold.cancel(); return; }
      const held = heldBubble(event.target);
      if (!held) { hold.cancel(); return; }
      start = { x: event.touches[0].clientX, y: event.touches[0].clientY };
      const link = inAppLink(event.target);
      hold.press(held.bubble, () => nativeMessageMenu(held.row, link), {
        prefetchMs: NATIVE_PREFETCH_MS,
        point: start,
        // the bar's own long press would also bring up its pill
        onOpen: () => held.row.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerType: "touch" })),
      });
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!start) return;
      const touch = event.touches[0];
      if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > MOVE_CANCEL) { start = null; hold.cancel(); }
    };
    const onTouchEnd = () => {
      start = null;
      hold.cancel();
    };
    root.addEventListener("touchstart", onTouchStart, { passive: true });
    root.addEventListener("touchmove", onTouchMove, { passive: true });
    root.addEventListener("touchend", onTouchEnd, { passive: true });
    root.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      delete html.dataset.nativeMenu;
      root.removeEventListener("touchstart", onTouchStart);
      root.removeEventListener("touchmove", onTouchMove);
      root.removeEventListener("touchend", onTouchEnd);
      root.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [rootRef, hold]);
}

function Preview({ bubble, width }: { bubble: HTMLElement; width: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    const copy = bubble.cloneNode(true) as HTMLElement;
    copy.removeAttribute("id");
    for (const el of copy.querySelectorAll("[id]")) el.removeAttribute("id");
    copy.style.width = `${width}px`;
    copy.style.maxWidth = "none";
    copy.style.margin = "0";
    copy.style.visibility = "visible";
    host.replaceChildren(copy);
  }, [bubble, width]);
  return <div ref={ref} data-mobile-chat="" className="pointer-events-none" style={{ padding: 0 }} />;
}

/** Press and hold a message: it sinks under the finger, then lifts out of the blurred chat with its reactions over it
 * and its actions under it, as iMessage does. */
export function MessageHold({ rootRef }: { rootRef: RefObject<HTMLElement | null> }) {
  const [held, setHeld] = useState<Held | null>(null);
  const [open, setOpen] = useState(false);
  const native = useNativeHold(usePlatform().menu, "message");
  useNativeMessageHold(rootRef, native);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || native) return;
    let timer = 0;
    let start: { x: number; y: number } | null = null;
    let fired = false;
    let sink: ((on: boolean | null) => void) | null = null;
    const cancel = () => { window.clearTimeout(timer); timer = 0; start = null; sink?.(false); sink = null; };
    const onTouchStart = (event: TouchEvent) => {
      fired = false;
      if (event.touches.length !== 1) { cancel(); return; }
      const found = heldBubble(event.target);
      if (!found) return;
      const { bubble, row } = found;
      const link = inAppLink(event.target);
      start = { x: event.touches[0].clientX, y: event.touches[0].clientY };
      sink = holdSink(bubble);
      sink(true);
      timer = window.setTimeout(async () => {
        timer = 0;
        fired = true;
        sink?.(null);
        sink = null;
        // the bar's own long press would also bring up its pill
        row.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerType: "touch" }));
        haptic("hold");
        const rect = bubble.getBoundingClientRect();
        const { actions, reactions } = link ? { actions: linkActions(link), reactions: [] } : await readMessageActions(row);
        if (!actions.length && !reactions.length) return;
        setHeld({ bubble, rect, radius: getComputedStyle(bubble).borderRadius, end: row.classList.contains("items-end"), actions, reactions });
        setOpen(true);
      }, HOLD_MS);
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!start || !timer) return;
      const touch = event.touches[0];
      if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > MOVE_CANCEL) cancel();
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (fired && event.cancelable) event.preventDefault();
      cancel();
    };
    root.addEventListener("touchstart", onTouchStart, { passive: true });
    root.addEventListener("touchmove", onTouchMove, { passive: true });
    root.addEventListener("touchend", onTouchEnd);
    root.addEventListener("touchcancel", cancel);
    return () => {
      cancel();
      root.removeEventListener("touchstart", onTouchStart);
      root.removeEventListener("touchmove", onTouchMove);
      root.removeEventListener("touchend", onTouchEnd);
      root.removeEventListener("touchcancel", cancel);
    };
  }, [rootRef, native]);

  const close = useCallback(() => setOpen(false), []);
  const row = held?.bubble.closest<HTMLElement>("[data-message-row]") ?? null;
  return (
    <ContextMenu
      open={open && Boolean(held)}
      anchor={held?.rect ?? null}
      label={t("chat.messageActions")}
      preview={held ? <Preview bubble={held.bubble} width={held.rect.width} /> : null}
      radius={held?.radius}
      actions={held?.actions ?? []}
      reactions={held?.reactions.length ? held.reactions : undefined}
      onReact={(label) => { if (row) pickReaction(row, label); }}
      end={held?.end}
      source={held?.bubble}
      onClose={close}
    />
  );
}
