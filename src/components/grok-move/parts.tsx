import { useState, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import { activeLocale } from "@/lib/i18n";
import type { StoredBodyId } from "../../../shared/bot-body";
import type { GrokBotLook } from "../../../shared/grok-move";
import { MausAvatar } from "../Avatar";

/** The bot as it looked in Grok Bot: its photo, else the nearest colour and body here. */
export function BotFace({ look, size = 32 }: { look: GrokBotLook; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (look.photoUrl && !failed) {
    return (
      <img src={look.photoUrl} alt="" width={size} height={size} draggable={false} onError={() => setFailed(true)}
        className="block shrink-0 rounded-full bg-ink/[0.06] object-cover" style={{ width: size, height: size }} />
    );
  }
  return <MausAvatar color={look.color} bodyId={look.body as StoredBodyId | undefined} size={size} trackPointer={false} animated={false} label="" />;
}

export function Chip({ children, tone = "plain", ...rest }: { children: ReactNode; tone?: "plain" | "warn" | "done"; "data-grok-chip"?: string }) {
  return (
    <span {...rest} className={cn(
      "inline-flex h-5 max-w-full items-center truncate rounded-full px-2 text-[11px] leading-4 tracking-[0.01em]",
      tone === "warn" ? "bg-danger/10 text-danger" : tone === "done" ? "bg-ink/[0.08] text-ink" : "bg-ink/[0.05] text-ink-secondary",
    )}>{children}</span>
  );
}

export const listOf = (parts: readonly string[]) => new Intl.ListFormat(activeLocale(), { style: "long", type: "conjunction" }).format(parts);

export const sectionLabelCls = "m-0 mb-1.5 px-1 text-[12px] font-normal leading-4 tracking-[0.01em] text-ink-secondary";
export const quietLinkCls = "inline-flex min-h-7 items-center gap-1 rounded-full px-2 text-[12px] leading-4 text-ink-secondary transition-colors duration-150 ease-[ease] hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus disabled:opacity-50 motion-reduce:transition-none";
export const rowCardCls = "flex flex-col rounded-[14px] bg-ink/[0.03]";

/** A slow breath beside a line that is still going. */
export const Breath = () => <span aria-hidden="true" className="funnel-wait inline-block size-1.5 shrink-0 rounded-full bg-ink/60" />;
