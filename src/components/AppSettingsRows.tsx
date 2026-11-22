import { useEffect, useState, type ReactNode } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { quickUpdatesEnabled, skillAuthoringEnabled } from "@/lib/feature-flags";
import { localeChoices } from "@/locales";
import { activeLocale, t, tOptional, tPreferred } from "@/lib/i18n";
import { SIMPLE_CARD, SettingRow, Switch } from "./SettingsPrimitives";
import { cn } from "@/lib/cn";
import { LearnedSkillsSettings } from "./ShareLearnedSkillsSettings";
import { effortLabel } from "./ModelPicker";
import { EFFORT_LEVELS, isEffortLevel } from "../../shared/wire";
import { parseSendKey, SEND_KEYS, sendKeyLabel, setSendKey, useSendKey } from "@/lib/send-key";
import { alternateSendLabel, parseFollowUpDefault, setFollowUpDefault, useFollowUpDefault } from "@/lib/follow-up";
import { effectiveLanguage, setLanguageChoice, useLanguageChoice } from "@/lib/language-preference";
import { SettingsSelect } from "./SettingsSelect";
import { TALKING_STYLES, talkingStyleOf } from "../../shared/talking-style";
import { friendlyError } from "@/lib/plain-error";
import {
  parseSidebarBotOrder, setSidebarBotOrder, setSidebarFeedbackHidden, useSidebarBotOrder, useSidebarFeedbackHidden,
} from "@/lib/sidebar-preferences";

export function NewBotEffortRow() {
  const { state, dispatch } = useStore();
  const current = state.config?.newBots?.effort ?? "";
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async (value: string) => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ newBots: { effort: isEffortLevel(value) ? value : null } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(friendlyError(cause, t("settings.newBotEffort.error")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow
      title={t("settings.newBotEffort.title")}
      message={error ? <p role="alert" className="text-danger">{error}</p> : null}
    >
      <SettingsSelect
        value={current}
        disabled={saving}
        aria-label={t("settings.newBotEffort.title")}
        onChange={(event) => void save(event.target.value)}
      >
        <option value="">{t("settings.newBotEffort.default")}</option>
        {EFFORT_LEVELS.map((level) => (
          <option key={level} value={level}>
            {effortLabel(level)}
          </option>
        ))}
      </SettingsSelect>
    </SettingRow>
  );
}

/** How every bot talks, the choice the first run offers: casual, warm (the default) or native. */
export function TalkingStyleRow() {
  const { state, dispatch } = useStore();
  const [saving, setSaving] = useState(false);
  // the pick shows at once and holds while it saves; the control never dims, so a click is one pill slide with no blink
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const save = async (value: string) => {
    if (saving) return;
    setSaving(true);
    setPending(talkingStyleOf(value));
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", { method: "PATCH", body: JSON.stringify({ talkingStyle: talkingStyleOf(value) }) });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setPending(null);
      setError(friendlyError(cause, t("settings.talkingStyle.error")));
    } finally {
      setSaving(false);
    }
  };
  // the pick lets go once the saved config shows it, so the pill never steps back for a render in between
  const saved = talkingStyleOf(state.config?.talkingStyle);
  useEffect(() => { if (pending === saved) setPending(null); }, [pending, saved]);
  return (
    <SettingRow icon="bubble" title={t("settings.talkingStyle.title")} subtitle={tOptional("settings.docs.talkingStyle.hint")} message={error ? <p role="alert" className="text-danger">{error}</p> : null}>
      <SettingsSelect
        variant="segmented"
        value={pending ?? saved}
        aria-label={t("settings.talkingStyle.title")}
        data-settings-select="talking-style"
        options={TALKING_STYLES.map((style) => ({ value: style, label: t(`settings.talkingStyle.${style}`) }))}
        onChange={(event) => void save(event.target.value)}
      />
    </SettingRow>
  );
}

export function QuickUpdatesRow() {
  const { state, dispatch } = useStore();
  const enabled = quickUpdatesEnabled(state.config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async (next: boolean) => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features: { quickUpdates: next } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(friendlyError(cause, t("settings.quickUpdates.error")));
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingRow
      icon="bolt"
      title={t("settings.quickUpdates.title")}
      subtitle={tPreferred("settings.docs.quickUpdates.hint", "settings.quickUpdates.subtitle")}
      message={error ? <p role="alert" className="text-danger">{error}</p> : null}
    >
      <Switch
        checked={enabled}
        aria-label={t("settings.quickUpdates.title")}
        disabled={saving}
        onClick={() => void save(!enabled)}
      />
    </SettingRow>
  );
}

/** Suggestions from the bots, on unless switched off here or per bot. */
export function SuggestionsRow() {
  const { state, dispatch } = useStore();
  const enabled = state.config?.features?.suggestions !== false;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async (next: boolean) => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", { method: "PATCH", body: JSON.stringify({ features: { suggestions: next } }) });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(friendlyError(cause, t("settings.suggestions.error")));
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingRow icon="sparkle" title={t("settings.suggestions.title")} subtitle={t("settings.suggestions.subtitle")}
      message={error ? <p role="alert" className="text-danger">{error}</p> : null}>
      <Switch checked={enabled} aria-label={t("settings.suggestions.title")} disabled={saving} onClick={() => void save(!enabled)} />
    </SettingRow>
  );
}

export function LanguageRow({ simple = false }: { simple?: boolean }) {
  const { state } = useStore();
  const current = effectiveLanguage(useLanguageChoice(), state.config?.language);

  return (
    <SettingRow
      icon="globe"
      title={t("settings.language.title")}
      subtitle={simple ? activeLocale() === "en" ? tOptional("settings.docs.language.hint") : t("settings.simple.language.partial") : t("settings.language.subtitle")}
    >
      <SettingsSelect
        value={current}
        aria-label={t(simple ? "settings.language.title" : "settings.language.aria")}
        onChange={(event) => setLanguageChoice(event.target.value)}
      >
        <option value="">{t(simple ? "settings.simple.language.system" : "settings.language.system")}</option>
        {localeChoices.map(({ code, label }) => (
          <option key={code} value={code}>
            {label}
          </option>
        ))}
      </SettingsSelect>
    </SettingRow>
  );
}

export function SendKeyRow({ simple = false }: { simple?: boolean }) {
  const sendKey = useSendKey();
  return (
    <SettingRow icon="enter" title={t("settings.sendKey.title")} subtitle={simple ? tOptional("settings.docs.sendKey.hint") : t("settings.sendKey.subtitle", { key: sendKeyLabel("mod-enter") })}>
      <SettingsSelect
        variant="segmented"
        value={sendKey}
        aria-label={t("settings.sendKey.title")}
        onChange={(event) => setSendKey(parseSendKey(event.target.value))}
      >
        {SEND_KEYS.map((mode) => (
          <option key={mode} value={mode}>{sendKeyLabel(mode)}</option>
        ))}
      </SettingsSelect>
    </SettingRow>
  );
}

/** Bots by their newest activity, or in the order the person dragged them into. */
export function BotOrderRow() {
  const order = useSidebarBotOrder();
  return (
    <SettingRow icon="stack" title={t("settings.botOrder.title")} subtitle={t("settings.botOrder.hint")}>
      <SettingsSelect value={order} aria-label={t("settings.botOrder.title")} onChange={(event) => setSidebarBotOrder(parseSidebarBotOrder(event.target.value))}>
        <option value="recent">{t("settings.botOrder.recent")}</option>
        <option value="custom">{t("settings.botOrder.custom")}</option>
      </SettingsSelect>
    </SettingRow>
  );
}

export function SidebarFeedbackRow() {
  const hidden = useSidebarFeedbackHidden();
  const title = t("settings.sidebarFeedback.title");
  return (
    <SettingRow icon="megaphone" title={title} subtitle={t("settings.sidebarFeedback.hint")}>
      <Switch
        checked={!hidden}
        aria-label={title}
        onClick={() => setSidebarFeedbackHidden(!hidden)}
      />
    </SettingRow>
  );
}

/** What Enter does with a message sent while a bot works. A setting, not a smart default: both are right, for different people. */
export function FollowUpRow({ simple = false }: { simple?: boolean }) {
  const followUp = useFollowUpDefault();
  const key = alternateSendLabel(useSendKey());
  return (
    <SettingRow icon="stack" title={t("settings.followUp.title")} subtitle={simple ? tOptional("settings.docs.followUp.hint") : t("settings.followUp.subtitle", { key })}>
      <SettingsSelect
        value={followUp}
        aria-label={t("settings.followUp.title")}
        onChange={(event) => setFollowUpDefault(parseFollowUpDefault(event.target.value))}
      >
        <option value="steer">{t("settings.followUp.steer")}</option>
        <option value="queue">{t("settings.followUp.queue")}</option>
      </SettingsSelect>
    </SettingRow>
  );
}

export function ExperimentalFeaturesRow({ lead }: { lead?: ReactNode }) {
  const { state, dispatch } = useStore();
  const skillAuthoring = skillAuthoringEnabled(state.config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const toggle = async (next: boolean) => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features: { skillAuthoring: next } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(friendlyError(cause, t("settings.experimental.error")));
    } finally {
      setSaving(false);
    }
  };

  return (
    // the sections below are shared with older screens: here they sit as plain rows, without their own rule and gap
    <div data-settings-rows="" className={cn(SIMPLE_CARD, "flex flex-col [&>[data-testid]]:mt-0 [&>[data-testid]]:border-t-0 [&>[data-testid]]:px-2 [&>[data-testid]]:py-1.5")}>
      {lead}
      <SettingRow title={t("settings.experimental.skillAuthoring")} message={error ? <span role="alert" className="text-danger">{error}</span> : null}>
        <Switch
          checked={skillAuthoring}
          aria-label={t("settings.experimental.skillAuthoringAria")}
          disabled={saving}
          onClick={() => void toggle(!skillAuthoring)}
        />
      </SettingRow>
      <LearnedSkillsSettings />
    </div>
  );
}

