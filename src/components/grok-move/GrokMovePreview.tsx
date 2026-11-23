import { useId, useState } from "react";

import { cn } from "@/lib/cn";
import { sliceProblemText } from "@/lib/grok-bot-move";
import { t } from "@/lib/i18n";
import type { GrokDetection, GrokFoundBot, GrokMoveChoice } from "../../../shared/grok-move";
import { ChevronDown, CircleAlert } from "../../icons";
import { Toggle } from "../ui/Toggle";
import { BotFace, Chip, quietLinkCls, sectionLabelCls } from "./parts";

export interface BotChoice { on: boolean; chat: boolean; instructions: boolean }
export type Choices = Record<string, BotChoice>;

const canChat = (bot: GrokFoundBot) => bot.chat.readable && bot.chat.messages > 0;

/** Live bots not moved yet are chosen; one already here, or removed in Grok Bot, waits to be ticked. */
export function initialChoices(bots: readonly GrokFoundBot[]): Choices {
  return Object.fromEntries(bots.map((bot) => [bot.rosterId, { on: !bot.removed && !bot.here, chat: canChat(bot), instructions: bot.hasDescription }]));
}

export function chosen(bots: readonly GrokFoundBot[], choices: Choices): GrokMoveChoice[] {
  return bots.filter((bot) => choices[bot.rosterId]?.on).map((bot) => {
    const choice = choices[bot.rosterId]!;
    return { rosterId: bot.rosterId, chat: choice.chat && canChat(bot), instructions: choice.instructions && bot.hasDescription };
  });
}

function chips(bot: GrokFoundBot, problems: GrokDetection["problems"]) {
  const out: Array<{ key: string; text: string; tone?: "warn" | "done" }> = [];
  if (bot.here) out.push({ key: "here", text: t("grokBotMove.preview.here"), tone: "done" });
  out.push({ key: "profile", text: t("grokBotMove.chip.profile") });
  if (bot.hasDescription) out.push({ key: "instructions", text: t("grokBotMove.chip.instructions") });
  if (canChat(bot)) out.push({ key: "chat", text: bot.chat.messages === 1 ? t("grokBotMove.chip.messageOne") : t("grokBotMove.chip.messages", { count: bot.chat.messages }) });
  if (bot.routines) out.push({ key: "routines", text: bot.routines === 1 ? t("grokBotMove.chip.routineOne") : t("grokBotMove.chip.routines", { count: bot.routines }) });
  if (bot.appsUsed) out.push({ key: "appsUsed", text: bot.appsUsed === 1 ? t("grokBotMove.chip.appOne") : t("grokBotMove.chip.apps", { count: bot.appsUsed }) });
  for (const problem of problems.filter((one) => one.rosterId === bot.rosterId && one.slice === "chat")) {
    out.push({ key: `problem-${problem.code}`, text: sliceProblemText(problem), tone: "warn" });
  }
  return out;
}

function SwitchLine({ title, hint, checked, disabled, onChange, ...rest }: { title: string; hint: string; checked: boolean; disabled?: boolean; onChange: () => void; "data-grok-switch"?: string }) {
  const id = useId();
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="flex min-w-0 flex-1 flex-col">
        <span id={id} className="text-[13px] leading-[18px] text-ink">{title}</span>
        <span className="text-pretty text-[12px] leading-4 text-ink-secondary">{hint}</span>
      </span>
      <Toggle {...rest} aria-labelledby={id} checked={checked} disabled={disabled} onClick={onChange} className="mt-0.5" />
    </div>
  );
}

function BotRow({ bot, choice, problems, onChange }: { bot: GrokFoundBot; choice: BotChoice; problems: GrokDetection["problems"]; onChange: (next: BotChoice) => void }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const checkId = useId();
  const chat = canChat(bot);
  return (
    <li data-grok-bot={bot.rosterId} data-grok-chosen={choice.on ? "" : undefined} className="rounded-[12px] transition-colors duration-150 ease-[ease] hover:bg-ink/[0.025] motion-reduce:transition-none">
      <div className="flex min-w-0 items-start gap-3 px-2 py-2.5">
        <input id={checkId} type="checkbox" checked={choice.on} onChange={(event) => onChange({ ...choice, on: event.target.checked })}
          aria-label={bot.here ? t("grokBotMove.preview.updateBot", { name: bot.label }) : t("grokBotMove.preview.moveBot", { name: bot.label })}
          className="mt-2 size-4 shrink-0 cursor-pointer accent-[var(--color-ink)]" />
        <label htmlFor={checkId} className="shrink-0 cursor-pointer"><BotFace look={bot.look} /></label>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor={checkId} className="flex min-w-0 cursor-pointer flex-col">
            <span className="truncate text-[14px] font-medium leading-5 text-ink">{bot.label}</span>
            <span className="truncate text-[12px] leading-4 text-ink-secondary">{bot.description || t("grokBotMove.preview.noDescription")}</span>
          </label>
          <span className="flex flex-wrap gap-1">
            {chips(bot, problems).map((chip) => <Chip key={chip.key} data-grok-chip={chip.key} tone={chip.tone}>{chip.text}</Chip>)}
          </span>
        </div>
        <button type="button" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen((was) => !was)}
          aria-label={t("grokBotMove.preview.choose", { name: bot.label })} title={t("grokBotMove.preview.choose", { name: bot.label })}
          className="mt-1 grid size-7 shrink-0 place-items-center rounded-full text-ink-tertiary transition-colors duration-150 ease-[ease] hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus motion-reduce:transition-none">
          <ChevronDown size={14} aria-hidden="true" className={cn("transition-transform duration-200 ease-[var(--dusk-ease-out)] motion-reduce:transition-none", open && "rotate-180")} />
        </button>
      </div>
      <div id={detailsId} inert={!open} className={cn("grid transition-[grid-template-rows,opacity] duration-[240ms] ease-[var(--dusk-ease-out)] motion-reduce:transition-none", open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}>
        <div className="min-h-0 overflow-hidden">
          <div className="mb-2 ms-[60px] me-2 flex flex-col border-t border-ink/[0.06] pt-1">
            <SwitchLine data-grok-switch="chat" title={t("grokBotMove.preview.chatTitle")} checked={chat && choice.chat} disabled={!chat || !choice.on}
              hint={!chat ? t("grokBotMove.preview.chatNone")
                : bot.chat.earlier ? t("grokBotMove.preview.chatEarlier", { count: bot.chat.messages }) : t("grokBotMove.preview.chatAll", { count: bot.chat.messages })}
              onChange={() => onChange({ ...choice, chat: !choice.chat })} />
            <SwitchLine data-grok-switch="instructions" title={t("grokBotMove.preview.instructionsTitle")} checked={bot.hasDescription && choice.instructions}
              disabled={!bot.hasDescription || !choice.on}
              hint={bot.hasDescription ? t("grokBotMove.preview.instructionsHint") : t("grokBotMove.preview.instructionsNone")}
              onChange={() => onChange({ ...choice, instructions: !choice.instructions })} />
          </div>
        </div>
      </div>
    </li>
  );
}

/** Screen 1: what was found, each bot with what can come now, and the choice. Nothing is written here. */
export function GrokMovePreview({ detection, choices, onChoices }: { detection: GrokDetection; choices: Choices; onChoices: (next: Choices) => void }) {
  const [removedOpen, setRemovedOpen] = useState(false);
  const removedId = useId();
  const live = detection.bots.filter((bot) => !bot.removed);
  const removed = detection.bots.filter((bot) => bot.removed);
  const set = (rosterId: string, next: BotChoice) => onChoices({ ...choices, [rosterId]: next });
  const allOn = live.length > 0 && live.every((bot) => choices[bot.rosterId]?.on);
  const setAll = (on: boolean) => onChoices(Object.fromEntries(Object.entries(choices).map(([id, choice]) => [id, { ...choice, on: on && live.some((bot) => bot.rosterId === id) }])));
  const general = detection.problems.filter((problem) => problem.slice !== "chat" && problem.slice !== "photo");
  const row = (bot: GrokFoundBot) => <BotRow key={bot.rosterId} bot={bot} choice={choices[bot.rosterId] ?? { on: false, chat: false, instructions: false }} problems={detection.problems} onChange={(next) => set(bot.rosterId, next)} />;

  return (
    <div data-grok-screen="preview" className="flex flex-col gap-3">
      {general.map((problem) => (
        <p key={`${problem.slice}-${problem.code}`} role="note" data-grok-problem={problem.slice} className="m-0 flex items-start gap-2 rounded-[12px] bg-ink/[0.04] px-3 py-2 text-[12px] leading-4 text-ink-secondary">
          <CircleAlert size={14} aria-hidden="true" className="mt-px shrink-0" /><span className="text-pretty">{sliceProblemText(problem)}</span>
        </p>
      ))}
      {live.length > 0 && (
        <section aria-labelledby={`${removedId}-live`}>
          <div className="mb-1 flex items-center justify-between gap-2">
            <h3 id={`${removedId}-live`} className={cn(sectionLabelCls, "mb-0")}>{t("grokBotMove.preview.yourBots")}</h3>
            <button type="button" data-grok-all={allOn ? "none" : "all"} onClick={() => setAll(!allOn)} className={quietLinkCls}>
              {allOn ? t("grokBotMove.preview.selectNone") : t("grokBotMove.preview.selectAll")}
            </button>
          </div>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">{live.map(row)}</ul>
        </section>
      )}
      {removed.length > 0 && (
        <section>
          <button type="button" data-grok-removed="" aria-expanded={removedOpen} aria-controls={removedId} onClick={() => setRemovedOpen((was) => !was)} className={cn(quietLinkCls, "ms-1")}>
            <span>{removed.length === 1 ? t("grokBotMove.preview.removedOne") : t("grokBotMove.preview.removed", { count: removed.length })}</span>
            <ChevronDown size={14} aria-hidden="true" className={cn("transition-transform duration-200 ease-[var(--dusk-ease-out)] motion-reduce:transition-none", removedOpen && "rotate-180")} />
          </button>
          <ul id={removedId} hidden={!removedOpen} className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0">{removed.map(row)}</ul>
        </section>
      )}
    </div>
  );
}
