import { useRef } from "react";

import { friendlyNowPhrases } from "@/lib/friendly-activity";
import { peerLine } from "@/lib/peer-message";
import { activeLocale, t } from "@/lib/i18n";
import type { Bot, Group, Message } from "@/state/store";
import { BotFaces } from "./BotFaces";
import type { MarkState } from "./mascot-engine";
import { TurnPresence } from "./TurnPresence";
import { useReplyLife } from "@/hooks/use-reply-life";
import { lifeMarkState } from "@/lib/reply-life";

type RoomWork = Pick<Group, "busyBotId" | "threadId" | "tasks" | "busyBotIds">;

/** Every member running a turn in the room's open thread, speaker first: the busy speaker, each member the server lists
 * as answering, and a member whose tool call is still out. */
export function roomWorkingIds(group: RoomWork, lastMessage: Message | undefined): string[] {
  const task = group.tasks?.find((candidate) => candidate.threadId === group.threadId);
  const inFlight = lastMessage?.kind === "activity" && lastMessage.tool && lastMessage.tool.ok === undefined ? lastMessage.from?.botId : undefined;
  const ids = [group.busyBotId, task?.busyBotId, ...(group.busyBotIds ?? []), inFlight];
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
}

/** Members a hand-off since the person's last line is still waiting on: each works in a thread of its own, so the room
 * hears of it only from the hand-off rows. */
export function handoffWorkIds(messages: readonly Message[]): string[] {
  const open = new Map<string, number>();
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role === "user" && !peerLine(m)) break;
    const line = m.handoff;
    if (!line) continue;
    const id = line.phase === "sent" ? line.to.botId : line.from.botId;
    open.set(id, (open.get(id) ?? 0) + (line.phase === "sent" ? 1 : -1));
  }
  return [...open].filter(([, count]) => count > 0).map(([id]) => id).reverse();
}

/** Ids in the order they first showed up, so faces never trade places while they work. */
function useArrivalOrder(ids: readonly string[]): string[] {
  const order = useRef<string[]>([]);
  const kept = order.current.filter((id) => ids.includes(id));
  const next = [...kept, ...ids.filter((id) => !kept.includes(id))];
  if (next.length !== order.current.length || next.some((id, index) => id !== order.current[index])) order.current = next;
  return order.current;
}

export type RoomVerb = "typing" | "working" | "thinking";

const NAMED = { typing: "room.status.typing", working: "room.status.working", thinking: "room.status.thinking" } as const;
const SEVERAL = { typing: "room.status.severalTyping", working: "room.status.severalWorking", thinking: "room.status.severalThinking" } as const;
/** Up to this many bots are named; more are "Several bots". */
const MAX_NAMED = 3;

/** "Nova and Quill are typing…", "Nova, Quill and Rivet are working…", "Several bots are working…". */
export function roomStatusPhrase(names: readonly string[], verb: RoomVerb): string {
  if (names.length > MAX_NAMED) return t(SEVERAL[verb]);
  const list = new Intl.ListFormat(activeLocale(), { style: "long", type: "conjunction" }).format(names);
  return t(NAMED[verb], { names: list });
}

const TYPING_PHASE = "friendly:chat.typing";

export interface RoomSpeakerLine {
  bot: Bot | undefined;
  visible: boolean;
  markState: MarkState;
  phrases?: readonly string[];
  phase?: string;
  since: number | null;
}

/** The room's one live status line in the slot it keeps at its end. One bot at work is the 1:1 chat's line: its mark and
 * a friendly phrase. Several share it: their faces in a small stack, joining and leaving as each starts and finishes,
 * and one phrase that names them ("Nova and Quill are typing…") or, past three, "Several bots are working…". A member
 * whose reply has landed but waits its turn (`typingIds`) still counts as typing until its bubble takes over. With the
 * speaker's reply `landed` and nobody else at work, the line is gone in that frame, with no exit left to play. */
export function RoomWorkingLines({ group, members, workingIds, typingIds = [], speaker, slot, landed = false, networkWait = false }: {
  group: Pick<Group, "id" | "turnStartedAt">;
  members: readonly Bot[];
  workingIds: readonly string[];
  typingIds?: readonly string[];
  speaker: RoomSpeakerLine;
  slot: boolean;
  landed?: boolean;
  /** The person's last message waits for the device's network: the line says so, and no bot is at work yet. */
  networkWait?: boolean;
}) {
  const speakerId = speaker.bot?.id;
  // the speaker's turn shows only while its own line would: its settled reply at the tail ends it before busy clears
  const ids = [...(speaker.visible && speakerId ? [speakerId] : []), ...workingIds.filter((id) => id !== speakerId), ...typingIds]
    .filter((id, index, all) => all.indexOf(id) === index && members.some((member) => member.id === id));
  const ordered = useArrivalOrder(ids);
  // the line leaves still showing who it was about
  const last = useRef<string[]>([]);
  if (ordered.length > 0) last.current = ordered;
  const bots = last.current.map((id) => members.find((member) => member.id === id)).filter((bot): bot is Bot => Boolean(bot));
  const typing = new Set(typingIds);
  const verb: RoomVerb = typing.size > 0 || speaker.phase === TYPING_PHASE ? "typing" : speaker.phase === "friendly:thinking" ? "thinking" : "working";
  const several = bots.length > 1;
  const solo = bots[0];
  const soloTyping = solo ? typing.has(solo.id) : false;
  const words = several
    ? { label: roomStatusPhrase(bots.map((bot) => bot.name), verb) }
    : soloTyping ? { phrases: [t("chat.typing")], phase: TYPING_PHASE }
    : solo?.id === speakerId ? { phrases: speaker.phrases, phase: speaker.phase }
    : friendlyNowPhrases(null);
  // each answering face lives its own quiet wait, as the 1:1 chat's mark does: the mascot, its typing dots, then the reply
  const speakerTyping = speaker.markState === "streaming" || speaker.phase === TYPING_PHASE;
  const lives = useReplyLife(ordered.map((id) => ({ key: id, seed: `${group.id}:${group.turnStartedAt ?? ""}:${id}`, typing: typing.has(id) || (id === speakerId && speakerTyping) })));
  const stateOf = (bot: Bot): MarkState => lifeMarkState(typing.has(bot.id) ? "streaming" : bot.id === speakerId ? speaker.markState : "thinking", lives.get(bot.id));
  if (networkWait) {
    return (
      <div className={slot ? "turn-status-slot h-9 shrink-0" : "contents"} data-room-working-lines="" data-room-working-count={0}>
        <TurnPresence avatar={null} simple wordsAtOnce visible label={t("mobile.chat.waitingForConnection")} seed={`${group.id}:network`} since={null} />
      </div>
    );
  }
  return (
    <div className={slot ? "turn-status-slot h-9 shrink-0" : "contents"} data-room-working-lines="" data-room-working-count={ordered.length}>
      {!(landed && ordered.length === 0) && <TurnPresence
        avatar={
          <BotFaces
            members={bots}
            size={several ? 22 : 28}
            working={new Set(bots.map((bot) => bot.id))}
            stateOf={stateOf}
            eyeInk="var(--color-app)"
            overlap={several ? 6 : 0}
            ground="var(--color-app)"
            motion
          />
        }
        simple
        visible={ordered.length > 0}
        {...words}
        seed={`${group.id}:${group.turnStartedAt ?? ""}:${last.current.join(",")}`}
        since={speaker.since}
      />}
    </div>
  );
}
