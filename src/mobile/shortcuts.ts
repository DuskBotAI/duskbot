import { useCallback, useEffect, useRef, useState } from "react";
import { askForCall } from "@/lib/call";
import type { Action, AppState } from "@/state/store";
import type { MobileConnectionRecord } from "../../shared/mobile-link";
import type { MobilePlatform } from "./platform";

export interface ShortcutBot { id: string; name: string }

/** What a Siri, Spotlight or Shortcuts app run asks of a bot. `place`: the environment id of the place the bot is on. */
export type ShortcutAction =
  | { kind: "send"; place: string; botId: string; text: string }
  | { kind: "call" | "open"; place: string; botId: string };

/** The phone's App Shortcuts (ios/App/App/BotIntents.swift). */
export interface ShortcutsBridge {
  /** The bots of the place on screen, offered by name; `places`: every place still on the phone, the rest are forgotten. */
  setBots(update: { place: string; placeName: string; bots: ShortcutBot[]; places: string[] }): void;
  /** Forgets every bot, for a phone with no place left. */
  forget(): void;
  /** Each run, including one made before the app had loaded. Returns the stop. */
  onAction(listener: (action: ShortcutAction) => void): () => void;
}

const ID = /^[\w:.-]{1,200}$/;
const HELD_KEY = "dusk.mobile.shortcut.held";

export function shortcutAction(raw: unknown): ShortcutAction | null {
  if (!raw || typeof raw !== "object") return null;
  const { kind, place, botId, text } = raw as Record<string, unknown>;
  if (typeof place !== "string" || !place || place.length > 300 || typeof botId !== "string" || !ID.test(botId)) return null;
  if (kind === "send") {
    const message = typeof text === "string" ? text.trim().slice(0, 8000) : "";
    return message ? { kind, place, botId, text: message } : null;
  }
  return kind === "call" || kind === "open" ? { kind, place, botId } : null;
}

/** what the shortcuts list for the place on screen, in the home list's order of names */
export function shortcutBots(bots: AppState["bots"]): ShortcutBot[] {
  return bots.filter((bot) => bot.name.trim()).map((bot) => ({ id: bot.id, name: bot.name.trim() }));
}

/** Keeps Siri's list of bots in step with the place on screen and does what a shortcut run asks once the place is
 * connected. A run for a bot on another linked place switches to it and is done there. */
export function useShortcuts({ platform, state, dispatch, place, connections, loaded, switchTo, openChat }: {
  platform: MobilePlatform;
  state: AppState;
  dispatch: (action: Action) => void;
  place: string | null;
  connections: readonly MobileConnectionRecord[];
  loaded: boolean;
  switchTo: (id: string) => Promise<void>;
  openChat: (id: string) => void;
}) {
  const shortcuts = platform.shortcuts;
  const record = connections.find((one) => one.id === place);
  const environment = record?.environmentId ?? null;
  const published = useRef("");

  const bots = state.hydrated ? shortcutBots(state.bots) : null;
  const update = shortcuts && environment && record && bots
    ? { place: environment, placeName: record.label.trim(), bots, places: connections.map((one) => one.environmentId) } : null;
  const key = update ? JSON.stringify(update) : loaded && connections.length === 0 ? "none" : "";
  const shown = useRef(update);
  shown.current = update;
  useEffect(() => {
    if (!shortcuts || !key || key === published.current) return;
    published.current = key;
    if (shown.current) shortcuts.setBots(shown.current);
    else shortcuts.forget();
  }, [shortcuts, key]);

  const [held] = useState(readHeld);
  const waiting = useRef<ShortcutAction[]>(held ? [held] : []);
  const ready = state.hydrated && state.connected && loaded;
  const latest = useRef({ state, environment, connections, ready });
  latest.current = { state, environment, connections, ready };

  const run = useCallback((action: ShortcutAction) => {
    const { state: now, environment: here, connections: linked } = latest.current;
    if (action.place !== here) {
      const elsewhere = action === held ? undefined : linked.find((one) => one.environmentId === action.place);
      if (elsewhere) { hold(action); void switchTo(elsewhere.id); }
      return;
    }
    const bot = now.bots.find((one) => one.id === action.botId);
    if (!bot) return;
    openChat(bot.id);
    if (action.kind === "send") dispatch({ type: "send", botId: bot.id, text: action.text, threadId: bot.threadId });
    else if (action.kind === "call") askForCall(bot.id);
  }, [dispatch, openChat, switchTo, held]);

  useEffect(() => shortcuts?.onAction((action) => {
    if (latest.current.ready) run(action);
    else waiting.current.push(action);
  }), [shortcuts, run]);

  useEffect(() => {
    if (!ready) return;
    for (const action of waiting.current.splice(0)) run(action);
  }, [ready, run]);
}

/** a run kept across the reload that switches places; one that still finds no place after it is dropped */
function hold(action: ShortcutAction) {
  try { sessionStorage.setItem(HELD_KEY, JSON.stringify(action)); } catch { /* storage unavailable */ }
}

function readHeld(): ShortcutAction | null {
  try {
    const raw = sessionStorage.getItem(HELD_KEY);
    sessionStorage.removeItem(HELD_KEY);
    return raw ? shortcutAction(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
