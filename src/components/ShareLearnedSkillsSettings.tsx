import { useRef, useState, type CSSProperties } from "react";

import { cn } from "@/lib/cn";
import { shareLearnedSkillsMode, skillAuthoringEnabled, skillsLibraryEnabled } from "@/lib/feature-flags";
import { t } from "@/lib/i18n";
import { useSystemControl } from "@/lib/system-control";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { SkillReviewSettings } from "./SkillReviewSettings";
import { friendlyError } from "@/lib/plain-error";

const MODES = [
  { value: "off", label: "settings.experimental.shareSkillsOff" },
  { value: "ask", label: "settings.experimental.shareSkillsAsk" },
  { value: "auto", label: "settings.experimental.shareSkillsAuto" },
] as const;

export function ShareLearnedSkillsSettings() {
  const { state, dispatch } = useStore();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const room = useRef<HTMLDivElement>(null);
  const shown = skillsLibraryEnabled(state.config);
  const authoring = skillAuthoringEnabled(state.config);
  const mode = shareLearnedSkillsMode(state.config);
  const selected = Math.max(0, MODES.findIndex((option) => option.value === mode));

  const choose = async (next: (typeof MODES)[number]["value"]) => {
    if (saving || next === mode) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features: { shareLearnedSkills: next } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(friendlyError(cause, t("settings.experimental.error")));
    } finally {
      setSaving(false);
    }
  };

  const system = useSystemControl(
    room,
    shown
      ? {
          kind: "segmented",
          items: MODES.map((option) => t(option.label)),
          selected,
          disabled: saving || !authoring,
          label: t("settings.experimental.shareSkillsAria"),
        }
      : null,
    (index) => {
      const picked = typeof index === "number" ? MODES[index] : undefined;
      if (picked && picked.value !== mode) void choose(picked.value);
    },
  );
  if (!shown) return null;

  return (
    <div className="mt-4 border-t border-transparent pt-4" data-testid="share-learned-skills-settings">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] leading-[18px] text-ink">{t("settings.experimental.shareSkills")}</div>
          {!authoring && <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{t("settings.experimental.shareSkillsNeedsAuthoring")}</div>}
        </div>
        {system ? (
          <div ref={room} aria-hidden="true" data-segmented-room="" className="inline-flex h-9 shrink-0 items-center">
            {MODES.map((option) => (
              <span key={option.value} className="invisible whitespace-nowrap px-3.5 text-[15px] font-medium">{t(option.label)}</span>
            ))}
          </div>
        ) : (
          <div
            className="inline-flex shrink-0 rounded-xl bg-inset p-1"
            role="radiogroup"
            aria-label={t("settings.experimental.shareSkillsAria")}
            data-segmented=""
            style={{ "--seg-count": MODES.length, "--seg-index": selected } as CSSProperties}
          >
            {MODES.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={mode === option.value}
                aria-pressed={mode === option.value}
                disabled={saving || !authoring}
                onClick={() => void choose(option.value)}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                  mode === option.value ? "bg-raised text-ink shadow" : "text-ink-secondary hover:text-ink",
                )}
              >
                {t(option.label)}
              </button>
            ))}
          </div>
        )}
      </div>
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
    </div>
  );
}

export function LearnedSkillsSettings() {
  return (
    <>
      <SkillReviewSettings />
      <ShareLearnedSkillsSettings />
    </>
  );
}
