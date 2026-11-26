import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { MausState } from "@/lib/mascot";
import type { Bot } from "@/state/store";
import { BOT_PROFILE_LIMITS } from "../../../shared/bot-profile";
import { BotAvatar } from "../Avatar";
import { Icon } from "../Icon";
import type { BotPatch } from "../bot-settings/useBotSettingsDerived";

/** Grok's inline fields: no frame of their own, a 10% ink wash on hover, a 1px focus border while focused or editing. */
export const nameCls = "max-w-full rounded-lg border border-transparent px-2.5 py-0.5 text-center text-[17px] font-medium leading-6 tracking-[0.01em] text-ink transition-[border-color,background-color] duration-[120ms] ease-[ease] hover:bg-ink/[0.1]";

const HOVER_GAZE = { x: -1, y: 1 };

export function useInlineEdit(save: (value: string) => void) {
  const [draft, setDraft] = useState<string | null>(null);
  const settled = useRef(false);
  const refocus = useRef(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Enter and Escape take away the focused field: focus goes back to the button that opened it, not the page body.
  // A blur commit leaves focus where the person put it.
  useEffect(() => {
    if (draft !== null || !refocus.current) return;
    refocus.current = false;
    buttonRef.current?.focus();
  }, [draft]);
  const start = (value: string) => {
    settled.current = false;
    setDraft(value);
  };
  const commit = () => {
    if (draft !== null) save(draft);
    setDraft(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      settled.current = true;
      refocus.current = true;
      commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      settled.current = true;
      refocus.current = true;
      setDraft(null);
    }
  };
  const onBlur = () => {
    if (settled.current) return;
    commit();
  };
  return { draft, setDraft, start, onKeyDown, onBlur, buttonRef };
}

export function PanelHero({ bot, activeState, patch, editorOpen, onToggleEditor }: {
  bot: Bot;
  activeState: MausState;
  patch: (patch: BotPatch) => void;
  editorOpen: boolean;
  onToggleEditor: () => void;
}) {
  const name = useInlineEdit((value) => {
    const next = value.trim();
    if (next && next !== bot.name) patch({ name: next });
  });
  // grok's mascot looks at the pointer, so while the avatar is hovered its eyes sit low and centred, clear of the pencil
  const [hovered, setHovered] = useState(false);

  return (
    <div className="group/hero flex flex-col items-center text-center">
      <button
        type="button"
        data-panel-avatar
        aria-label={t("botPanel.avatar.edit")}
        title={t("botPanel.avatar.tip")}
        aria-expanded={editorOpen}
        onClick={onToggleEditor}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        className="group relative flex cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {/* grok darkens the mascot itself to 30% on hover, its eyes stay open holes, a 14px pencil sits on top */}
        <span className="flex transition-[filter] duration-[140ms] ease-[ease] group-hover:brightness-[0.3] group-focus-visible:brightness-[0.3] group-aria-expanded:brightness-[0.3] motion-reduce:transition-none">
          <BotAvatar bot={bot} size={64} state={activeState} gaze={hovered ? HOVER_GAZE : undefined} />
        </span>
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 flex items-center justify-center text-[#f5f5f5] opacity-0 transition-opacity duration-[140ms] ease-[ease] group-hover:opacity-100 group-focus-visible:opacity-100 group-focus-within:opacity-100 group-aria-expanded:opacity-100 touch:opacity-100 motion-reduce:transition-none"
        >
          <Icon name="pencil" size={14} />
        </span>
      </button>

      <div data-panel-name-row className="mt-4 flex max-w-full flex-col items-center gap-1">
        <h2 className="flex min-w-0 max-w-full justify-center">
          {name.draft !== null ? (
            <input
              autoFocus
              data-panel-rename-input
              aria-label={t("botPanel.ui.botSettingsSimpleName")}
              placeholder={t("botPanel.ui.botSettingsSimpleName")}
              maxLength={BOT_PROFILE_LIMITS.name}
              value={name.draft}
              onChange={(event) => name.setDraft(event.target.value)}
              onKeyDown={name.onKeyDown}
              onBlur={name.onBlur}
              className={cn(nameCls, "min-w-[2ch] border-focus outline-none [field-sizing:content]")}
            />
          ) : (
            <button
              ref={name.buttonRef}
              type="button"
              data-panel-rename
              title={t("rename.named", { name: bot.name })}
              onClick={() => name.start(bot.name)}
              className={cn(nameCls, "cursor-text truncate focus-visible:border-focus focus-visible:outline-none!")}
            >
              {bot.name}
            </button>
          )}
        </h2>

      </div>
    </div>
  );
}
