import { use } from "react";

import { LiveToolsContext } from "@/hooks/use-live-tool-ids";
import { runsOnHost } from "@/lib/cloud-move";
import { writeComputerPanelView } from "@/lib/computer-panel-view";
import { useOtherServerName } from "@/lib/other-server";
import { storeApp } from "@/lib/store-app";
import { useStore, type Message } from "@/state/store";
import { useTurnLive } from "@/state/turn-status";
import { useDesktopCapabilities } from "../DesktopCapabilities";
import { BrowserCard } from "./BrowserCard";
import type { BrowserStep } from "./browser-step";
import { CommandRows } from "./CommandRows";
import type { LiveCardBot } from "./LiveCard";
import { liveSegments } from "./live-step";

export function browsingNow({ steps, through, live, room, turnEnded, replying }: {
  steps: readonly BrowserStep[];
  through: readonly string[];
  live: ReadonlySet<string>;
  room: boolean;
  turnEnded: boolean;
  replying: boolean;
}): boolean {
  const last = steps.at(-1);
  if (!last || turnEnded || replying || !live.has(last.id)) return false;
  const newest = [...live].at(-1);
  return through.includes(newest!) || (room && last.tool.ok === undefined);
}

function useBrowserPanel(botId: string | undefined, room: boolean): (() => void) | undefined {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const otherServer = useOtherServerName();
  const host = runsOnHost({ cloudHome: state.config?.cloudHome === true, otherServer, platform: capabilities.host?.platform ?? "other" });
  if (room || !botId || storeApp() || (host.kind !== "mac" && host.kind !== "pc")) return undefined;
  return () => {
    writeComputerPanelView(botId, "browser");
    dispatch({ type: "toggleComputer", open: true });
  };
}

function BrowserStretch({ steps, through, bot, threadId, live, room }: {
  steps: readonly BrowserStep[]; through: readonly string[]; bot: LiveCardBot; threadId?: string; live: ReadonlySet<string>; room: boolean;
}) {
  const turn = useTurnLive(threadId);
  const openPanel = useBrowserPanel(bot.id, room);
  const running = browsingNow({ steps, through, live, room, turnEnded: turn.ended, replying: turn.status?.activity === "reply" });
  return (
    <div className="contents" data-mid={steps[0]!.id}>
      <BrowserCard steps={steps} bot={bot} threadId={threadId} running={running} onOpenPanel={openPanel} />
    </div>
  );
}

export function LiveRows({ messages, bot, threadId, liveIds, room = false }: {
  messages: readonly Message[]; bot: LiveCardBot; threadId?: string; liveIds?: ReadonlySet<string>; room?: boolean;
}) {
  const fromContext = use(LiveToolsContext);
  const live = liveIds ?? fromContext;
  const segments = liveSegments(messages);
  if (segments.length === 0) return null;
  if (segments.every((segment) => segment.kind === "command")) return <CommandRows messages={messages} bot={bot} threadId={threadId} liveIds={live} />;
  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5" data-live-rows={segments.length}>
      {segments.map((segment) => segment.kind === "command"
        ? <CommandRows key={segment.steps[0]!.id} messages={segment.steps} bot={bot} threadId={threadId} liveIds={live} />
        : <BrowserStretch key={segment.steps[0]!.id} steps={segment.steps} through={segment.through} bot={bot} threadId={threadId} live={live} room={room} />)}
    </div>
  );
}
