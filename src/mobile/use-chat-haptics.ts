import { useEffect, useRef } from "react";
import type { AppState } from "@/state/store";
import { haptic, type HapticAction } from "./haptics";

type Last = { id: string; optimistic: boolean; userId: string | null; replied: boolean } | null;

/** The newest row, the person's newest message, and whether a bot has said something in words since it. */
function lastOf(state: AppState, chatId: string | null): Last {
  if (!chatId) return null;
  const owner = state.bots.find((bot) => bot.id === chatId) ?? state.groups.find((group) => group.id === chatId);
  const messages = owner?.messages ?? [];
  const newest = messages.at(-1);
  if (!newest) return null;
  const userIndex = messages.findLastIndex((message) => message.role === "user");
  const replied = messages.slice(userIndex + 1).some((message) => message.role !== "user" && message.kind === "text" && Boolean(message.text?.trim()));
  return { id: newest.id, optimistic: newest.role === "user" && newest.id.startsWith("optimistic-"), userId: userIndex >= 0 ? messages[userIndex]!.id : null, replied };
}

const CHOICE = "[role='tab'], [role='radio'], [role='menuitemradio'], [aria-pressed]";

/** What a tap anywhere in the phone app plays: a switch, a segment or choice changing, a menu or picker option, and a
 * few chat controls. A choice already made plays nothing. */
export function tapHaptic(target: EventTarget | null): HapticAction | null {
  if (!(target instanceof Element) || target.closest(":disabled, [aria-disabled='true']")) return null;
  if (target.closest("[role='switch'], input[type='checkbox']")) return "toggle";
  const choice = target.closest(CHOICE);
  if (choice) return choice.matches("[aria-selected='true'], [aria-checked='true'], [aria-pressed='true']") ? null : "segment";
  if (target.closest("[role='menuitem'], [role='option']")) return "pick";
  if (target.closest("[data-composer-stop]")) return "stop";
  if (target.closest("[data-voice-mic='start'], [data-approval-deny]")) return "tap";
  if (target.closest("[data-approval-allow]")) return "success";
  return null;
}

/** The taps a hand expects from a chat: a light one as a message leaves, a soft one as the reply lands in the open chat,
 * an error buzz when something fails, and a tick on any switch, choice or menu option. */
export function useChatHaptics(state: AppState, chatId: string | null, onSent?: () => void) {
  const sent = useRef(onSent);
  sent.current = onSent;
  const last = useRef<Last>(null);
  const shownChat = useRef<string | null>(null);
  const error = useRef<string | null>(null);
  const lastTouch = useRef(-Infinity);

  useEffect(() => {
    const next = lastOf(state, chatId);
    const prev = last.current;
    last.current = next;
    if (shownChat.current !== chatId) { shownChat.current = chatId; return; }
    if (!next || next.id === prev?.id) return;
    if (next.optimistic) { haptic("send"); sent.current?.(); }
    else if (next.replied && !(prev?.replied && prev.userId === next.userId)) haptic("reply");
  }, [state, chatId]);

  useEffect(() => {
    if (state.error && state.error !== error.current) haptic("error");
    error.current = state.error;
  }, [state.error]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const action = tapHaptic(event.target);
      if (action) haptic(action);
    };
    // a long press that brings up a message's actions answers with a tick, as a context menu does
    const shown = new MutationObserver((records) => {
      // the system's context menu gives its own haptic
      if (document.documentElement.dataset.nativeMenu !== undefined) return;
      if (records.some((record) => record.target instanceof HTMLElement && record.target.dataset.shown === "true" && lastTouch.current > performance.now() - 900)) haptic("hold");
    });
    const onTouch = () => { lastTouch.current = performance.now(); };
    shown.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-shown"] });
    document.addEventListener("click", onClick, true);
    document.addEventListener("touchstart", onTouch, { capture: true, passive: true });
    return () => {
      shown.disconnect();
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("touchstart", onTouch, true);
    };
  }, []);
}
