// Voice input in the chat bar. While the person talks the composer shows a waveform and one line of what they are
// saying; nothing touches the draft until they stop, then the words land at once, ready to edit. A late final from
// the recognizer, and the optional clean-up, replace those words only while the draft is still exactly as left.
import { feature } from "./product-analytics";
import { createElement, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { withOpenSettings } from "@/components/OpenSystemSettings";
import { withVoiceSettings } from "@/components/OpenVoiceSettings";
import { useStore } from "@/state/store";
import { VOICE_PROVIDER_INFO } from "../../electron/voice-catalog.mjs";
import { appendDictatedText } from "./drafts";
import { activeLocale, t } from "./i18n";
import { phoneApp } from "./store-app";
import { serverListeningReady } from "./speech";
import type { VoiceBridge, VoiceEnd, VoiceLine } from "./voice-input/bridge";
import { cleanTranscript, cleanupWanted } from "./voice-input/cleanup";
import { currentVoiceDevice, onPhoneVoice, phoneVoice } from "./voice-input/device";
import { systemEngineWhere, type ResolvedEngine } from "./voice-input/engines";
import { useVoiceKeys } from "./voice-input/keys";
import { setVoicePrefs, useVoicePrefs } from "./voice-input/prefs";
import { dictationLocale } from "./voice-input/locale";
import { joinDictation } from "./voice-input/preview";
import { currentEngine, voiceBridgeFor } from "./voice-input/select";

/** How long a stopped session waits for the recognizer's final words after the heard ones already landed. */
export const FINAL_GRACE_MS = 2_500;
/** How long a service may take to hear the last piece when nothing had come back before the stop. */
export const TRANSCRIBE_WAIT_MS = 30_000;

export type DictationPhase = "idle" | "listening" | "finishing";

type Session = {
  gen: number;
  draftId: string;
  base: string;
  heard: string;
  bridge: VoiceBridge;
  offs: Array<() => void>;
  /** The draft as voice left it once the words landed; null until then. */
  committed: string | null;
  timer: ReturnType<typeof setTimeout> | null;
};

/** A tiny broadcaster for input loudness, so the waveform draws without re-rendering the composer. */
function createLevels() {
  const listeners = new Set<(level: number) => void>();
  return {
    emit: (level: number) => listeners.forEach((cb) => cb(level)),
    subscribe: (cb: (level: number) => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
export type LevelSource = ReturnType<typeof createLevels>["subscribe"];

function serviceName(engine: ResolvedEngine): string {
  return engine.kind === "provider" ? VOICE_PROVIDER_INFO[engine.provider].name : "";
}

/** The body of the "nothing here can listen" card; the composer gives it a title and the way to pick a service. */
export function NoRecognizerNote() {
  return t("composer.voice.noRecognizer");
}

/** Nothing on this device can listen: say so plainly, with the way to pick a service. */
export function noRecognizer(): ReactNode {
  return createElement(NoRecognizerNote);
}

/** The calm line shown over the composer when voice input could not go on. */
export function dictationError(info: VoiceEnd, engine: ResolvedEngine, where: ReturnType<typeof systemEngineWhere>): ReactNode {
  if (info.message) return info.message;
  const reason = info.reason ?? "";
  const service = serviceName(engine);
  if (reason === "unsupported-locale") return t("composer.dictation.language");
  if (info.code === 2) return engine.kind === "none" ? noRecognizer() : t("composer.dictation.unavailable");
  if (reason === "mic-denied") return withOpenSettings(t("composer.voice.micDenied"), "mic");
  if (reason === "speech-not-authorized") return withOpenSettings(t("composer.dictation.permission"), "speech");
  if (reason === "dictation-disabled") return t("composer.dictation.disabled");
  if (reason === "mic-failed" && where === "mac") return withOpenSettings(t("composer.dictation.micFailed"), "mic");
  if (reason === "mic-failed" || reason === "microphone-blocked") {
    if (where === "iphone" || where === "android") return t("composer.voice.micBlocked.phone");
    if (where === "browser") return t("composer.voice.micBlocked.browser");
    if (where === "windows") return t("composer.voice.micBlocked.windows");
    return where === "mac" ? withOpenSettings(t("composer.dictation.micFailed"), "mic") : t("composer.voice.micMissing");
  }
  if (reason === "microphone-missing") return t("composer.voice.micMissing");
  if (reason === "recognizer-unavailable") {
    return where === "windows" ? withVoiceSettings(t("composer.voice.windowsRecognizer"), "composer.voice.chooseService") : noRecognizer();
  }
  if (reason === "service-bad-key") return withVoiceSettings(t("composer.voice.serviceKey", { service }), "composer.voice.checkKey");
  if (reason === "service-rate-limited") return t("composer.voice.serviceBusy", { service });
  if (reason === "service-network") return t("composer.voice.serviceOffline", { service });
  if (reason === "service-not-set-up") return withVoiceSettings(t("composer.voice.serviceSetup", { service }), "composer.voice.finishSetup");
  if (reason === "transcribe-timeout") return t("composer.voice.timeout");
  if (reason.startsWith("service-") && service) return t("composer.voice.serviceFailed", { service });
  return t("composer.dictation.failed");
}

export function useComposerDictation({ draftId, text, onText }: {
  draftId: string;
  text: string;
  onText: (text: string) => void;
}) {
  // capabilities load after the first paint: re-read the device when they do, and when the phone registers itself
  useDesktopCapabilities();
  useSyncExternalStore(onPhoneVoice, phoneVoice, () => null);
  const { state: { config, appSettingsOpen, appSettingsSection } } = useStore();
  const prefs = useVoicePrefs();
  const keys = useVoiceKeys();
  const engine = currentEngine(prefs, keys, serverListeningReady(config));
  const bridge = voiceBridgeFor(engine, prefs);
  const where = systemEngineWhere(currentVoiceDevice());
  const ready = Boolean(bridge);

  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [preview, setPreview] = useState("");
  const [speechError, setSpeechError] = useState<ReactNode>(null);
  const [firstRunOpen, setFirstRunOpen] = useState(false);
  const [tidying, setTidying] = useState(false);
  const [levels] = useState(createLevels);
  const draft = useRef({ id: draftId, text });
  draft.current = { id: draftId, text };
  const session = useRef<Session | null>(null);
  const generation = useRef(0);
  const tidy = useRef<AbortController | null>(null);
  const latest = useRef({ engine, where, prefs, onText });
  latest.current = { engine, where, prefs, onText };

  const release = useCallback((s: Session) => {
    s.offs.forEach((off) => off());
    s.offs = [];
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    if (session.current === s) session.current = null;
  }, []);

  /** Puts the words heard so far into the draft they were said for. */
  const commit = useCallback((s: Session) => {
    if (!s.heard) return;
    const next = joinDictation(s.base, s.heard);
    s.committed = next;
    if (draft.current.id === s.draftId) {
      draft.current.text = next;
      latest.current.onText(next);
    } else {
      appendDictatedText(s.draftId, s.heard);
    }
    setPreview("");
  }, []);

  const tidyUp = useCallback((s: Session) => {
    const { prefs: now } = latest.current;
    if (s.committed === null || !cleanupWanted(now, s.heard)) return;
    tidy.current?.abort();
    const abort = new AbortController();
    tidy.current = abort;
    setTidying(true);
    const heard = s.heard;
    void cleanTranscript(heard, now, undefined, abort.signal).then((clean) => {
      if (abort.signal.aborted || clean === heard) return;
      // only over the words exactly as they landed: an edit, a send or another chat wins
      if (draft.current.id !== s.draftId || draft.current.text !== s.committed) return;
      const next = joinDictation(s.base, clean);
      draft.current.text = next;
      latest.current.onText(next);
    }).finally(() => {
      if (tidy.current === abort) {
        tidy.current = null;
        setTidying(false);
      }
    });
  }, []);

  const finalize = useCallback((s: Session) => {
    if (s.committed === null) commit(s);
    release(s);
    setPhase((current) => (session.current ? current : "idle"));
    setPreview("");
    tidyUp(s);
  }, [commit, release, tidyUp]);

  const onLine = useCallback((s: Session, line: VoiceLine) => {
    if (session.current !== s || typeof line.text !== "string") return;
    const heard = line.text.trim();
    if (!heard) return;
    s.heard = heard;
    if (s.committed === null) {
      setPreview(heard);
      return;
    }
    // the final words after the stop: they replace the heard ones while the draft is untouched
    if (draft.current.id === s.draftId && draft.current.text === s.committed) {
      const next = joinDictation(s.base, heard);
      s.committed = next;
      draft.current.text = next;
      latest.current.onText(next);
    }
  }, []);

  const onEnd = useCallback((s: Session, info: VoiceEnd) => {
    if (session.current !== s) return;
    if (info.code !== 0) {
      const { engine: now, where: here } = latest.current;
      setSpeechError(dictationError(info, now, here));
    }
    finalize(s);
  }, [finalize]);

  /** Drops a session without its words. */
  const drop = useCallback((s: Session | null) => {
    if (!s) return;
    release(s);
    void s.bridge.speechStop().catch(() => {});
    setPhase("idle");
    setPreview("");
  }, [release]);

  const begin = useCallback(() => {
    if (!bridge) return;
    const previous = session.current;
    if (previous) drop(previous);
    tidy.current?.abort();
    const s: Session = {
      gen: ++generation.current, draftId, base: draft.current.text, heard: "", bridge, offs: [], committed: null, timer: null,
    };
    session.current = s;
    setSpeechError(null);
    setPreview("");
    setPhase("listening");
    s.offs.push(bridge.onSpeechTranscript((line) => onLine(s, line)));
    s.offs.push(bridge.onSpeechEnd((info) => onEnd(s, info)));
    if (bridge.onSpeechLevel) s.offs.push(bridge.onSpeechLevel((level) => { if (session.current === s) levels.emit(level); }));
    const locale = latest.current.prefs.language || (phoneVoice() ? dictationLocale(activeLocale(), navigator.languages ?? []) : undefined);
    void bridge.speechStart(locale ? { locale } : undefined).then(() => {
      if (session.current === s) feature("voice_used");
    }).catch(() => {
      if (session.current !== s) return;
      drop(s);
      setSpeechError(t("composer.dictation.failed"));
    });
  }, [bridge, draftId, drop, levels, onEnd, onLine]);

  /** Stop listening and land the words now; the recognizer's final words follow if they differ. */
  const finish = useCallback(() => {
    const s = session.current;
    if (!s) return;
    if (s.timer) return;
    // the device's own recognizers stream every word as it is heard: with nothing heard, nothing is on its way
    const now = latest.current.engine;
    const streams = now.kind === "system" && now.engine !== "fish-audio";
    if (!s.bridge.speechFinish || (!s.heard && streams)) {
      void s.bridge.speechStop().catch(() => {});
      return finalize(s);
    }
    if (s.heard) {
      commit(s);
      setPhase("idle");
      s.timer = setTimeout(() => {
        if (session.current !== s) return;
        void s.bridge.speechStop().catch(() => {});
        finalize(s);
      }, FINAL_GRACE_MS);
    } else {
      // a service that hears whole pieces may not have answered yet: say so until it does
      setPhase("finishing");
      s.timer = setTimeout(() => {
        if (session.current !== s) return;
        void s.bridge.speechStop().catch(() => {});
        setSpeechError(t("composer.voice.timeout"));
        finalize(s);
      }, TRANSCRIBE_WAIT_MS);
    }
    void s.bridge.speechFinish().catch(() => {
      if (session.current === s) finalize(s);
    });
  }, [commit, finalize]);

  /** Esc or the cancel button: listening ends and nothing lands. */
  const discard = useCallback(() => {
    const s = session.current;
    if (!s || s.committed !== null) return;
    drop(s);
  }, [drop]);

  /** Send while talking: the words heard so far land now and the session ends. Returns whether any landed. */
  const takeForSend = useCallback((): boolean => {
    const s = session.current;
    if (!s) return false;
    const landed = s.committed === null && Boolean(s.heard);
    if (landed) commit(s);
    release(s);
    void s.bridge.speechStop().catch(() => {});
    setPhase("idle");
    setPreview("");
    return landed;
  }, [commit, release]);

  /** Silently end any session, its words kept if they already landed (a send, the composer going away). */
  const stop = useCallback(() => {
    tidy.current?.abort();
    const s = session.current;
    if (s) drop(s);
  }, [drop]);

  // another chat: a live session's words go to the chat they were said in, and listening ends
  useEffect(() => {
    const s = session.current;
    if (!s || s.draftId === draftId) return;
    if (s.committed === null) commit(s);
    drop(s);
  }, [draftId, commit, drop]);

  useEffect(() => () => {
    tidy.current?.abort();
    const s = session.current;
    if (!s) return;
    if (s.committed === null) commit(s);
    release(s);
    void s.bridge.speechStop().catch(() => {});
  }, [commit, release]);

  // the note goes once the person is in Settings > Voice; only a later failed press shows it again
  const inVoiceSettings = appSettingsOpen && appSettingsSection === "voice";
  useEffect(() => {
    if (inVoiceSettings) setSpeechError(null);
  }, [inVoiceSettings]);
  const dismissError = useCallback(() => setSpeechError(null), []);

  const toggle = () => {
    if (!ready) {
      setSpeechError(engine.kind === "none" ? noRecognizer() : t("composer.dictation.unavailable"));
      return;
    }
    if (session.current && phase !== "idle") return finish();
    // the first tap on the device's own recognizer says which one listens and where to choose another; the phone app
    // just listens
    if (engine.kind === "system" && !prefs.firstRunSeen && !phoneApp()) {
      setFirstRunOpen(true);
      return;
    }
    begin();
  };

  const firstRun = {
    open: firstRunOpen,
    where,
    /** Continue: seen for good, and listening starts. */
    accept: () => {
      setVoicePrefs({ firstRunSeen: true });
      setFirstRunOpen(false);
      begin();
    },
    /** The sheet closed some other way: still seen, nothing starts. */
    dismiss: () => {
      setVoicePrefs({ firstRunSeen: true });
      setFirstRunOpen(false);
    },
  };

  return {
    /** The mic is live or its last words are on the way. */
    recording: phase !== "idle",
    phase,
    ready,
    preview,
    speechError,
    dismissError,
    tidying,
    levels: levels.subscribe,
    hasLevels: Boolean(bridge?.onSpeechLevel),
    toggle,
    finish,
    discard,
    stop,
    takeForSend,
    firstRun,
  };
}
