import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import type { ReplyBlock } from "@/lib/formatted-reply";
import { joinedCorners, SIMPLE_BOT_BUBBLE, SIMPLE_BUBBLE_MAX, type BubbleJoin } from "./chat-bubble";

/** Simple mode's reply with tables: the prose in bubbles and each table in its own card, which may grow past a bubble's
 * width to the message's full width, so every column shows. The first and last prose bubbles take the row's join corners; a table breaks the join. The hover
 * tray sits beside the first block. */
export function ReplyBlocks({ blocks, join, tray, render, chips }: {
  blocks: readonly ReplyBlock[];
  join?: BubbleJoin;
  tray?: ReactNode;
  render: (text: string) => ReactNode;
  /** Grok's tapbacks, riding the last bubble's top corner. */
  chips?: ReactNode;
}) {
  const last = blocks.length - 1;
  let chipsAt = -1;
  if (chips) for (let index = last; index >= 0 && chipsAt < 0; index--) if (blocks[index]!.kind !== "table") chipsAt = index;
  return (
    <div data-reply-blocks className="flex w-full flex-col items-start gap-1">
      {blocks.map((block, index) => {
        const body = block.kind === "table"
          ? <div key={index} data-reply-table className="my-2 w-full first:mt-0 last:mb-0">{render(block.text)}</div>
          : (
            <div key={index} data-chat-bubble="simple" data-reacted={index === chipsAt ? "" : undefined} className={cn("w-fit", SIMPLE_BUBBLE_MAX, SIMPLE_BOT_BUBBLE, index === chipsAt && index > 0 && "mt-[26px]",
              joinedCorners("start", { above: index === 0 && Boolean(join?.above), below: index === last && Boolean(join?.below) }))}>
              {render(block.text)}
              {index === chipsAt && chips}
            </div>
          );
        return index === 0 && tray ? <div key={index} className="flex w-full items-center gap-1.5">{body}{tray}</div> : body;
      })}
    </div>
  );
}
