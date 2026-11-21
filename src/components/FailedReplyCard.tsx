import { createContext, useMemo, useState } from "react";
import { t } from "@/lib/i18n";
import { botEngine, claudeUpdateTarget } from "@/lib/failed-turn";
import { blockerDetail, canOfferSignIn, currentFailureWords, failedReplyDetail, failedReplyKind, failedReplyTitle, mostActionable, restartAlreadyDid, trailingRows } from "@/lib/failed-reply";
import { statusActivity } from "@/lib/activity-runs";
import { lowerFirst } from "@/lib/lower-first";
import { resetTime } from "@/lib/limit-resets";
import { providerName } from "@/lib/simple-model-menu";
import { openPlaceAction, placeRowViewFor, usePlaceSeat, worksOnSimpleLabel } from "@/lib/place-view";
import { useStore, type Message, type ModelSelection } from "@/state/store";
import { failedTurnCause } from "../../shared/failed-turn";
import { failurePlan, type FailureAction } from "../../shared/failure-plan";
import { freeFallback } from "../../shared/ai-ranking";
import { engineReady } from "./EngineLibrary";
import { ConnectAiDialog } from "./onboarding/ConnectAi";
import { aiTileOf, type AiTileId } from "./onboarding/funnel";
import { CARD_ACTION, ChatErrorCard } from "./ChatErrorBanner";

// the card's second way on, next to its one main action: the same pill, without the fill until hovered
const QUIET_CARD_ACTION = "ui-button ui-button-sm ui-button-pill border-transparent bg-transparent text-ink-secondary hover:bg-ink/[0.06] hover:text-ink";
import { ClaudeUpdatePrompt } from "./ClaudeUpdatePrompt";
import { ScreenAccessCard, useScreenAccessMissing } from "./ScreenAccessNotice";
import { isThisComputerNotReady } from "../../shared/your-computer";
import { aiRunsOnServer } from "./ComposerSignInNotice";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { useLimitResetContinue } from "./EngineUsage";
import { bugReportFixedText } from "./BugReportNote";
import { openBotSettings } from "./bot-panel/panel-link";
import type { RoutineRetry } from "@/lib/routine-retry";

// a card someone closed stays closed for this run of the app; a newer failure is a new card
const dismissed = new Set<string>();
// the AI each failure was first shown under: a switch of model, or connecting an AI of one's own, closes it
const shownUnder = new Map<string, string>();

/** True once the AI a failure was first shown under has changed since (another model or engine, or one's own AI). */
export function aiChangedSince(seen: Map<string, string>, messageId: string, selection: ModelSelection | undefined, ownAi: boolean): boolean {
  const now = `${selection?.instanceId ?? ""}/${selection?.model ?? ""}/${ownAi ? 1 : 0}`;
  const first = seen.get(messageId);
  if (first === undefined) { seen.set(messageId, now); return false; }
  return first !== now;
}

/** The notice rows the card above the composer says, so the transcript leaves them out. */
export const FoldedNoticesContext = createContext<ReadonlySet<string>>(new Set());

export type TrailingRows = ReturnType<typeof trailingRows>;

/** What the card shows for a thread, or nothing while its turn still runs. */
export function useTrailingRows(messages: readonly Message[], live = true): TrailingRows | null {
  return useMemo(() => live ? trailingRows(messages) : null, [messages, live]);
}

export function foldedNoticeIds(rows: TrailingRows | null): ReadonlySet<string> {
  return new Set(rows?.notices.map((m) => m.id) ?? []);
}

const noticeText = (m: Message) => (m.bugReport && bugReportFixedText(m.bugReport)) ?? statusActivity(m)?.text ?? "";
const openEngines = { type: "toggleAppSettings", open: true, section: "engines" } as const;
const openKeys = { type: "toggleAppSettings", open: true, section: "connections" } as const;
const openPlan = { type: "toggleAppSettings", open: true, section: "cloudAccount" } as const;

type CardAction = { label: string; onClick: () => void };

/** grok's failed-reply card: one card just above the composer for every reply the newest turn lost, gone once anything
 * newer lands or it is closed. In a group it names who couldn't reply and says the reason a person can fix. */
export function FailedReplyCard({ rows, group = false, botId: ownBotId, threadId, onRetry, routine }: {
  rows: TrailingRows | null;
  group?: boolean;
  /** a direct chat's bot, whose rows carry no sender */
  botId?: string;
  threadId?: string;
  /** retries the last turn, when it can be retried */
  onRetry?: () => void;
  /** the failed turn was a routine's run: trying again runs that routine again, never resends its prompt */
  routine?: RoutineRetry;
}) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  // a test or an older desktop may hand over no host facts
  const platform = capabilities.host?.platform;
  const seat = usePlaceSeat(state.config, platform);
  const [, setClosed] = useState(0);
  // a retry that may repeat what a cut turn already did asks once more first; keyed by the row it is for
  const [confirming, setConfirming] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<boolean | AiTileId>(false);
  // an AI the person connected is ready: the free backup's failure is then an ordinary one
  const ownAi = state.instances.some((instance) => !freeFallback(instance) && engineReady(instance));
  const failures = rows?.failures ?? [];
  const notices = (rows?.notices ?? []).filter((m) => !dismissed.has(m.id));
  const items = failures.filter((m) => !dismissed.has(m.id)).map((message) => {
    const id = message.from?.botId ?? ownBotId;
    const bot = state.bots.find((candidate) => candidate.id === id);
    const engineNow = botEngine(bot, state.instances);
    // the free backup ran out, and this bot answers on another AI now: nothing left to fix
    const freeGone = message.tool?.reason === "no_ai" && engineNow !== undefined && !freeFallback(engineNow);
    if (freeGone || aiChangedSince(shownUnder, message.id, bot?.modelSelection, ownAi)) { dismissed.add(message.id); return null; }
    const engine = botEngine(bot, state.instances);
    return { message, bot, engine, kind: failedReplyKind(message.tool!, engine, ownAi) };
  }).filter((item) => item !== null);
  const lead = mostActionable(items);
  const tool = lead?.message.tool;
  const leadBotId = lead?.bot?.id ?? ownBotId;
  const resume = useLimitResetContinue(leadBotId, threadId, lead?.kind === "usage_limit" ? tool?.limitResetsAt : undefined);
  const signInNotice = notices.find((m) => m.tool?.setup === true || m.tool?.signIn === true);
  const screenAccessMissing = useScreenAccessMissing();
  const close = () => {
    for (const item of items) dismissed.add(item.message.id);
    for (const notice of notices) dismissed.add(notice.id);
    setClosed((n) => n + 1);
  };
  // the turn waits for its AI's limit to reset and carries on by itself: no failure to fix, only a wait to stop
  const held = lead?.kind === "usage_limit" ? tool?.limitHold : undefined;
  const heldBotId = lead?.bot?.id ?? ownBotId;
  if (held) {
    const ai = lead?.engine ? providerName(lead.engine) : t("failedReply.limitHold.anAi");
    const title = held.retryAt ? t("failedReply.limitHold.retry", { ai, time: resetTime(held.retryAt) })
      : held.resetsAt ? t("failedReply.limitHold.paused", { ai, time: resetTime(held.resetsAt) })
      : t("failedReply.limitHold.pausedUnknown", { ai });
    return (
      <div className="mb-2 w-full px-5" data-failed-reply="" data-limit-hold="">
        <ChatErrorCard tone="info" icon="batteryFull" title={title} onDismiss={close}
          actions={heldBotId && threadId && (
            <button type="button" onClick={() => dispatch({ type: "interrupt", botId: heldBotId, threadId })} className={QUIET_CARD_ACTION}>{t("failedReply.stopWaiting")}</button>
          )} />
      </div>
    );
  }
  if (!lead || !tool) {
    // only notices: the newest one is the card, the one way on its pill
    const last = notices.at(-1);
    if (!last) return null;
    const notice = signInNotice ?? last;
    // a notice that asks for an AI opens the connect flow; a sign-out of one AI opens that AI in settings
    const signIn = signInNotice?.tool?.signIn ? () => setConnecting(true) : () => dispatch(openEngines);
    return (
      <div className="mb-2 w-full px-5" data-failed-reply="">
        <ChatErrorCard tone="info" icon={signInNotice ? "key" : undefined} title={noticeText(notice)} onDismiss={close}
          actions={signInNotice && <button type="button" onClick={signIn} className={CARD_ACTION}>{t("chat.notice.signIn")}</button>} />
        {connecting && <ConnectAiDialog tested={null} onClose={() => setConnecting(false)} />}
      </div>
    );
  }

  // a turn lost to screen access before the bot chatted without it: the one way on is allowing it
  const placeCause = lead.kind === "place" ? tool.place?.params.cause : undefined;
  if (screenAccessMissing && typeof placeCause === "string" && isThisComputerNotReady(placeCause)) return <ScreenAccessCard onDismiss={close} />;

  if (lead.kind === "no_ai") {
    // no AI of the person's own yet: the first reply is the way to connect one, not an error
    return (
      <div className="mb-2 w-full px-5" data-failed-reply="" data-connect-ai-card="">
        <ChatErrorCard tone="info" icon="key" title={t("failedReply.noAi.title")} onDismiss={close}
          actions={<>
            <button type="button" onClick={() => setConnecting(true)} className={CARD_ACTION}>{t("composer.freeBackup.connect")}</button>
            {onRetry && <button type="button" onClick={onRetry} className={QUIET_CARD_ACTION}>{t("failedReply.tryAgain")}</button>}
          </>}>
          <p dir="auto" className="text-ink-secondary">{t("failedReply.noAi")}</p>
        </ChatErrorCard>
        {connecting && <ConnectAiDialog tested={null} onClose={() => setConnecting(false)} />}
      </div>
    );
  }

  const onServer = aiRunsOnServer(state.config, capabilities);
  const engineName = lead.engine?.displayName ?? t("failedReply.yourAi");
  const cause = failedTurnCause(tool.name) ?? "";
  let detail: string | null = failedReplyDetail(lead.kind, engineName, onServer);
  let did: string | null = null;
  const actions: CardAction[] = [];
  const retry = onRetry;
  let update = null;
  if (lead.kind === "place" && tool.place && leadBotId) {
    const view = placeRowViewFor(tool.place, seat, lowerFirst(worksOnSimpleLabel(lead.bot?.computer, platform)));
    detail = currentFailureWords(view.line);
    const id = view.action?.id;
    if (id === "try-again") { if (retry) actions.push({ label: t("failedReply.tryAgain"), onClick: retry }); }
    else if (id && view.action) actions.push({ label: id === "open-computer-panel" ? t("chat.error.openScreen") : view.action.label, onClick: () => { openPlaceAction(id, { botId: leadBotId, threadId }, dispatch); } });
  } else if (lead.kind === "blocker" && tool.blocker) {
    const botId = leadBotId;
    detail = blockerDetail(tool.blocker);
    if (botId && tool.blocker.kind === "loop") actions.push({ label: t("chat.blocker.takeOver"), onClick: () => { openPlaceAction("turn-on-browser", { botId, threadId }, dispatch); } });
    if (botId) actions.push({ label: t("chat.blocker.skip"), onClick: () => { close(); dispatch({ type: "send", botId, threadId, text: t("chat.blocker.skipText") }); } });
    actions.push({ label: t("chat.blocker.stop"), onClick: close });
  } else if (lead.kind === "claude_update") {
    const target = claudeUpdateTarget(lead.engine);
    if (target) { detail = null; update = <ClaudeUpdatePrompt instance={target} onRetry={retry} />; }
  } else if (lead.kind === "restart_interrupted") {
    did = restartAlreadyDid(cause);
    if (retry && confirming === lead.message.id) {
      detail = t("failedReply.retryRepeats");
      actions.push({ label: t("failedReply.retryAnyway"), onClick: () => { setConfirming(null); retry(); } });
      actions.push({ label: t("failedReply.retryCancel"), onClick: () => setConfirming(null) });
    } else if (retry) actions.push({ label: t("failedReply.tryAgain"), onClick: () => setConfirming(lead.message.id) });
  } else if (lead.kind === "no_answer" && !group && tool.rescue) {
    // the first reply never came: what the person can change is the AI, or whose subscription it runs on
    const { rescue } = tool;
    const ai = state.instances.find((instance) => instance.instanceId === rescue.instanceId)?.displayName || rescue.ai;
    detail = t("chat.rescue.over", { bot: lead.bot?.name ?? "", ai });
    actions.push({ label: t("chat.rescue.switchAi"), onClick: () => openBotSettings(dispatch, "model", { botId: rescue.botId }) });
    actions.push({ label: t("chat.rescue.connect"), onClick: () => dispatch(openEngines) });
  } else {
    const offer = (action: FailureAction | undefined): CardAction | null => {
      if (action === "retry") return retry ? { label: t("failedReply.tryAgain"), onClick: retry } : null;
      if (action === "continue_after_reset") return resume ?? null;
      if (action === "sign_in") {
        // Connect an AI, opened on this AI's card; an AI the flow can't sign in opens at its place in settings
        const tile = (canOfferSignIn(lead.kind, lead.engine) || signInNotice) && lead.engine && aiTileOf(lead.engine);
        return { label: t("chat.notice.signIn"), onClick: () => tile ? setConnecting(tile) : dispatch(openEngines) };
      }
      if (action === "update_key") return { label: t("failedReply.updateKey"), onClick: () => dispatch(openKeys) };
      if (action === "open_plan") return { label: t("failedReply.seePlan"), onClick: () => dispatch(openPlan) };
      if (action === "open_folder") return leadBotId ? { label: t("botPanel.page.folder"), onClick: () => openBotSettings(dispatch, "access", { botId: leadBotId, page: "folder" }) } : null;
      if (action === "set_up_engine") return { label: t("failedReply.setUp", { engine: engineName }), onClick: () => dispatch(openEngines) };
      if (action === "new_chat") return !group && leadBotId ? { label: t("failedReply.newChat"), onClick: () => { close(); dispatch({ type: "newTask", botId: leadBotId }); } } : null;
      if (action === "switch_ai") return leadBotId ? { label: t("chat.rescue.switchAi"), onClick: () => openBotSettings(dispatch, "model", { botId: leadBotId }) } : null;
      return null;
    };
    const plan = failurePlan(lead.kind);
    const first = offer(plan.action) ?? offer(plan.instead);
    const after = first && offer(plan.after);
    if (first) actions.push(first);
    if (after) actions.push(after);
  }
  if (routine?.state === "paused") actions.unshift({ label: t("routines.inline.open"), onClick: () => dispatch({ type: "openRoutine", routineId: routine.routineId, botId: leadBotId }) });
  if (actions.length === 0 && !update && lead.kind !== "place" && leadBotId) actions.push({ label: t("chat.rescue.switchAi"), onClick: () => openBotSettings(dispatch, "model", { botId: leadBotId }) });
  // a sign-out notice beside a failure for another reason: still one card, its Sign in a pill on it
  const signInTile = lead.engine && aiTileOf(lead.engine);
  if (signInNotice && !actions.some((action) => action.label === t("chat.notice.signIn"))) actions.unshift({ label: t("chat.notice.signIn"), onClick: () => signInTile ? setConnecting(signInTile) : dispatch(openEngines) });
  // a usage limit is a wait, not a failure: a calm notice that says until when
  const limited = lead.kind === "usage_limit";
  const limitAi = lead.engine ? providerName(lead.engine) : t("failedReply.limitHold.anAi");
  const title = limited ? (tool.limitResetsAt ? t("failedReply.limitHit", { ai: limitAi, time: resetTime(tool.limitResetsAt) }) : t("failedReply.limitHitUnknown", { ai: limitAi }))
    : lead.kind === "blocker" ? t("chat.blocker.title") : failedReplyTitle(items.map((item) => item.bot?.name ?? item.message.from?.name ?? ""), group);
  return (
    <div className="mb-2 w-full px-5" data-failed-reply="" {...(limited ? { "data-limit-notice": "" } : {})}>
      <ChatErrorCard
        tone={limited ? "info" : undefined}
        icon={limited ? "batteryFull" : signInNotice ? "key" : lead.kind === "place" ? "offline" : undefined}
        title={title}
        onDismiss={close}
        actions={actions.length > 0 && actions.slice(0, lead.kind === "blocker" ? 3 : 2).map((action, index) => (
          <button key={action.label} type="button" onClick={action.onClick} className={index > 0 && lead.kind !== "blocker" ? QUIET_CARD_ACTION : CARD_ACTION}>{action.label}</button>
        ))}
      >
        {detail && (
          <p dir="auto" className="text-ink-secondary">
            {detail}
            {tool.errorRef && !limited && <span data-error-ref="" title={t("failedReply.refTitle")} className="ms-1.5 whitespace-nowrap text-[12px] text-ink-tertiary tabular-nums">{t("failedReply.ref", { ref: tool.errorRef })}</span>}
          </p>
        )}
        {did && <p dir="auto" className="text-ink-secondary">{t("failedReply.restartedDid", { done: did })}</p>}
        {routine && routine.state !== "event" && <p dir="auto" className="text-ink-secondary" data-routine-retry={routine.state}>{t(`failedReply.routine.${routine.state}`, { name: routine.name })}</p>}
        {update}
      </ChatErrorCard>
      {connecting && <ConnectAiDialog tested={null} start={typeof connecting === "string" ? connecting : undefined} onClose={() => setConnecting(false)} />}
    </div>
  );
}
