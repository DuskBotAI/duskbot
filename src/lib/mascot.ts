import type { MarkState } from "@/components/mascot-engine";
import { botShowsUnread } from "./bot-unread";
import { lastNonReceipt } from "./receipts";
import type { MausColor } from "../../shared/wire";
import { ELECTRIC } from "../../shared/pixel-bodies";
import type { LocaleKey } from "@/locales";

export { MAUS_COLOR_NAMES, type MausColor } from "../../shared/wire";

/** The states a bot's face can be pinned to or streamed as. */
export const MAUS_STATES = [
  "sleeping", "waking", "idle", "listening", "thinking", "searching", "working", "excited", "surprised", "suspicious",
  "angry", "drowsy", "happy", "curious", "confused", "bored", "proud", "shy", "sad", "laughing", "scared", "playful",
  "celebrate", "orbit", "radar", "progress", "spawning", "humming", "loading", "dictating", "sending", "receiving",
  "uploading", "writing", "notifying", "alerting", "bouncing", "dragging", "powering-down",
] as const satisfies readonly MarkState[];

export type MausState = MarkState;

/** The paint of a mascot's body in each bot colour: the electric palette, so a pixel bot reads at 16 px. */
export const MASCOT_INK: Record<MausColor, string> = {
  green: ELECTRIC.emerald,
  blue: ELECTRIC.blue,
  red: "#ef3a3f",
  orange: ELECTRIC.tangerine,
  purple: ELECTRIC.violet,
  cyan: ELECTRIC.sky,
  pink: ELECTRIC.pink,
  yellow: ELECTRIC.sun,
  teal: ELECTRIC.mint,
  coral: ELECTRIC.coral,
  brown: "#a8672f",
  silver: "#a3aab3",
  chrome: "#b3bac4",
};

/** Each bot colour's base paint for avatars, messages, mentions, and identity tokens. */
export const MAUS_COLORS: Record<MausColor, string> = MASCOT_INK;

export const MAUS_COLOR_LABEL: Record<MausColor, LocaleKey> = {
  green: "mascotColor.green",
  blue: "mascotColor.blue",
  red: "mascotColor.red",
  orange: "mascotColor.orange",
  purple: "mascotColor.purple",
  cyan: "mascotColor.cyan",
  pink: "mascotColor.pink",
  yellow: "mascotColor.yellow",
  teal: "mascotColor.teal",
  coral: "mascotColor.coral",
  brown: "mascotColor.brown",
  silver: "mascotColor.silver",
  chrome: "mascotColor.chrome",
};

/** The bot colours a picker offers: the ones the electric palette paints. Older greys and brown still draw. */
export const PICKER_COLORS: MausColor[] = ["blue", "cyan", "teal", "green", "yellow", "orange", "coral", "red", "pink", "purple"];

/** Bodies in picker rows of five. */
export function rowsOfFive<T>(items: readonly T[]): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += 5) rows.push(items.slice(i, i + 5));
  return rows;
}

/** Polished steel, light to dark, for the chrome swatch. */
export const CHROME_GRADIENT: [string, string, string] = ["#EAEEF2", "#B3BAC4", "#69727D"];

export function colorSwatch(color: MausColor): string {
  if (color !== "chrome") return MASCOT_INK[color];
  const [light, mid, dark] = CHROME_GRADIENT;
  return `radial-gradient(circle at 34% 28%, ${light} 0%, ${mid} 52%, ${dark} 100%)`;
}

export const MAUS_MOTIONS = [
  "arrive",
  "switch",
  "customize",
  "alert",
  "thinking",
  "working",
  "launch",
  "success",
  "celebrate",
  "blink",
  "surprise",
  "failure",
] as const;

export type MausMotion = "none" | (typeof MAUS_MOTIONS)[number];

const KNOWN_STATES = new Set<string>(MAUS_STATES);

export function normalizeState(value: string | null | undefined): MausState | null {
  return value && KNOWN_STATES.has(value) ? (value as MausState) : null;
}

/** The faces a person can pin a bot to, in the picker's order. */
export const PICKABLE_STATES: MausState[] = [
  "idle",
  "happy",
  "curious",
  "drowsy",
  "working",
  "thinking",
  "listening",
  "sleeping",
  "suspicious",
  "proud",
];

/** Pinned faces older versions saved under other names. */
const PINNED_ALIASES: Record<string, MausState> = { focused: "working", sleepy: "drowsy", worried: "scared" };

/** Cards that wait on the person until they answer. */
const AWAITING_KINDS = new Set(["options"]);

type MascotMessage = {
  kind: string;
  tool?: { ok?: boolean };
};

export type MascotBotProfile = {
  name: string;
  title?: string;
  description?: string;
  mascotExpression?: string | null;
  busy?: boolean;
  unread?: boolean;
  tasks?: Array<{ unread?: boolean; routineRunId?: string }> | null;
  messages?: MascotMessage[];
};

/** The state a bot's avatar shows: at work while a turn runs, failed after a failed step, a notice while a reply waits
 * unread, blocked while a card waits on the person, and otherwise the face the person pinned, or idle. */
export function stateForBot(bot: MascotBotProfile): MarkState {
  if (bot.busy) return "working";
  const last = lastNonReceipt(bot.messages);
  if (last?.kind === "activity" && last.tool?.ok === false) return "failed";
  if (botShowsUnread(bot)) return "notifying";
  if (last && AWAITING_KINDS.has(last.kind)) return "blocked";
  const pinned = bot.mascotExpression;
  if (!pinned) return "idle";
  return (Object.hasOwn(PINNED_ALIASES, pinned) ? PINNED_ALIASES[pinned] : normalizeState(pinned)) ?? "idle";
}
