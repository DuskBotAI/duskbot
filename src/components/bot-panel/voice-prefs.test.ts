// @vitest-environment happy-dom
import { expect, it } from "vitest";

import { callLanguageFor, callSpeedFor, setVoicePrefs, voicePrefs } from "./voice-prefs";

it("a bot's own call speed and language win; one the person never set leaves the call's global speed", () => {
  setVoicePrefs("ada", { language: "de" });
  expect(voicePrefs("ada")).toEqual({ language: "de" });
  expect(callSpeedFor(voicePrefs("ada"), 1.15)).toBe(1.15);
  expect(callLanguageFor(voicePrefs("ada"))).toBe("de");

  setVoicePrefs("ada", { speed: "1.5" });
  expect(callSpeedFor(voicePrefs("ada"), 1.15)).toBe(1.5);
  setVoicePrefs("ada", { speed: "0.9", language: "auto" });
  expect(callSpeedFor(voicePrefs("ada"), 1)).toBe(0.9);
  expect(callLanguageFor(voicePrefs("ada"))).toBeUndefined();
});
