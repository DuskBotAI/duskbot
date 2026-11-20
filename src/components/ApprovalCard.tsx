import { useContext, useState, type ReactNode } from "react";
import { Check, Clock3, ShieldCheck, X } from "../icons";
import { api, StoreContext, type Bot, type Message, type OptionCardData } from "@/state/store";
import { shareLearnedSkillsMode } from "@/lib/feature-flags";
import { cn } from "@/lib/cn";
import { t, tFromServer } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { SkillRequestPreview } from "@/components/SkillRequestPreview";
import { composioActionPhrase, outboundSummary } from "@/lib/approval-summary";
import { ReviewRecord, showsReviewRecord } from "./ReviewCards";
import { niceDate, niceTime, scheduleLabel } from "@/lib/schedule-label";
import { cronScheduleLabel } from "../../shared/cron-label";
import { PROFILE_REQUEST_FIELDS, type ProfileRequestField } from "../../shared/profile-request";
import type { RoutineRequestSchedule } from "../../shared/routine-request";
import type { SkillShareRecord } from "../../shared/skill-request";
import { cardAutomation } from "@/lib/automations";
import { yourComputerAsk } from "@/lib/your-computer";
import { TriggerCard } from "./TriggerCard";
import { ASK_CARD_LIFT, ASK_CARD_RING } from "./AskCard";
import { EventChip, EventLabel, EventLine } from "./EventLine";
import { Icon, type IconName } from "./Icon";
import { BotAvatar } from "./Avatar";
import { CardHint } from "./CardHint";
import { lowerFirst } from "../lib/lower-first";
import { appActionLine } from "@/lib/app-action";
import { ServiceTile } from "./ServiceIcon";
import { appLogo } from "./connect-apps/logos";
import { friendlyError } from "@/lib/plain-error";

interface ToolLabels {
  [tool: string]: LocaleKey;
}

const ROUTINE_SETTLED_LABEL = {
  create: "approval.status.routineScheduled",
  update: "approval.status.routineUpdated",
  pause: "approval.status.routinePaused",
  resume: "approval.status.routineResumed",
  run_now: "approval.status.routineRunQueued",
  delete: "approval.status.routineDeleted",
} as const;

const SKILL_SETTLED_LABEL = {
  create: "approval.status.skillEnabled",
  update: "approval.status.skillUpdated",
} as const;

/** Schedules and webhooks alike are "automations" to a person. */
const AUTOMATION_APPLIED_LINE = {
  create: "approval.applied.automation.create",
  update: "approval.applied.automation.update",
  pause: "approval.applied.automation.pause",
  resume: "approval.applied.automation.resume",
  run_now: "approval.applied.automation.runNow",
  delete: "approval.applied.automation.delete",
} as const;
const WAIT_APPLIED_LINE = {
  waiting: "approval.applied.wait",
  fired: "approval.applied.waitFired",
  expired: "approval.applied.waitExpired",
  cancelled: "approval.applied.waitCancelled",
} as const;

const SKILL_APPLIED_LINE = {
  create: "approval.applied.skill.create",
  update: "approval.applied.skill.update",
} as const;

const PROFILE_FIELD_LABEL: Record<ProfileRequestField, LocaleKey> = {
  name: "approval.applied.field.name",
  title: "approval.applied.field.title",
  description: "approval.applied.field.description",
  soul: "approval.applied.field.soul",
  cwd: "approval.applied.field.cwd",
  notifications: "approval.applied.field.notifications",
  speakReplies: "approval.applied.field.speakReplies",
  color: "approval.applied.field.color",
  replyStyle: "approval.applied.field.replyStyle",
  voice: "approval.applied.field.voice",
  voiceNotes: "approval.applied.field.voiceNotes",
};

/** A routine card no one answered is from before Triggers v2 applied changes on their own: nothing can confirm it now. */
const staleRoutineCard = (card: OptionCardData) => Boolean(card.routineRequest && !card.answered);

/** The card brings its own question and answer words (its title and first option): team setup and MCP server changes. */
export const titledCard = (card: OptionCardData | undefined) => Boolean(card?.teamSetupRequest || card?.mcpRequest);

export function approvalCardOutcome(card: OptionCardData): string | undefined {
  const isProposal = Boolean(card.routineRequest || card.skillRequest || card.profileRequest || card.modelRequest || titledCard(card));
  if (card.expired === true || staleRoutineCard(card)) return t(isProposal || !card.tool ? "approval.status.expired" : "approval.status.timedOut");
  if (!card.answered) return undefined;
  if (card.undone === true) return t("approval.status.undone");
  if (card.answered !== "allow") return isProposal ? t("approval.status.cancelled") : t("approval.status.denied");
  if (card.teamSetupRequest) return card.teamSetupRequest.deletion ? "Bot deleted" : "Team setup applied";
  const routineAction = card.routineRequest?.operation.action;
  if (routineAction) return t(ROUTINE_SETTLED_LABEL[routineAction]);
  const skillAction = card.skillRequest?.action;
  if (skillAction) return t(SKILL_SETTLED_LABEL[skillAction]);
  if (card.profileRequest) return t("approval.status.profileUpdated");
  if (card.modelRequest) return t("approval.status.modelChanged");
  if (card.routineRequest) return t("approval.status.routineConfirmed");
  if (card.skillRequest) return t("approval.status.skillConfirmed");
  return t("approval.status.allowed");
}

export function toolLabel(tool?: string): string {
  if (!tool) return t("approval.tool.takeAction");
  const bare = tool.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ");
  const nice: ToolLabels = {
    Bash: "approval.tool.runCommand",
    Read: "approval.tool.readFile",
    Write: "approval.tool.writeFile",
    Edit: "approval.tool.editFile",
    WebFetch: "approval.tool.fetchWebPage",
    WebSearch: "approval.tool.searchWeb",
    schedule_routine: "approval.tool.scheduleRoutine",
    manage_routine: "approval.tool.changeRoutine",
    stage_skill: "approval.tool.enableSkill",
    update_skill: "approval.tool.updateSkill",
    update_profile: "approval.tool.updateProfile",
    mac_exec: "approval.tool.macExec",
    mac_read_file: "approval.tool.macReadFile",
    mac_send_file: "approval.tool.macReadFile",
    mac_write_file: "approval.tool.macWriteFile",
    mac_open: "approval.tool.macOpen",
    mac_download: "approval.tool.macDownload",
    // ACP drivers may send the protocol's toolCall kind as the tool, so every kind maps to a phrase ("shell" is
    // execute; "tool" is no kind at all).
    shell: "approval.tool.runCommand",
    edit: "approval.tool.editFile",
    read: "approval.tool.readFile",
    fetch: "approval.tool.fetchWebPage",
    delete: "approval.tool.deleteFile",
    think: "approval.tool.think",
    other: "approval.tool.takeAction",
    tool: "approval.tool.useTool",
  };
  const key = nice[tool];
  if (key) return t(key);
  return composioActionPhrase(tool.replace(/^mcp__[^_]+__/, "")) ?? bare;
}

function plainWhen(schedule: RoutineRequestSchedule): string {
  if (schedule.type === "once") {
    return new Date(schedule.at).toDateString() === new Date().toDateString()
      ? t("approval.applied.today", { time: niceTime(schedule.at) })
      : `${niceDate(schedule.at)}, ${niceTime(schedule.at)}`;
  }
  if (schedule.type === "cron") {
    const label = cronScheduleLabel(schedule);
    return label.startsWith("Cron ") ? "" : label;
  }
  if (schedule.type === "interval") return scheduleLabel({ ...schedule, anchorAt: schedule.anchorAt ?? 0 });
  if (schedule.type === "limit_reset") return scheduleLabel({ ...schedule, at: null });
  return scheduleLabel(schedule);
}

export function appliedChange(card: OptionCardData, name: string): { line: string; canUndo: boolean; cancels?: boolean; detail?: string } | undefined {
  const routine = card.routineRequest;
  if (routine) {
    const operation = routine.operation;
    const undo = routine.undo;
    const when = undo?.schedule && operation.action !== "pause" && operation.action !== "delete" && operation.action !== "run_now"
      ? plainWhen(undo.schedule)
      : "";
    const title = [
      undo?.name ?? (operation.action === "create" ? operation.routine.name : ""),
      operation.forBot ? t("approval.applied.forBot", { target: `@${operation.forBot.name}` }) : "",
    ].filter(Boolean).join(" · ") + (when ? `, ${when}` : "");
    const canUndo = operation.action === "create" ? Boolean(routine.resultId)
      : operation.action === "update" ? Boolean(undo?.before && undo.appliedUpdatedAt !== undefined)
        : operation.action === "pause" || operation.action === "resume" ? undo?.appliedUpdatedAt !== undefined
          : operation.action === "delete" ? Boolean(undo?.before)
            : false;
    return { line: t(AUTOMATION_APPLIED_LINE[operation.action], { name, title }), canUndo };
  }
  const wait = card.waitRequest;
  if (wait) return { line: t(WAIT_APPLIED_LINE[wait.settled ?? "waiting"], { name, title: wait.label }), canUndo: !wait.settled, cancels: true };
  const webhook = card.webhookRequest;
  if (webhook) {
    const target = webhook.operation.forBot ? ` · ${t("approval.applied.forBot", { target: `@${webhook.operation.forBot.name}` })}` : "";
    return { line: t(AUTOMATION_APPLIED_LINE[webhook.operation.action], { name, title: `${webhook.undo?.name ?? ""}${target}` }), canUndo: webhook.operation.action !== "run_now" };
  }
  const skill = card.skillRequest;
  if (skill) {
    return {
      line: t(SKILL_APPLIED_LINE[skill.action], { name, title: skill.name }),
      canUndo: skill.action === "create" || Boolean(skill.previous),
    };
  }
  const profile = card.profileRequest;
  if (profile) {
    const changed = PROFILE_REQUEST_FIELDS.filter((field) => profile.changes[field] !== undefined)
      .map((field) => t(PROFILE_FIELD_LABEL[field])).join(", ");
    // the line only says it happened; what changed waits behind Details
    return { line: t("approval.applied.profileOwnPlain", { name }), canUndo: Boolean(profile.undo), detail: changed };
  }
  const model = card.modelRequest;
  if (model) {
    const title = model.selection.model;
    const line = model.targetBotId === model.botId
      ? t("approval.applied.modelOwn", { name, title })
      : t("approval.applied.modelOther", { name, target: `@${model.targetName}`, title });
    return { line, canUndo: true };
  }
  const setup = card.teamSetupRequest;
  if (setup?.deletion) return { line: t("approval.applied.botDeleted", { name, target: `@${setup.deletion.name}` }), canUndo: false };
  if (setup?.result) {
    const names = (action: "created" | "updated") => setup.result!.bots.filter((bot) => bot.action === action).map((bot) => `@${bot.name}`).join(", ");
    const title = [names("created") && t("approval.applied.teamAdded", { names: names("created") }),
      names("updated") && t("approval.applied.teamUpdated", { names: names("updated") })].filter(Boolean).join("; ");
    return { line: t("approval.applied.teamSetup", { name, title }), canUndo: Boolean(setup.undo) };
  }
  if (card.teamMemoryRequest) {
    return { line: t("approval.applied.teamMemory", { name, title: card.subtitle.split(" — ")[0] ?? "" }), canUndo: Boolean(card.teamMemoryRequest.revision) };
  }
  return undefined;
}

const ROUTINE_EVENT = {
  create: "chat.event.routineCreated",
  update: "chat.event.routineUpdated",
  pause: "chat.event.routinePaused",
  resume: "chat.event.routineResumed",
  run_now: "chat.event.routineRan",
  delete: "chat.event.routineDeleted",
} as const satisfies Record<string, LocaleKey>;
const WAIT_EVENT = {
  waiting: "chat.event.waiting",
  fired: "chat.event.waitFired",
  expired: "chat.event.waitExpired",
  cancelled: "chat.event.waitCancelled",
} as const satisfies Record<string, LocaleKey>;

interface AppliedEvent {
  label: string;
  chip?: { icon: IconName; name: string; title?: string };
  /** Bots the change made or changed, each drawn as its mascot. */
  bots?: Array<{ name: string; botId?: string }>;
  forBot?: { name: string; botId?: string };
}

/** An applied change as grok's transcript events read it: what happened, then the thing it happened to. */
export function appliedEvent(card: OptionCardData): AppliedEvent | undefined {
  const routine = card.routineRequest;
  if (routine) {
    const operation = routine.operation;
    const name = routine.undo?.name ?? (operation.action === "create" ? operation.routine.name : "");
    const when = routine.undo?.schedule && operation.action !== "pause" && operation.action !== "delete" && operation.action !== "run_now"
      ? plainWhen(routine.undo.schedule) : "";
    return {
      label: t(ROUTINE_EVENT[operation.action]),
      ...(name ? { chip: { icon: "clock" as const, name, title: when ? `${name}, ${when}` : name } } : {}),
      ...(operation.forBot ? { forBot: { name: operation.forBot.name, botId: operation.forBot.botId } } : {}),
    };
  }
  const wait = card.waitRequest;
  if (wait) return { label: t(WAIT_EVENT[wait.settled ?? "waiting"]), chip: { icon: "hourglass", name: wait.label } };
  const webhook = card.webhookRequest;
  if (webhook) {
    const name = webhook.undo?.name ?? "";
    return {
      label: t(ROUTINE_EVENT[webhook.operation.action]),
      ...(name ? { chip: { icon: "lightning" as const, name } } : {}),
      ...(webhook.operation.forBot ? { forBot: { name: webhook.operation.forBot.name, botId: webhook.operation.forBot.botId } } : {}),
    };
  }
  const skill = card.skillRequest;
  if (skill?.learnedBy === "review") return { label: t(skill.action === "create" ? "chat.event.skillLearned" : "chat.event.skillImproved"), chip: { icon: "skills", name: skill.name } };
  if (skill) return { label: t(skill.action === "create" ? "chat.event.skillAdded" : "chat.event.skillUpdated"), chip: { icon: "skills", name: skill.name } };
  const profile = card.profileRequest;
  if (profile) {
    return { label: t("chat.event.settingsUpdated"), ...(profile.targetBotId !== profile.botId ? { forBot: { name: profile.targetName, botId: profile.targetBotId } } : {}) };
  }
  const model = card.modelRequest;
  if (model) {
    return {
      label: t("chat.event.modelChanged"), chip: { icon: "chip", name: model.selection.model },
      ...(model.targetBotId !== model.botId ? { forBot: { name: model.targetName, botId: model.targetBotId } } : {}),
    };
  }
  const setup = card.teamSetupRequest;
  if (setup?.deletion) return { label: t("chat.event.botDeleted"), chip: { icon: "robot", name: setup.deletion.name } };
  if (setup?.result) return setupEvents(setup.result)[0] ?? { label: t("chat.event.botsUpdated") };
  if (card.teamMemoryRequest) {
    const title = card.subtitle.split(" — ")[0] ?? "";
    return { label: t("chat.event.teamMemorySaved"), ...(title ? { chip: { icon: "brain" as const, name: title } } : {}) };
  }
  return undefined;
}

/** A setup as plain events: the bots it made, the ones it changed, and any group it made, one line each. */
function setupEvents(result: NonNullable<NonNullable<OptionCardData["teamSetupRequest"]>["result"]>): AppliedEvent[] {
  const bots = (action: "created" | "updated") => result.bots.filter((bot) => bot.action === action).map((bot) => ({ name: bot.name, botId: bot.id }));
  const created = bots("created"), updated = bots("updated");
  return [
    ...(created.length ? [{ label: t("chat.event.botCreated"), bots: created }] : []),
    ...(updated.length ? [{ label: t("chat.event.botsUpdated"), bots: updated }] : []),
    ...result.newTeams.map((name) => ({ label: t("chat.event.groupMade"), chip: { icon: "people" as const, name } })),
  ];
}

function botChip(bot: { name: string; botId?: string }, known: readonly Bot[] | undefined) {
  const found = known?.find((one) => one.id === bot.botId || one.name === bot.name);
  return (
    <EventChip key={bot.botId ?? bot.name} wideGap title={bot.name}
      leading={<BotAvatar bot={found ?? { name: bot.name, color: "blue" }} state="happy" size={16} motion="none" motionKey={0} animated={false} />}>
      {bot.name}
    </EventChip>
  );
}

function AppliedEventLine({ event, bots }: { event: AppliedEvent; bots: readonly Bot[] | undefined }) {
  return <EventLine><AppliedEventParts event={event} bots={bots} /></EventLine>;
}

function AppliedEventParts({ event, bots }: { event: AppliedEvent; bots: readonly Bot[] | undefined }) {
  const chip = event.chip;
  const many = event.bots && event.bots.length > 2;
  return (
    <>
      <EventLabel>{event.label}</EventLabel>
      {chip && (
        <EventChip
          leading={<Icon name={chip.icon} size={12} />}
          title={chip.title ?? chip.name}
        >
          {chip.name}
        </EventChip>
      )}
      {event.bots && (many
        ? <>{botChip(event.bots[0]!, bots)}<EventLabel tone="tertiary">{t("chat.event.andMore", { count: event.bots.length - 1 })}</EventLabel></>
        : event.bots.map((bot, index) => index ? [<EventLabel key={`and-${index}`} tone="tertiary">{t("chat.event.and")}</EventLabel>, botChip(bot, bots)] : botChip(bot, bots)))}
      {event.forBot && (
        <>
          <EventLabel tone="tertiary">{t("chat.event.for")}</EventLabel>
          {botChip(event.forBot, bots)}
        </>
      )}
    </>
  );
}

function AppliedChangeLine({
  card,
  threadId,
}: {
  card: OptionCardData;
  threadId?: string;
}) {
  const [error, setError] = useState<string>();
  const [sharing, setSharing] = useState(false);
  const [undoing, setUndoing] = useState(false);
  // Kept until the card's own patch arrives, so the Share button cannot come back in between.
  const [sharedNow, setSharedNow] = useState<{ requestId: string; shared: SkillShareRecord }>();
  const store = useContext(StoreContext);
  const config = store?.state.config ?? null;
  const undone = card.undone === true;
  const skill = card.skillRequest;
  const shared = skill?.shared ?? (sharedNow && sharedNow.requestId === card.requestId ? sharedNow.shared : undefined);
  const canShare = Boolean(skill && !shared && !undone && threadId && card.requestId)
    && shareLearnedSkillsMode(config) === "ask";
  const share = () => {
    const requestId = card.requestId;
    if (!threadId || !requestId || sharing) return;
    setSharing(true);
    setError(undefined);
    api<{ shared: SkillShareRecord }>(`/api/threads/${threadId}/share-skill`, { method: "POST", body: JSON.stringify({ requestId }) })
      .then((response) => setSharedNow({ requestId, shared: response.shared }))
      .catch((failure: unknown) => {
        setError(t("approval.applied.shareFailed", { error: friendlyError(failure) }));
      })
      .finally(() => setSharing(false));
  };
  const canUndo = Boolean(skill?.learnedBy === "review" && !undone && threadId && card.requestId && appliedChange(card, "")?.canUndo);
  const undo = () => {
    if (!threadId || !card.requestId || undoing) return;
    setUndoing(true);
    setError(undefined);
    api(`/api/threads/${threadId}/undo`, { method: "POST", body: JSON.stringify({ requestId: card.requestId }) })
      .catch((failure: unknown) => setError(friendlyError(failure)))
      .finally(() => setUndoing(false));
  };
  const sharedNames = shared?.assigned.filter((bot) => bot.botId !== skill?.botId).map((bot) => bot.name) ?? [];
  const skippedNames = shared?.skipped.map((bot) => bot.name) ?? [];
  const setup = card.teamSetupRequest?.result && !card.teamSetupRequest.deletion ? setupEvents(card.teamSetupRequest.result) : null;
  const events = setup?.length ? setup : [appliedEvent(card)].filter((event) => event !== undefined);
  const bots = store?.state.bots;
  const last = events.length - 1;
  return (
    <div className="flex w-full flex-col items-center gap-1" data-applied-change="">
      {events.map((event, index) => index < last ? <AppliedEventLine key={index} event={event} bots={bots} /> : (
        <EventLine key={index}>
          <AppliedEventParts event={event} bots={bots} />
          {shared && !undone && (
            <EventLabel tone="tertiary">· {sharedNames.length ? t("approval.applied.sharedSkill", { names: sharedNames.join(", ") }) : t("approval.applied.sharedSkillNobody")}</EventLabel>
          )}
          {undone && !card.waitRequest && <EventLabel tone="tertiary">· {t("approval.applied.undone")}</EventLabel>}
          {canUndo && (
            <EventChip onClick={undo} disabled={undoing} className="disabled:opacity-60">
              {undoing ? t("automations.card.undoing") : t("automations.card.undo")}
            </EventChip>
          )}
          {canShare && (
            <EventChip onClick={share} disabled={sharing} className="disabled:opacity-60">
              {sharing ? t("approval.applied.sharingSkill") : t("approval.applied.shareSkill")}
            </EventChip>
          )}
        </EventLine>
      ))}
      {shared && !undone && skippedNames.length > 0 && (
        <div className="text-center text-[12px] leading-4 text-ink-tertiary">{t("approval.applied.shareSkipped", { names: skippedNames.join(", ") })}</div>
      )}
      {!error && !shared && !undone && skill?.shareError && (
        <div className="text-center text-[12px] leading-4 text-warning">{t("approval.applied.shareFailed", { error: skill.shareError })}</div>
      )}
      {error && <div role="alert" className="text-center text-[12px] leading-4 text-warning">{error}</div>}
    </div>
  );
}

/** Whether a settled card left a change grok would show as a transcript event. */
export function showsSettledChange(card: OptionCardData | undefined): card is OptionCardData {
  return Boolean(card && card.answered === "allow" && !card.held && !card.expired && card.requestId && appliedEvent(card) && appliedChange(card, ""));
}

/** A settled change, in a chat that talks in bubbles: one event line. Only a change that applied on its own can be undone here. */
export function SettledChangeEvent({ message, threadId }: { bot?: Pick<Bot, "name">; message: Message; threadId?: string }) {
  const card = message.card;
  if (!showsSettledChange(card)) return null;
  return <AppliedChangeLine card={card} threadId={threadId} />;
}

/** The app a card's tool belongs to, as its tile: the brand mark we keep, else its site's icon. */
export function AppActionLogo({ card, size = 20 }: { card: Pick<OptionCardData, "appAction">; size?: number }) {
  const action = card.appAction;
  if (!action) return null;
  const logo = appLogo(action.app);
  return (
    <ServiceTile size={size} card={logo
      ? { label: action.app, image: logo.src, padded: logo.padded, background: logo.background, scale: logo.scale }
      : { label: action.app, domain: action.domain ?? null, padded: true }} />
  );
}

export const APPROVAL_CODE_CHIP =
  "inline-flex min-w-0 max-w-full items-baseline rounded-full bg-inset px-2 pb-px pt-[3px] font-mono text-[13px] leading-5 text-ink";

const TEXT_ACTION =
  "inline-flex h-6 items-center rounded-full px-2 hover:bg-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

/** What an allowed step did, said the way grok's steps read: plain words, the command itself only behind Details. */
const DONE_STEP: Partial<Record<string, LocaleKey>> = {
  Bash: "chat.now.ranCommand", shell: "chat.now.ranCommand",
  Read: "chat.now.readFile", read: "chat.now.readFile",
  Write: "chat.now.wroteFile",
  Edit: "chat.now.editedFile", edit: "chat.now.editedFile",
  WebFetch: "chat.now.readPage", fetch: "chat.now.readPage",
  WebSearch: "chat.now.searchedWeb",
};

export function doneStepLine(tool: string | undefined): string | null {
  const key = tool ? DONE_STEP[tool] : undefined;
  return key ? t(key) : null;
}

function firstLineOf(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function CompactApprovalRow({
  header,
  summary,
  detail,
  showDetailInline,
  outcome,
  allowed,
  expired = false,
  byVoice,
  waiting,
  answeredBelow,
  quietOutcome = false,
}: {
  header: string;
  summary?: string;
  detail: string;
  showDetailInline: boolean;
  outcome?: string;
  allowed: boolean;
  expired?: boolean;
  byVoice: ReactNode;
  waiting: boolean;
  answeredBelow: boolean;
  /** An allowed step needs no "Allowed": the line already says what it did. */
  quietOutcome?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen((value) => !value);
  if (waiting && answeredBelow) {
    return (
      <div data-approval-row="pending" className="sr-only">
        {header}{summary ? ` ${summary}` : ""}{detail && showDetailInline ? ` ${firstLineOf(detail)}` : ""}. {t("approval.status.waitingAnswer")}
      </div>
    );
  }
  if (!waiting) {
    // grok's answered permission: one centered grey line of what was decided, nothing to press but the details
    return (
      <div data-approval-row="settled" className="flex w-full flex-col items-center text-center text-[12px] leading-4 text-ink-secondary">
        <p className="max-w-[560px] break-words">
          <span>{header}</span>
          {summary && <span> · {summary}</span>}
          {quietOutcome
            ? <span className="sr-only" aria-live="polite">{outcome}</span>
            : <span aria-live="polite"> · {outcome ?? t("approval.status.waitingAnswer")}</span>}
          {byVoice && <> {byVoice}</>}
          {detail && (
            <> <button type="button" aria-expanded={open} onClick={toggle}
              className="rounded px-0.5 text-ink-tertiary underline-offset-2 hover:text-ink-secondary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
              {open ? t("approval.applied.hideDetails") : t("approval.applied.details")}
            </button></>
          )}
        </p>
        {open && (
          <pre tabIndex={0} aria-label={t("approval.aria.details")}
            className="mt-1.5 max-h-40 w-full max-w-[560px] overflow-auto whitespace-pre-wrap break-words rounded-[12px] border border-transparent bg-(--card-code-fill) px-3 py-2 text-start font-mono text-[13px] leading-[18px] text-ink">
            {detail}
          </pre>
        )}
      </div>
    );
  }
  return (
    <div
      data-tour={waiting ? "approval" : undefined}
      data-approval-row={waiting ? "pending" : "settled"}
      className={cn("w-full max-w-[840px] text-[13px]", waiting ? "text-ink-secondary" : "text-ink-tertiary")}
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 leading-5">
        {waiting
          ? <ShieldCheck size={14} className="shrink-0 self-center text-accent" aria-hidden="true" />
          : allowed
            ? <Check size={14} className="shrink-0 self-center text-success" aria-hidden="true" />
            : expired
              ? <Clock3 size={14} className="shrink-0 self-center" aria-hidden="true" />
              : <X size={14} className="shrink-0 self-center" aria-hidden="true" />}
        <span className={cn("min-w-0 break-words", waiting && "text-ink")}>{header}</span>
        {summary && <span className="min-w-0 break-words">{waiting ? summary : `· ${summary}`}</span>}
        {detail && showDetailInline && (
          <span role="group" aria-label={t("approval.aria.details")} className="min-w-0 max-w-full">
            <button
              type="button"
              aria-expanded={open}
              title={detail}
              onClick={toggle}
              className={cn(APPROVAL_CODE_CHIP, "text-left hover:bg-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus")}
            >
              <span className="truncate">{detail}</span>
            </button>
          </span>
        )}
        {quietOutcome
          ? <span className="sr-only" aria-live="polite">{outcome}</span>
          : <span className="shrink-0" aria-live="polite">· {outcome ?? t("approval.status.waitingAnswer")}</span>}
        {byVoice}
        {detail && !showDetailInline && (
          <button
            type="button"
            aria-expanded={open}
            onClick={toggle}
            className={cn(TEXT_ACTION, "text-ink-tertiary hover:text-ink-secondary")}
          >
            {open ? t("approval.applied.hideDetails") : t("approval.applied.details")}
          </button>
        )}
      </div>
      {open && (
        <pre
          tabIndex={0}
          aria-label={t("approval.aria.details")}
          className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-2xl bg-inset px-4 py-3 font-mono text-[12px] leading-relaxed text-ink"
        >
          {detail}
        </pre>
      )}
    </div>
  );
}

export function ApprovalCard({
  bot,
  message,
  threadId,
}: {
  bot?: Pick<Bot, "name">;
  message: Message;
  threadId?: string;
}) {
  const card = message.card;
  if (!card) return null;
  if (showsReviewRecord(card)) return <ReviewRecord card={card} />;
  if (cardAutomation(card)) return <TriggerCard card={card} threadId={threadId} />;
  const applied = card.autoApplied === true && card.answered === "allow" && !card.held
    ? appliedChange(card, bot?.name ?? t("approval.someone"))
    : undefined;
  if (applied) return <AppliedChangeLine card={card} threadId={threadId} />;
  const settled = card.answered;
  const expired = card.expired === true || staleRoutineCard(card);
  const via = card.answeredBy?.via;
  const byVoice = via ? <span className="text-ink-tertiary">· {t(via === "call" ? "approval.status.byVoice" : "approval.status.byReaction")}</span> : null;
  const isRoutineRequest = Boolean(card.routineRequest);
  const isSkillRequest = Boolean(card.skillRequest);
  const isProfileRequest = Boolean(card.profileRequest);
  const titled = titledCard(card);
  const routineAction = card.routineRequest?.operation.action;
  const skillAction = card.skillRequest?.action;
  const heldNote = tFromServer(card.heldCode, card.held);
  const outcome = approvalCardOutcome(card);
  const outbound = outboundSummary(card);
  const displayTool = isRoutineRequest
    ? routineAction === "create" ? "schedule_routine" : "manage_routine"
    : isSkillRequest
      ? skillAction === "update" ? "update_skill" : "stage_skill"
    : isProfileRequest
      ? "update_profile"
    : card.tool;
  const profileHeader = isProfileRequest && card.profileRequest
    ? card.profileRequest.targetBotId === card.profileRequest.botId
      ? t("approval.card.profileWantsToOwn", { name: bot?.name ?? t("approval.someone") })
      : t("approval.card.profileWantsToOther", {
          name: bot?.name ?? t("approval.someone"),
          target: card.profileRequest.targetName,
        })
    : undefined;

  if (!isRoutineRequest && !isSkillRequest && !isProfileRequest && !titled && !card.modelRequest) {
    const waiting = !settled && !expired;
    const ask = yourComputerAsk(card, bot?.name ?? t("approval.someone"));
    const allowed = settled === "allow" && !expired;
    const done = !waiting && allowed && !ask && !outbound ? doneStepLine(displayTool) : null;
    const appLine = !ask && !outbound ? appActionLine(card) : undefined;
    const header = done ?? appLine ?? (ask ? ask.line : outbound
      ? waiting ? outbound.headline : outbound.headline.replace(/\s*[?？]$/, "")
      : bot
        ? t("approval.card.namedWantsTo", { name: bot.name, action: lowerFirst(toolLabel(displayTool)) })
        : t("approval.card.wantsTo", { action: lowerFirst(toolLabel(displayTool)) }));
    const row = (
      <CompactApprovalRow
        header={header}
        summary={outbound?.summary || undefined}
        detail={ask?.detail ?? card.subtitle}
        showDetailInline={waiting && !outbound && !appLine}
        quietOutcome={!waiting && allowed}
        outcome={outcome}
        allowed={allowed}
        expired={expired}
        byVoice={byVoice}
        waiting={waiting}
        answeredBelow={Boolean(card.requestId && card.tool && !card.dismissed)}
      />
    );
    return waiting && card.requestId && card.tool ? <div className="flex w-full flex-col gap-1">{row}<CardHint id="spot.approval" /></div> : row;
  }

  return (
    <div
      data-tour={settled || expired ? undefined : "approval"}
      className={cn("w-full max-w-[560px] rounded-[24px] px-4 pb-4 pt-3.5", ASK_CARD_RING, ASK_CARD_LIFT, (settled || expired) && "opacity-70")}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[15px] font-semibold text-ink">
          {titled ? card.title : outbound ? outbound.headline : profileHeader ?? (
            <>
              {bot
                ? t("approval.card.namedWantsTo", { name: bot.name, action: lowerFirst(toolLabel(displayTool)) })
                : t("approval.card.wantsTo", { action: lowerFirst(toolLabel(displayTool)) })}
            </>
          )}
        </div>
        {displayTool && !titled && !outbound && <span className="shrink-0 font-mono text-[11px] text-ink-secondary">{displayTool}</span>}
      </div>
      {outbound?.summary && <div className="mt-0.5 text-[13px] text-ink-secondary">{outbound.summary}</div>}

      <pre
        tabIndex={0}
        aria-label={
          isRoutineRequest
            ? t("approval.aria.routineDetails")
            : isSkillRequest
              ? t("approval.aria.skillDetails")
              : isProfileRequest
                ? t("approval.aria.profileChange")
                : t("approval.aria.details")
        }
        className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-[12px] border border-transparent bg-(--card-code-fill) px-3 py-2 font-mono text-[13px] leading-[18px] text-ink"
      >
        {card.subtitle}
      </pre>

      {card.skillRequest && <SkillRequestPreview request={card.skillRequest} />}

      {heldNote && (
        <div className="mt-2 text-[13px] text-warning">
          {heldNote}
        </div>
      )}

      <div className="mt-3 flex items-center gap-1.5 text-[13px] text-ink-secondary">
        {outcome ? (
          <>
            {settled === "allow" && !expired ? <Check size={14} className="text-success" /> : <X size={14} />} {outcome}
            {byVoice}
          </>
        ) : (
          <>
            <ShieldCheck size={14} className="text-accent" />
            {isRoutineRequest || isSkillRequest || isProfileRequest || titled
              ? t("approval.status.waitingConfirmation")
              : t("approval.status.waitingAnswer")}
          </>
        )}
      </div>
    </div>
  );
}
