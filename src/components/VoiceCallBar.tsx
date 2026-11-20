import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { Check, MessageSquareText, Mic, MicOff, PhoneOff, RotateCcw, Settings } from "../icons";

import { deferCallCleanup, endCall } from "@/lib/call";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useSystemControl } from "@/lib/system-control";
import { haptic } from "@/mobile/haptics";
import { localVoiceCallKnown, markLocalVoiceUnavailable } from "@/lib/voice-call/availability";
import { ease } from "@/lib/voice-call/meter";
import { ACCOUNT_VOICE, CALL_SPEEDS, CALL_VOICES, callPrefs, setCallPrefs, useCallPrefs, voiceForBot, type CallVoiceId } from "@/lib/voice-call/prefs";
import { callLanguageFor, callSpeedFor, setVoicePrefs, useVoicePrefs, voicePrefs } from "./bot-panel/voice-prefs";
import { VoiceCallSession, type CallFacts, type CallSnapshot } from "@/lib/voice-call/session";
import { useStore, visibleMessages, type Bot } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { OpenSystemSettings } from "./OpenSystemSettings";
import { pendingApprovals, spokenApprovalPrompt } from "./PendingApproval";
import { VoiceCallWave, type WaveFrame, type WaveSource } from "./VoiceCallWave";

/** The sheet curve's exit (spec: sheetOut): accelerating, gone in 200 ms. */
const LEAVE_MS = 200;
/** Borderless tonal contrast: the pill is a step of ink over the page, its buttons another step. */
const TONE = "bg-[color-mix(in_srgb,var(--color-ink)_5.5%,var(--color-app))]";
const BUTTON_TONE = "bg-ink/[0.07] text-ink-secondary hover:bg-ink/[0.11] hover:text-ink";
const VOICE_SERVICES: Record<string, string> = {
  elevenlabs: "ElevenLabs", fish: "Fish Audio", openai: "OpenAI", system: "system", chatterbox: "Chatterbox",
  xai: "Grok", gemini: "Gemini", deepgram: "Deepgram", cartesia: "Cartesia",
};

function useSession(session: VoiceCallSession): CallSnapshot {
  return useSyncExternalStore((fn) => session.subscribe(fn), () => session.state, () => session.state);
}

function useNarrow(): boolean {
  const query = "(max-width: 479px)";
  return useSyncExternalStore(
    (fn) => {
      const list = globalThis.matchMedia?.(query);
      list?.addEventListener("change", fn);
      return () => list?.removeEventListener("change", fn);
    },
    () => globalThis.matchMedia?.(query).matches === true,
    () => false,
  );
}

function factsFor(bot: Bot): CallFacts {
  const messages = visibleMessages(bot);
  const approval = pendingApprovals(messages)[0];
  const question = messages.find((m) => m.kind === "options" && m.card?.requestId && !m.card.tool && !m.card.answered && !m.card.dismissed);
  const step = bot.busy ? [...messages].reverse().find((m) => m.kind === "activity" && m.tool?.spoken && m.tool.ok === undefined) : undefined;
  const detail = question?.card?.subtitle.trim() ?? "";
  return {
    busy: Boolean(bot.busy),
    approval: approval ? { requestId: approval.requestId, prompt: spokenApprovalPrompt(approval, bot.name) } : null,
    question: question?.card?.requestId
      ? {
          requestId: question.card.requestId,
          messageId: question.id,
          prompt: t("call.question", {
            name: bot.name,
            detail: `${detail}${/[.!?]$/.test(detail) ? "" : "."}`,
            choices: question.card.options.length ? t("call.questionOptions", { options: question.card.options.join(", ") }) : "",
          }),
        }
      : null,
    step: step?.tool?.spoken ? { id: step.id, spoken: step.tool.spoken } : null,
  };
}

export function VoiceCall({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const tts = state.config?.tts;
  const account = tts?.ready ? VOICE_SERVICES[tts.provider ?? "elevenlabs"] ?? null : null;
  const prefs = useCallPrefs();
  const own = useVoicePrefs(bot.id);
  const speed = callSpeedFor(own, prefs.speed);
  const voice = voiceForBot(bot.id, prefs);
  const [attempt, setAttempt] = useState(0);
  const [session, setSession] = useState<VoiceCallSession | null>(null);
  const botRef = useRef(bot);
  botRef.current = bot;

  useEffect(() => {
    const { id, threadId } = botRef.current;
    const next = new VoiceCallSession(
      { id, threadId },
      {
        send: (text, callId) => dispatch({ type: "send", botId: id, threadId, text, voiceCall: { callId } }),
        decide: (requestId, allow) => dispatch({ type: "decideRequest", threadId, requestId, behavior: allow ? "allow" : "deny", message: allow ? undefined : t("call.denied") }),
        answer: (messageId, text) => dispatch({ type: "answerCard", botId: id, threadId, messageId, answer: text }),
      },
      { voice: voiceForBot(id), speed: callSpeedFor(voicePrefs(id), callPrefs().speed), language: callLanguageFor(voicePrefs(id)), accountVoiceId: botRef.current.voice },
    );
    next.skipSteps(visibleMessages(botRef.current).filter((m) => m.kind === "activity").map((m) => m.id));
    setSession(next);
    void next.start();
    return () => next.close();
  }, [bot.id, bot.threadId, attempt, dispatch]);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const id = bot.id;
    return () => {
      alive.current = false;
      // Handing the call to Take turns (the built-in voice cannot run here) keeps it open.
      deferCallCleanup(id, () => alive.current || localVoiceCallKnown() === false);
    };
  }, [bot.id]);

  useEffect(() => session?.setVoice(voice, speed), [session, voice, speed]);
  useEffect(() => session?.update(factsFor(bot)), [session, bot]);

  if (!session) return null;
  return <CallSurface bot={bot} session={session} transcript={prefs.transcript} voice={voice} speed={speed} account={account} onRetry={() => setAttempt((n) => n + 1)} />;
}

function CallSurface({ bot, session, transcript, voice, speed, account, onRetry }: {
  bot: Bot;
  session: VoiceCallSession;
  transcript: boolean;
  voice: CallVoiceId;
  speed: number;
  account: string | null;
  onRetry: () => void;
}) {
  const snap = useSession(session);
  const [leaving, setLeaving] = useState(false);
  const leave = useCallback(() => {
    if (leaving) return;
    session.interrupt();
    session.endChime();
    setLeaving(true);
    setTimeout(() => endCall(bot.id), LEAVE_MS);
  }, [bot.id, leaving, session]);

  useEffect(() => {
    if (snap.error?.kind === "unsupported") markLocalVoiceUnavailable();
  }, [snap.error?.kind]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        leave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [leave]);

  const wave = useCallback<WaveSource>(() => {
    const botLevel = session.botLevel();
    if (botLevel > 0.01) return { level: botLevel, who: "bot" };
    const mic = snap.muted ? 0 : session.micLevel;
    return { level: mic, who: mic > 0 ? "person" : "none" };
  }, [session, snap.muted]);

  return (
    <>
      {!transcript && <CallStage bot={bot} snap={snap} leaving={leaving} />}
      {/* covers the composer while the call holds the floor, so nothing under the pill shows or moves */}
      <div data-call-surface="" data-call-leaving={leaving ? "" : undefined} className={cn("voice-call-dock pointer-events-auto absolute inset-x-0 bottom-0 z-30 flex flex-col items-center gap-2 bg-[linear-gradient(to_top,var(--color-app)_72%,transparent)] px-3 pb-5 pt-10 sm:px-4", leaving && "voice-call-dock-out")}>
        <HeardLine snap={snap} />
        <CallPill bot={bot} snap={snap} session={session} wave={wave} transcript={transcript} voice={voice} speed={speed} account={account} onRetry={onRetry} onHangUp={leave} leaving={leaving} />
      </div>
    </>
  );
}

export function statusText(snap: CallSnapshot, name: string, narrow = false): string | null {
  if (snap.phase === "connecting") return t("call.live.connecting");
  if (snap.phase !== "error") return null;
  const kind = snap.error?.kind;
  if (kind === "microphone-blocked") return t(narrow ? "call.voice.micBlockedShort" : "call.voice.micBlocked");
  if (kind === "microphone-missing") return t("call.voice.micMissing");
  if (kind === "microphone-failed") return t("call.voice.micFailed");
  return t("call.voice.failed", { name });
}

function phaseLabel(snap: CallSnapshot, name: string): string {
  if (snap.muted) return t("call.voice.muted");
  if (snap.phase === "hearing") return t("call.voice.hearing");
  if (snap.phase === "thinking") return t("call.voice.thinking", { name });
  if (snap.phase === "speaking") return t("call.voice.speaking", { name });
  return t("call.voice.listening");
}

/** The mascot's mood for the phase; how it moves while talking or listening comes from the voice itself. */
function mascotMood(snap: CallSnapshot): "idle" | "listening" | "thinking" {
  if (snap.phase === "hearing") return "listening";
  if (snap.phase === "thinking") return "thinking";
  return "idle";
}

function RoundButton({ label, pressed, filled, className, disabled, onClick, children, buttonRef, expanded, popup }: {
  label: string;
  pressed?: boolean;
  className: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
  buttonRef?: React.Ref<HTMLButtonElement>;
  expanded?: boolean;
  popup?: "dialog";
  /** a solid disc (hanging up, a muted mic): the phone draws every other control as a plain glyph */
  filled?: boolean;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      aria-expanded={expanded}
      aria-haspopup={popup}
      data-call-filled={filled ? "" : undefined}
      disabled={disabled}
      onPointerDown={() => haptic("tap")}
      onClick={onClick}
      className={cn("voice-call-press flex size-9 shrink-0 items-center justify-center rounded-full disabled:opacity-50 sm:size-10", className)}
    >
      {children}
    </button>
  );
}

function CallPill({ bot, snap, session, wave, transcript, voice, speed, account, onRetry, onHangUp, leaving }: {
  bot: Bot;
  snap: CallSnapshot;
  session: VoiceCallSession;
  wave: WaveSource;
  transcript: boolean;
  voice: CallVoiceId;
  speed: number;
  account: string | null;
  onRetry: () => void;
  onHangUp: () => void;
  leaving: boolean;
}) {
  const [menu, setMenu] = useState<"closed" | "open" | "closing">("closed");
  const root = useRef<HTMLDivElement>(null);
  const gear = useRef<HTMLButtonElement>(null);
  const face = useRef<HTMLDivElement>(null);
  const motion = useRef({ bob: 0, tilt: 0, last: 0 });
  const narrow = useNarrow();
  const status = statusText(snap, bot.name, narrow);
  const failed = snap.phase === "error";
  const live = !status;
  const botColor = `var(--identity-${bot.color ?? "green"})`;

  const closeMenu = useCallback((focusGear = false) => {
    setMenu((now) => (now === "open" ? "closing" : now));
    if (focusGear) gear.current?.focus();
  }, []);
  useEffect(() => {
    if (menu !== "closing") return;
    const timer = setTimeout(() => setMenu("closed"), LEAVE_MS);
    return () => clearTimeout(timer);
  }, [menu]);
  useEffect(() => {
    if (menu !== "open") return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) closeMenu();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeMenu(true);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape, true);
    };
  }, [menu, closeMenu]);

  // The mascot talks with the bot's voice (a small bounce and squash on its loudness) and leans in while the person talks.
  const onFrame = useCallback((frame: WaveFrame) => {
    const el = face.current;
    if (!el) return;
    const now = performance.now();
    const state = motion.current;
    const dt = state.last ? Math.min(64, now - state.last) : 16;
    state.last = now;
    state.bob = ease(state.bob, frame.bot * frame.level, dt, 45);
    state.tilt = ease(state.tilt, frame.person > 0.3 ? 1 : 0, dt, 160);
    const lift = state.bob * 3.2;
    el.style.transform = `translateY(${(-lift).toFixed(2)}px) rotate(${(-7 * state.tilt).toFixed(2)}deg) scale(${(1 + state.bob * 0.05).toFixed(3)}, ${(1 - state.bob * 0.035).toFixed(3)})`;
  }, []);

  return (
    <div
      ref={root}
      role="region"
      aria-label={t("call.callWith", { name: bot.name })}
      data-voice-call={snap.phase}
      data-turn-ms={snap.lastTurn ? `${snap.lastTurn.endpoint},${snap.lastTurn.transcribed},${snap.lastTurn.sent},${snap.lastTurn.firstAudio}` : undefined}
      className={cn("voice-call-pill pointer-events-auto relative flex h-[52px] max-w-full items-center gap-1 rounded-full py-1.5 pl-1.5 pr-1.5 text-ink sm:h-14 sm:gap-1.5 sm:py-2 sm:pl-2 sm:pr-2", TONE, leaving && "voice-call-pill-out")}
    >
      <div ref={face} data-call-face="" className="shrink-0 origin-bottom will-change-transform">
        <BotAvatar bot={bot} size={narrow ? 32 : 40} state={mascotMood(snap)} animated />
      </div>
      <div data-call-wave="" className={cn("relative flex h-10 items-center justify-center px-1.5 sm:px-2", live ? "min-w-[104px] sm:min-w-[150px]" : "min-w-0")} aria-live="polite">
        {live ? (
          <span key="wave" className="voice-call-swap flex items-center">
            <VoiceCallWave source={wave} bars={narrow ? 16 : 26} botColor={botColor} onFrame={onFrame} />
            <span className="sr-only">{phaseLabel(snap, bot.name)}</span>
          </span>
        ) : (
          <span key={status} className={cn("voice-call-swap max-w-[270px] text-[13px] tabular-nums", narrow ? "line-clamp-2 leading-4" : "truncate", failed ? "text-ink" : "text-ink-secondary")} title={snap.error?.message ?? status}>
            {status}
          </span>
        )}
      </div>
      {failed && snap.error?.kind === "microphone-blocked" && <OpenSystemSettings pane="mic" />}
      {failed && snap.error?.kind !== "microphone-blocked" && (
        <RoundButton label={t("call.voice.retry")} className={BUTTON_TONE} onClick={onRetry}>
          <RotateCcw size={17} />
        </RoundButton>
      )}
      <RoundButton
        buttonRef={gear}
        label={t("call.live.settings")}
        expanded={menu === "open"}
        popup="dialog"
        className={menu === "open" ? "bg-ink/[0.12] text-ink" : BUTTON_TONE}
        onClick={() => (menu === "open" ? closeMenu() : setMenu("open"))}
      >
        <Settings size={18} />
      </RoundButton>
      <RoundButton
        label={transcript ? t("call.voice.transcriptHide") : t("call.voice.transcriptShow")}
        pressed={transcript}
        className={transcript ? "bg-ink/[0.12] text-ink" : BUTTON_TONE}
        onClick={() => setCallPrefs({ transcript: !transcript })}
      >
        <MessageSquareText size={18} />
      </RoundButton>
      <RoundButton
        label={snap.muted ? t("call.live.unmute") : t("call.live.mute")}
        pressed={snap.muted}
        filled={snap.muted}
        className={snap.muted ? "bg-ink text-app hover:opacity-90" : BUTTON_TONE}
        onClick={() => session.setMuted(!snap.muted)}
      >
        {snap.muted ? <MicOff size={18} /> : <Mic size={18} />}
      </RoundButton>
      <RoundButton label={t("call.live.hangUp")} filled className="bg-danger text-white hover:brightness-110" onClick={onHangUp}>
        <PhoneOff size={18} />
      </RoundButton>
      {menu !== "closed" && (
        <CallSettings
          closing={menu === "closing"}
          narrow={narrow}
          account={account}
          voice={voice === "account" && !account ? "af_heart" : voice}
          speed={speed}
          onVoice={(id) => {
            haptic("pick");
            setCallPrefs({ voices: { ...callPrefs().voices, [bot.id]: id } });
            session.setVoice(id, speed);
            session.preview(t("call.voice.previewLine", { name: bot.name }));
          }}
          onSpeed={(value) => {
            haptic("pick");
            setVoicePrefs(bot.id, { speed: String(value) });
            session.setVoice(voice, value);
            session.preview(t("call.voice.previewLine", { name: bot.name }));
          }}
        />
      )}
    </div>
  );
}

function CallSettings({ voice, speed, closing, narrow, account, onVoice, onSpeed }: {
  voice: CallVoiceId;
  speed: number;
  closing: boolean;
  /** A phone-width pill has no room left of the gear: the menu sits over the pill's left edge instead. */
  narrow: boolean;
  /** The voice service set up in Settings, when there is one with a voice ready. */
  account: string | null;
  onVoice: (id: CallVoiceId) => void;
  onSpeed: (value: number) => void;
}) {
  const speedRef = useRef<HTMLDivElement>(null);
  const speedIndex = Math.max(0, CALL_SPEEDS.findIndex((entry) => entry.value === speed));
  const systemSpeed = useSystemControl(
    speedRef,
    {
      kind: "segmented",
      items: CALL_SPEEDS.map((entry) => t(entry.label)),
      selected: speedIndex,
      label: t("call.voice.speed"),
    },
    (index) => {
      const picked = typeof index === "number" ? CALL_SPEEDS[index] : undefined;
      if (picked && picked.value !== speed) onSpeed(picked.value);
    },
  );
  return (
    <div
      role="dialog"
      aria-label={t("call.live.settings")}
      style={narrow ? { transformOrigin: "bottom left" } : undefined}
      className={cn(
        "voice-call-menu absolute bottom-full mb-2 w-[248px] rounded-2xl p-1.5 text-left",
        narrow ? "left-0" : "right-[126px] sm:right-[146px]",
        "bg-[color-mix(in_srgb,var(--color-ink)_6%,var(--color-app))]",
        closing && "voice-call-menu-out",
      )}
    >
      <div className="px-2.5 pb-1 pt-1.5 text-[12px] font-medium text-ink-secondary">{t("call.voice.voice")}</div>
      <div role="radiogroup" aria-label={t("call.voice.voice")} className="grid grid-cols-2 gap-0.5">
        {account && (
          <button
            type="button"
            role="radio"
            aria-checked={voice === ACCOUNT_VOICE}
            onClick={() => onVoice(ACCOUNT_VOICE)}
            className={cn("voice-call-press col-span-2 flex items-center justify-between rounded-lg px-2.5 py-1.5 text-[13px] text-ink hover:bg-ink/[0.06]", voice === ACCOUNT_VOICE && "bg-ink/[0.08]")}
          >
            {t("call.voice.account", { provider: account })}
            {voice === ACCOUNT_VOICE && <Check size={13} className="text-ink" aria-hidden="true" />}
          </button>
        )}
        {CALL_VOICES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="radio"
            aria-checked={voice === entry.id}
            onClick={() => onVoice(entry.id)}
            className={cn("voice-call-press flex items-center justify-between rounded-lg px-2.5 py-1.5 text-[13px] text-ink hover:bg-ink/[0.06]", voice === entry.id && "bg-ink/[0.08]")}
          >
            {entry.label}
            {voice === entry.id && <Check size={13} className="text-ink" aria-hidden="true" />}
          </button>
        ))}
      </div>
      <div className="px-2.5 pb-1 pt-2.5 text-[12px] font-medium text-ink-secondary">{t("call.voice.speed")}</div>
      {systemSpeed ? (
        <div ref={speedRef} aria-hidden="true" data-segmented-room="" className="h-9 w-full" />
      ) : (
        <div
          role="radiogroup"
          aria-label={t("call.voice.speed")}
          data-segmented=""
          style={{ "--seg-count": CALL_SPEEDS.length, "--seg-index": speedIndex } as CSSProperties}
          className="flex gap-0.5 rounded-xl bg-ink/[0.06] p-0.5"
        >
          {CALL_SPEEDS.map((entry) => (
            <button
              key={entry.value}
              type="button"
              role="radio"
              aria-checked={speed === entry.value}
              aria-pressed={speed === entry.value}
              onClick={() => onSpeed(entry.value)}
              className={cn("voice-call-press flex-1 rounded-[10px] py-1.5 text-[12px] font-medium transition-colors", speed === entry.value ? "bg-app text-ink" : "text-ink-secondary hover:text-ink")}
            >
              {t(entry.label)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** What the person is saying, shown while they say it: it lands in the chat once it is sent. */
function HeardLine({ snap }: { snap: CallSnapshot }) {
  const text = snap.phase === "hearing" ? snap.heard : "";
  return (
    <div className={cn("voice-call-heard pointer-events-none max-w-[min(520px,90%)] truncate rounded-full px-3.5 py-1.5 text-[13px] text-ink-secondary [direction:rtl]", TONE, text ? "opacity-100" : "opacity-0")}>
      <bdi dir="ltr">{text || " "}</bdi>
    </div>
  );
}

/** Without the transcript, the chat steps back and the bot is the call. */
function CallStage({ bot, snap, leaving }: { bot: Bot; snap: CallSnapshot; leaving: boolean }) {
  return (
    <div className={cn("voice-call-stage absolute inset-0 z-[29] flex flex-col items-center justify-center gap-5 bg-app px-6 pb-24", leaving && "voice-call-dock-out")}>
      <BotAvatar bot={bot} size={168} state={mascotMood(snap)} animated trackPointer />
      <div className="text-[18px] font-medium text-ink">{bot.name}</div>
      <div key={snap.phase} className="voice-call-swap min-h-[3rem] max-w-[520px] text-center text-[15px] leading-relaxed text-ink-secondary">
        {snap.phase === "speaking" ? snap.caption : snap.phase === "hearing" ? snap.heard : phaseLabel(snap, bot.name)}
      </div>
    </div>
  );
}
