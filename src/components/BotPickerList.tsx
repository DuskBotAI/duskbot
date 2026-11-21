import { useLayoutEffect, useRef, useState } from "react";
import type { Bot } from "@/state/store";
import { teamBotName, useTeamPeople } from "@/state/team-people";
import { BotAvatar } from "./Avatar";
import { CheckRow } from "./ListRows";
import { cn } from "@/lib/cn";

/** Bots to pick as rows: the face, the name and Grok's small check on the chosen ones. A long list scrolls without a bar,
 * fading out at the edge that has more. */
export function BotPickerList({
  bots,
  picked,
  onToggle,
  emptyHint,
  inline = false,
}: {
  bots: Bot[];
  picked: Set<string>;
  onToggle: (id: string) => void;
  emptyHint: string;
  inline?: boolean;
}) {
  const team = useTeamPeople();
  const list = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ above: false, below: false });
  const measure = () => {
    const element = list.current;
    if (!element) return;
    const above = element.scrollTop > 1;
    const below = element.scrollTop + element.clientHeight < element.scrollHeight - 1;
    setMore((current) => (current.above === above && current.below === below ? current : { above, below }));
  };
  useLayoutEffect(measure, [bots.length, inline]);
  const rows = (
    <>
      {bots.length === 0 && <div className="px-2 py-4 text-center text-[13px] leading-[18px] text-ink/68">{emptyHint}</div>}
      {bots.map((b) => (
        <CheckRow
          key={b.id}
          data-bot-id={b.id}
          aria-label={teamBotName(b, team)}
          leading={<BotAvatar bot={b} state="happy" size={20} animated={false} />}
          title={<span className="block truncate">{teamBotName(b, team)}</span>}
          checked={picked.has(b.id)}
          onClick={() => onToggle(b.id)}
        />
      ))}
    </>
  );
  if (inline) return rows;
  return (
    <div
      ref={list}
      onScroll={measure}
      className={cn(
        "flex max-h-64 flex-col overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        more.below && !more.above && "[mask-image:linear-gradient(to_bottom,black_calc(100%-32px),transparent)]",
        more.above && !more.below && "[mask-image:linear-gradient(to_top,black_calc(100%-32px),transparent)]",
        more.above && more.below && "[mask-image:linear-gradient(to_bottom,transparent,black_32px,black_calc(100%-32px),transparent)]",
      )}
    >
      {rows}
    </div>
  );
}
