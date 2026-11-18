import { t } from "./i18n";

export interface FeatureFlagConfig {
  features?: { skillAuthoring?: boolean; skillReview?: boolean; skillReviewSteps?: number; showToolCalls?: boolean; browser?: boolean; claudeUserMcp?: boolean; claudeUserSkills?: boolean; llmThreadTitles?: boolean; quickUpdates?: boolean; liveCards?: boolean; skillsLibrary?: boolean; shareLearnedSkills?: "off" | "ask" | "auto"; roomMemoryCapture?: boolean };
  browserEngine?: { kind: "engine" | "unavailable"; reason?: string; installable?: boolean; installing?: boolean; installError?: string };
}

/** The phone app, off while it is reworked: the first run's phone step, Settings → phone, "connect your phone" and every
 * pairing prompt follow this one switch. A build with `VITE_DUSK_PHONE_APP=1` brings them all back. */
export function phoneAppEnabled(): boolean {
  return import.meta.env?.VITE_DUSK_PHONE_APP === "1" || phoneAppByHand();
}

/** The first run's phone step and the intro's phone chip: only a build that ships the phone app asks for it at the
 * start; the Advanced switch shows the phone settings without ever prompting. */
export function phoneAppPrompted(): boolean {
  return import.meta.env?.VITE_DUSK_PHONE_APP === "1";
}

const PHONE_APP_KEY = "dusk.phoneApp.manual";

/** Settings → Advanced's own switch for the phone app, for developers and testers; nobody else is asked or shown it. */
export function phoneAppByHand(): boolean {
  try { return globalThis.localStorage?.getItem(PHONE_APP_KEY) === "1"; } catch { return false; }
}

export function setPhoneAppByHand(on: boolean): void {
  try { if (on) globalThis.localStorage?.setItem(PHONE_APP_KEY, "1"); else globalThis.localStorage?.removeItem(PHONE_APP_KEY); } catch { /* storage off: the switch stays as it was */ }
}

/** Live calls, off: the call button, its mode menu, the live bar and pill, the "live key needed" prompt and the
 * live key rows in Settings all follow this one switch. The engine stays; a build with `VITE_DUSK_LIVE_CALL=1` brings it back. */
export function liveCallEnabled(): boolean {
  return import.meta.env?.VITE_DUSK_LIVE_CALL === "1";
}

export function browserAvailable(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.browserEngine?.kind === "engine";
}

export function browserUnavailableReason(config: FeatureFlagConfig | null | undefined): string {
  const engine = config?.browserEngine;
  if (engine?.kind === "unavailable" && engine.installable) return t("browser.notInstalled");
  if (engine?.kind === "unavailable" && engine.reason) return engine.reason;
  return t("browser.noEngine");
}

export function skillAuthoringEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.skillAuthoring !== false;
}

export const DEFAULT_SKILL_REVIEW_STEPS = 10;
export const MIN_SKILL_REVIEW_STEPS = 3;
export const MAX_SKILL_REVIEW_STEPS = 100;

export function skillReviewEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return skillAuthoringEnabled(config) && config?.features?.skillReview === true;
}

export function skillReviewSteps(config: FeatureFlagConfig | null | undefined): number {
  const raw = config?.features?.skillReviewSteps;
  const value = typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : DEFAULT_SKILL_REVIEW_STEPS;
  return Math.min(MAX_SKILL_REVIEW_STEPS, Math.max(MIN_SKILL_REVIEW_STEPS, value));
}

export function skillReviewUnavailableEngines(
  bots: ReadonlyArray<{ modelSelection?: { instanceId?: string } }>,
  instances: ReadonlyArray<{ instanceId: string; displayName: string; capabilities?: { backgroundText?: boolean; agentsMcp?: boolean } }>,
): string[] {
  const used = new Set(bots.map((bot) => bot.modelSelection?.instanceId).filter(Boolean));
  return [...new Set(instances
    .filter((instance) => used.has(instance.instanceId))
    .filter((instance) => instance.capabilities?.backgroundText !== true || instance.capabilities?.agentsMcp !== true)
    .map((instance) => instance.displayName))];
}

export function parseSkillReviewSteps(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const steps = Number(trimmed);
  return steps >= MIN_SKILL_REVIEW_STEPS && steps <= MAX_SKILL_REVIEW_STEPS ? steps : null;
}

export function builtInBrowserEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.browser === true;
}

export function showToolCallsEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.showToolCalls === true;
}

export function liveCardsEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.liveCards === true;
}

export function claudeUserMcpEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.claudeUserMcp === true;
}

export function claudeUserSkillsEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.claudeUserSkills === true;
}

export function llmThreadTitlesEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.llmThreadTitles === true;
}

export function quickUpdatesEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.quickUpdates !== false;
}

export function skillsLibraryEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.skillsLibrary === true;
}

export function shareLearnedSkillsMode(config: FeatureFlagConfig | null | undefined): "off" | "ask" | "auto" {
  if (!skillsLibraryEnabled(config)) return "off";
  return config?.features?.shareLearnedSkills ?? "ask";
}

export function roomMemoryCaptureEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.roomMemoryCapture === true;
}
