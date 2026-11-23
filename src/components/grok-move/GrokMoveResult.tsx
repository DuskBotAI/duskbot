import { useEffect, useId, useState, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import { appliedNeeds, appliedParts, grokProblemText } from "@/lib/grok-bot-move";
import { t } from "@/lib/i18n";
import type { GrokFoundBot, GrokMoveBotProgress, GrokMoveProgress, GrokMovedCounts, GrokUndoPreview, GrokUndoResult, GrokWaitingBot } from "../../../shared/grok-move";
import { Check, CircleAlert } from "../../icons";
import { mdPrimaryCls, mdSecondaryCls, rowButtonCls } from "../ui/GrokDialog";
import { ProgressRow } from "./GrokMoveProgress";
import { BotFace, Breath, listOf, quietLinkCls, rowCardCls, sectionLabelCls } from "./parts";

const countedParts = (moved: GrokMovedCounts): string[] => [
  t("grokBotMove.result.profile"),
  ...(moved.picture ? [t("grokBotMove.result.picture")] : []),
  ...(moved.instructions ? [t("grokBotMove.chip.instructions")] : []),
  ...(moved.messages ? [moved.messages === 1 ? t("grokBotMove.chip.messageOne") : t("grokBotMove.chip.messages", { count: moved.messages })] : []),
  ...(moved.routineNames ? [moved.routineNames === 1 ? t("grokBotMove.chip.routineOne") : t("grokBotMove.chip.routines", { count: moved.routineNames })] : []),
  ...(moved.appsUsed ? [moved.appsUsed === 1 ? t("grokBotMove.chip.appOne") : t("grokBotMove.chip.apps", { count: moved.appsUsed })] : []),
];

/** The person's own Ask for one bot: what this window opened or could not, kept while the window is open. */
export interface AskState { opened: boolean; copied?: boolean }

export interface AskActions {
  ask: (rosterId: string) => void;
  copy: (rosterId: string) => void;
}

/** The one-consent walk: `order` is the bots to ask in turn, `index` the one being asked now. */
export interface AskWalk { order: string[]; index: number }

/** One consent, then dusk bot opens each bot in turn; the person presses Enter in each Grok Bot window. The per-bot Ask
 * buttons below stay as the fallback and for anything the walk could not get. */
function WalkBanner({ walk, order, nameOf, onStart, onStop }: {
  walk: AskWalk | null;
  order: string[];
  nameOf: (rosterId: string) => string;
  onStart: (order: string[]) => void;
  onStop: () => void;
}) {
  const [consent, setConsent] = useState(false);
  if (walk) {
    const current = walk.order[Math.min(walk.index, walk.order.length - 1)]!;
    return (
      <div data-grok-walk="asking" className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[12px] bg-ink/[0.04] px-3 py-2.5 text-[12px] leading-4 text-ink">
        <span className="flex min-w-0 flex-1 items-start gap-2"><span className="flex h-4 shrink-0 items-center"><Breath /></span>
          <span data-grok-walk-progress="" className="text-pretty">{t("grokBotMove.walk.asking", { name: nameOf(current), done: walk.index + 1, total: walk.order.length })}</span></span>
        <button type="button" data-grok-walk-stop="" onClick={onStop} className={rowButtonCls}>{t("grokBotMove.walk.stop")}</button>
      </div>
    );
  }
  if (order.length < 2) return null;
  if (!consent) {
    return (
      <div data-grok-walk="idle" className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[12px] bg-ink/[0.04] px-3 py-2.5 text-[12px] leading-4 text-ink-secondary">
        <span className="min-w-0 flex-1 text-pretty">{t("grokBotMove.walk.offer", { count: order.length })}</span>
        <button type="button" data-grok-walk-start="" onClick={() => setConsent(true)} className={rowButtonCls}>{t("grokBotMove.walk.start")}</button>
      </div>
    );
  }
  return (
    <div data-grok-walk="consent" className="mb-2 flex flex-col gap-2 rounded-[12px] bg-ink/[0.04] px-3 py-2.5">
      <p className="m-0 text-[12px] font-medium leading-4 text-ink">{t("grokBotMove.walk.consentTitle")}</p>
      <p data-grok-walk-consent="" className="m-0 text-pretty text-[12px] leading-4 text-ink-secondary">{t("grokBotMove.walk.consentLine")}</p>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button type="button" data-grok-walk-cancel="" onClick={() => setConsent(false)} className={mdSecondaryCls}>{t("grokBotMove.walk.cancel")}</button>
        <button type="button" data-grok-walk-go="" onClick={() => { setConsent(false); onStart(order); }} className={mdPrimaryCls}>{t("grokBotMove.walk.go")}</button>
      </div>
    </div>
  );
}

function Section({ title, children, ...rest }: { title: string; children: ReactNode; "data-grok-section"?: string }) {
  const id = useId();
  return (
    <section {...rest} aria-labelledby={id} className="flex flex-col">
      <h3 id={id} className={sectionLabelCls}>{title}</h3>
      {children}
    </section>
  );
}

function AskRow({ bot, found, waiting, ask, actions }: { bot: GrokMoveBotProgress; found?: GrokFoundBot; waiting?: GrokWaitingBot; ask?: AskState; actions: AskActions }) {
  const name = bot.name;
  const state = waiting?.state ?? (ask ? "waiting" : "none");
  let line: ReactNode;
  let buttons: ReactNode = null;
  const copyButton = (
    <button type="button" data-grok-copy={bot.rosterId} onClick={() => actions.copy(bot.rosterId)} className={quietLinkCls}>
      {ask?.copied ? <><Check size={13} aria-hidden="true" />{t("grokBotMove.ask.copied")}</> : t("grokBotMove.ask.copy")}
    </button>
  );
  if (state === "arrived" && waiting?.applied) {
    const needs = appliedNeeds(waiting.applied);
    const parts = appliedParts(waiting.applied);
    line = (
      <>
        <span className="flex items-start gap-1.5 text-ink"><Check size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span className="text-pretty">{parts.length ? t("grokBotMove.ask.got", { list: listOf(parts) }) : t("grokBotMove.ask.gotNothing")}</span></span>
        {needs.length > 0 && <span className="ps-5 text-pretty text-ink-secondary">{t("grokBotMove.ask.needs", { list: listOf(needs) })}</span>}
      </>
    );
  } else if (state === "problem" && waiting?.problem) {
    line = (
      <span className="flex items-start gap-1.5 text-danger"><CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
        <span className="text-pretty">{t("grokBotMove.ask.problem", { file: waiting.problem.file, why: grokProblemText(waiting.problem) })}</span></span>
    );
    buttons = <><button type="button" data-grok-ask={bot.rosterId} onClick={() => actions.ask(bot.rosterId)} className={rowButtonCls}>{t("grokBotMove.ask.again")}</button>{copyButton}</>;
  } else if (state === "waiting") {
    line = (
      <span className="flex items-start gap-2 text-ink-secondary"><span className="flex h-4 shrink-0 items-center"><Breath /></span>
        <span className="text-pretty">{ask && !ask.opened ? t("grokBotMove.ask.notOpened", { name }) : t("grokBotMove.ask.waiting", { name })}</span></span>
    );
    buttons = <><button type="button" data-grok-open={bot.rosterId} onClick={() => actions.ask(bot.rosterId)} className={quietLinkCls}>{t("grokBotMove.ask.openAgain")}</button>{copyButton}</>;
  } else {
    return (
      <li data-grok-ask-row={bot.rosterId} data-grok-ask-state="none" className="flex min-w-0 items-center gap-3 px-2 py-2">
        {found ? <BotFace look={found.look} size={28} /> : <span aria-hidden="true" className="size-7 shrink-0 rounded-full bg-ink/[0.06]" />}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-[18px] text-ink">{name}</span>
        <button type="button" data-grok-ask={bot.rosterId} onClick={() => actions.ask(bot.rosterId)} className={cn(rowButtonCls, "max-w-[60%] truncate")}>{t("grokBotMove.ask.button", { name })}</button>
      </li>
    );
  }
  return (
    <li data-grok-ask-row={bot.rosterId} data-grok-ask-state={state} className="flex min-w-0 items-start gap-3 px-2 py-2.5">
      {found ? <BotFace look={found.look} size={28} /> : <span aria-hidden="true" className="size-7 shrink-0 rounded-full bg-ink/[0.06]" />}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-[13px] font-medium leading-[18px] text-ink">{name}</span>
        {line && <span role="status" aria-live="polite" className="flex flex-col gap-0.5 text-[12px] leading-4">{line}</span>}
        {buttons && <span className="-ms-2 flex flex-wrap items-center gap-1">{buttons}</span>}
      </span>
    </li>
  );
}

/** Screen 3: what moved, what each bot can still send from Grok Bot, and what stayed there on purpose. */
export function GrokMoveResultView({ progress, found, waiting, asks, actions, walk, onWalkStart, onWalkStop, onRetry, onRest, onApps, onUndo }: {
  progress: GrokMoveProgress;
  found: ReadonlyMap<string, GrokFoundBot>;
  waiting: readonly GrokWaitingBot[];
  asks: Readonly<Record<string, AskState>>;
  actions: AskActions;
  walk: AskWalk | null;
  onWalkStart: (order: string[]) => void;
  onWalkStop: () => void;
  onRetry: (rosterIds: string[]) => void;
  /** A stopped or cut-off move: the bots it did not reach. */
  onRest: (rosterIds: string[]) => void;
  onApps: () => void;
  onUndo: () => void;
}) {
  const done = progress.bots.filter((bot) => bot.state === "done" && bot.botId);
  const failed = progress.bots.filter((bot) => bot.state === "failed");
  const left = progress.bots.filter((bot) => bot.state === "queued" || bot.state === "stopped" || bot.state === "moving");
  const apps = progress.result?.apps ?? [];
  const earlier = progress.result?.earlierChats ?? done.filter((bot) => bot.moved?.earlier).length;
  const byRoster = new Map(waiting.map((entry) => [entry.rosterId, entry]));
  const awaited = done.filter((bot) => byRoster.get(bot.rosterId)?.state === "waiting").length;
  // The walk asks every moved bot that has not already sent its file; a bot refused before is asked again.
  const toAsk = done.filter((bot) => byRoster.get(bot.rosterId)?.state !== "arrived").map((bot) => bot.rosterId);
  const nameOf = (rosterId: string) => done.find((bot) => bot.rosterId === rosterId)?.name ?? rosterId;

  return (
    <div data-grok-screen="result" className="flex flex-col gap-5">
      {left.length > 0 && (
        <div role="note" data-grok-left={progress.state} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[12px] bg-ink/[0.04] px-3 py-2.5 text-[12px] leading-4 text-ink-secondary">
          <span className="min-w-0 flex-1 text-pretty">{progress.state === "interrupted"
            ? t("grokBotMove.result.interrupted", { count: left.length })
            : t("grokBotMove.result.stoppedLeft", { count: left.length })}</span>
          <button type="button" data-grok-rest="" onClick={() => onRest(left.map((bot) => bot.rosterId))} className={rowButtonCls}>{t("grokBotMove.result.moveRest")}</button>
        </div>
      )}
      <Section title={t("grokBotMove.result.movedTitle")} data-grok-section="moved">
        <ul className={cn(rowCardCls, "m-0 list-none gap-0 p-1")}>
          {done.map((bot) => (
            <li key={bot.rosterId} data-grok-row={bot.rosterId} data-grok-state="done" className="flex min-w-0 items-center gap-3 px-2 py-2">
              {found.get(bot.rosterId) ? <BotFace look={found.get(bot.rosterId)!.look} size={28} /> : <span aria-hidden="true" className="size-7 shrink-0 rounded-full bg-ink/[0.06]" />}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13px] font-medium leading-[18px] text-ink">{bot.name}</span>
                <span className="text-pretty text-[12px] leading-4 text-ink-secondary">
                  {bot.moved ? `${bot.update ? `${t("grokBotMove.result.updatedPrefix")} ` : ""}${listOf(countedParts(bot.moved))}` : t("grokBotMove.progress.done")}
                </span>
              </span>
            </li>
          ))}
          {failed.map((bot) => <ProgressRow key={bot.rosterId} bot={bot} found={found.get(bot.rosterId)} onRetry={() => onRetry([bot.rosterId])} />)}
          {done.length === 0 && failed.length === 0 && <li className="px-2 py-2 text-[12px] leading-4 text-ink-secondary">{t("grokBotMove.result.noneMoved")}</li>}
        </ul>
      </Section>
      {done.length > 0 && (
        <Section title={t("grokBotMove.rest.title")} data-grok-section="rest">
          <p className="m-0 mb-2 px-1 text-pretty text-[12px] leading-4 text-ink-secondary">
            {t("grokBotMove.rest.intro")}{awaited > 0 && <> {awaited === 1 ? t("grokBotMove.rest.waitingOne") : t("grokBotMove.rest.waiting", { count: awaited })}</>}
          </p>
          <WalkBanner walk={walk} order={toAsk} nameOf={nameOf} onStart={onWalkStart} onStop={onWalkStop} />
          <ul className={cn(rowCardCls, "m-0 list-none gap-0 p-1")}>
            {done.map((bot) => <AskRow key={bot.rosterId} bot={bot} found={found.get(bot.rosterId)} waiting={byRoster.get(bot.rosterId)} ask={asks[bot.rosterId]} actions={actions} />)}
          </ul>
        </Section>
      )}
      <Section title={t("grokBotMove.stayed.title")} data-grok-section="stayed">
        <ul className="m-0 flex list-none flex-col gap-1.5 px-1 text-[12px] leading-4 text-ink-secondary">
          <li className="text-pretty">{t("grokBotMove.stayed.signIns")}</li>
          {apps.length > 0 && (
            <li className="text-pretty">
              {apps.length === 1 ? t("grokBotMove.stayed.appOne", { apps: apps[0]! }) : t("grokBotMove.stayed.apps", { count: apps.length, apps: listOf(apps) })}{" "}
              <button type="button" data-grok-apps="" onClick={onApps} className="rounded text-ink underline decoration-ink/25 underline-offset-2 hover:decoration-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus">{t("grokBotMove.stayed.openApps")}</button>
            </li>
          )}
          {earlier > 0 && <li className="text-pretty">{earlier === 1 ? t("grokBotMove.stayed.earlierOne") : t("grokBotMove.stayed.earlier", { count: earlier })}</li>}
          <li className="text-pretty">{t("grokBotMove.stayed.files")}</li>
        </ul>
      </Section>
      {done.length > 0 && (
        <div className="flex justify-start">
          <button type="button" data-grok-undo="" onClick={onUndo} className={cn(quietLinkCls, "text-danger hover:text-danger")}>{t("grokBotMove.undo.link")}</button>
        </div>
      )}
    </div>
  );
}

/** Undo, asked first: exactly what this move made, and which of those bots have had new messages since. */
export function GrokUndoView({ preview, result }: { preview: GrokUndoPreview | null; result: GrokUndoResult | null }) {
  if (result) {
    return (
      <div data-grok-screen="undone" className="flex flex-col gap-3">
        <p role="status" className="m-0 flex items-start gap-2 px-1 text-[13px] leading-[18px] text-ink">
          <Check size={15} aria-hidden="true" className="mt-px shrink-0" />
          <span className="text-pretty">{result.removedBots === 1 ? t("grokBotMove.undo.doneOne") : t("grokBotMove.undo.done", { count: result.removedBots })}</span>
        </p>
        {result.kept.map((bot) => (
          <p key={bot.botId} className="m-0 flex items-start gap-2 px-1 text-[12px] leading-4 text-danger">
            <CircleAlert size={14} aria-hidden="true" className="mt-px shrink-0" /><span className="text-pretty">{t("grokBotMove.undo.kept", { name: bot.name, why: bot.message })}</span>
          </p>
        ))}
      </div>
    );
  }
  if (!preview) return <p role="status" className="m-0 flex items-center gap-2 px-1 text-[13px] text-ink-secondary"><Breath />{t("grokBotMove.loading")}</p>;
  const busy = preview.bots.filter((bot) => bot.newMessages > 0);
  return (
    <div data-grok-screen="undo" className="flex flex-col gap-4">
      {busy.length > 0 && (
        <p role="alert" data-grok-undo-warn="" className="m-0 rounded-[12px] bg-danger/10 px-3 py-2.5 text-pretty text-[12px] leading-4 text-danger">
          <span>{busy.length === 1
            ? t("grokBotMove.undo.newMessagesOne", { name: busy[0]!.name, count: busy[0]!.newMessages })
            : t("grokBotMove.undo.newMessages", { names: listOf(busy.map((bot) => bot.name)) })}</span>
        </p>
      )}
      {preview.bots.length > 0 && (
        <Section title={preview.bots.length === 1 ? t("grokBotMove.undo.botsOne") : t("grokBotMove.undo.bots", { count: preview.bots.length })} data-grok-section="undo-bots">
          <ul className={cn(rowCardCls, "m-0 list-none gap-0 p-1")}>
            {preview.bots.map((bot) => (
              <li key={bot.botId} className="flex items-center justify-between gap-3 px-2 py-1.5 text-[13px] leading-[18px] text-ink">
                <span className="min-w-0 truncate">{bot.name}</span>
                {bot.newMessages > 0 && <span className="shrink-0 text-[12px] text-danger">{bot.newMessages === 1 ? t("grokBotMove.undo.oneNew") : t("grokBotMove.undo.someNew", { count: bot.newMessages })}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {preview.updated.length > 0 && (
        <p className="m-0 px-1 text-pretty text-[12px] leading-4 text-ink-secondary">{t("grokBotMove.undo.updated", { names: listOf(preview.updated.map((bot) => bot.name)) })}</p>
      )}
      <p className="m-0 px-1 text-pretty text-[12px] leading-4 text-ink-secondary">{t("grokBotMove.undo.grokKeeps")}</p>
    </div>
  );
}

/** Copied feedback that goes after a moment. */
export function useCopiedReset(asks: Record<string, AskState>, setAsks: (update: (was: Record<string, AskState>) => Record<string, AskState>) => void) {
  const copied = Object.entries(asks).filter(([, ask]) => ask.copied).map(([id]) => id).join(",");
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setAsks((was) => Object.fromEntries(Object.entries(was).map(([id, ask]) => [id, { ...ask, copied: false }]))), 2_000);
    return () => clearTimeout(timer);
  }, [copied, setAsks]);
}
