import { useId, useMemo } from "react";

import { useLiveToolIds } from "@/hooks/use-live-tool-ids";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { roomThreadWorking } from "@/lib/room-threads";
import { currentTaskBot, type Bot, type Group } from "@/state/store";
import { useTurnLive } from "@/state/turn-status";
import { BrowserCard } from "../live-cards/BrowserCard";
import { CommandCard } from "../live-cards/CommandCard";
import { browsingNow, latestTurn, stepUnits, type StepUnit } from "../live-cards/live-step";
import { CardLabel } from "./rows";

function BrowserUnit({ unit, bot, threadId, live, room, pictures }: {
  unit: Extract<StepUnit, { kind: "browser" }>; bot: Bot; threadId: string; live: ReadonlySet<string>; room: boolean; pictures: boolean;
}) {
  const turn = useTurnLive(threadId);
  const running = browsingNow({ steps: unit.steps, through: unit.through, live, room, turnEnded: turn.ended, replying: turn.status?.activity === "reply" });
  return <BrowserCard steps={unit.steps} bot={bot} threadId={threadId} running={running} pictures={pictures} />;
}

export function PanelSteps({ bot, room, pictures, className }: { bot: Bot; room?: Group; pictures: boolean; className?: string }) {
  const labelId = useId();
  const messages = room ? room.messages : bot.messages;
  const threadId = room ? room.threadId : bot.threadId;
  const live = useLiveToolIds(messages, room ? { busy: roomThreadWorking(room, room.threadId), turnStartedAt: room.turnStartedAt } : currentTaskBot(bot));
  const units = useMemo(
    () => stepUnits(latestTurn(messages, room ? (message) => message.from?.botId === bot.id : undefined)).reverse(),
    [messages, room, bot.id],
  );
  if (units.length === 0) return null;
  return (
    <section data-panel-steps={units.length} aria-labelledby={labelId} className={cn("[&_.live-card]:w-full", className)}>
      <CardLabel id={labelId}>{t("botPanel.steps.title")}</CardLabel>
      <div className="flex flex-col gap-1.5">
        {units.map((unit) => (
          <div key={unit.id} className="contents" data-mid={unit.id}>
            {unit.kind === "command"
              ? <CommandCard message={unit.step} bot={bot} threadId={threadId} live={live.has(unit.id)} />
              : <BrowserUnit unit={unit} bot={bot} threadId={threadId} live={live} room={Boolean(room)} pictures={pictures} />}
          </div>
        ))}
      </div>
    </section>
  );
}
