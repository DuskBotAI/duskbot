import { knownBeat, WELCOME_VERSION, type BeatId } from "./onboarding";

/** The first run in progress: the screen it is on, so a reload resumes there. */
export interface WelcomeDraft {
  beat: BeatId;
  /** dusk cloud was picked in this run: it resumes on the browser checkout, or the Cloud being made once paid */
  cloud?: true;
}

/** Kept in this browser beside the email gate (analytics). */
export const WELCOME_DRAFT_KEY = "dusk.onboarding.welcomeDraft";

/** A draft from an earlier welcome (its steps, a typed name) is no draft of this one. */
export function readWelcomeDraft(): WelcomeDraft | null {
  try {
    const raw = localStorage.getItem(WELCOME_DRAFT_KEY);
    const draft = raw ? (JSON.parse(raw) as (Partial<WelcomeDraft> & { version?: unknown }) | null) : null;
    if (!draft || typeof draft !== "object" || draft.version !== WELCOME_VERSION) return null;
    const beat = knownBeat(draft.beat);
    if (!beat) return null;
    return { beat, ...(draft.cloud === true ? { cloud: true as const } : {}) };
  } catch {
    return null;
  }
}

export function saveWelcomeDraft(draft: WelcomeDraft): void {
  try {
    localStorage.setItem(WELCOME_DRAFT_KEY, JSON.stringify({ version: WELCOME_VERSION, beat: draft.beat, ...(draft.cloud ? { cloud: true } : {}) }));
  } catch {
  }
}

export function clearWelcomeDraft(): void {
  try {
    localStorage.removeItem(WELCOME_DRAFT_KEY);
  } catch {
  }
}
