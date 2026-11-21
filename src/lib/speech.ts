import { keyEntry, savedState } from "@/components/keys/key-catalog";
import type { ConfigStatus } from "@/state/store";
import { desktopCapabilitiesNow } from "./desktop";
import { fishSpeech, type SpeechBridge } from "./fish-speech";
import type { VoiceBridge } from "./voice-input/bridge";
import { phoneVoice } from "./voice-input/device";

/** The phone app's own recognizer, when this page runs inside it. */
export function phoneListener(): VoiceBridge | null {
  return phoneVoice()?.speech ?? null;
}

/** The speech bridge this device listens through: the phone's recognizer, the page's own Fish Audio listener, or the
 * desktop app's helper. Whichever bot the chat is with, only its words go to that bot's server. */
export function speechBridge(): SpeechBridge | VoiceBridge | Window["duskDesktop"] {
  const phone = phoneListener();
  if (phone) return phone;
  return desktopCapabilitiesNow().dictation.engine === "fish-audio" ? fishSpeech : globalThis.window?.duskDesktop;
}

/** Whether the bot's server can turn a clip into text: a Fish Audio key, or any other listening key it reports. */
export function serverListeningReady(config: ConfigStatus | null | undefined): boolean {
  return savedState(keyEntry("fishAudio"), config).configured || config?.tts?.listen?.ready === true;
}

/** Whether speech can be heard here: the engine is there and, through the server, so is a listening key. */
export function listensHere(capabilities: DesktopCapabilities, config: ConfigStatus | null | undefined): boolean {
  if (phoneListener()) return true;
  return capabilities.dictation.available && (capabilities.dictation.engine !== "fish-audio" || serverListeningReady(config));
}
