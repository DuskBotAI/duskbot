import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { REACTIONS, reactorBotId, type Reaction } from "../../shared/reactions";
import { messageActionClass } from "@/components/MessageActions";
import { Icon } from "./Icon";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { useCanWriteIn, useReactor } from "@/lib/cloud-guest";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { api, type Bot, type Message } from "@/state/store";
import { useStoreRef } from "@/state/store-ref";
import { action, feature } from "@/lib/product-analytics";
import { friendlyError } from "@/lib/plain-error";

const REACTION_WORD: Record<Reaction, string> = { "👍": "yes", "👎": "no", "❤️": "love", "😂": "laugh", "🎉": "celebrate", "👀": "looking" };

const LABEL: Record<Reaction, LocaleKey> = {
  "👍": "chat.reaction.yes",
  "👎": "chat.reaction.no",
  "❤️": "chat.reaction.love",
  "😂": "chat.reaction.laugh",
  "🎉": "chat.reaction.celebrate",
  "👀": "chat.reaction.looking",
};

const labelOf = (emoji: string) => (Object.hasOwn(LABEL, emoji) ? t(LABEL[emoji as Reaction]) : emoji);

type Entry = NonNullable<Message["reactions"]>[number];
const sameEntry = (a: Entry | null | undefined, b: Entry | null | undefined) => a?.emoji === b?.emoji && a?.at === b?.at;

function withOwn(message: Message, by: string, entry: Entry | null | undefined): Message {
  const reactions = [...(message.reactions ?? []).filter((reaction) => reaction.by !== by), ...(entry ? [entry] : [])];
  return { ...message, reactions: reactions.length ? reactions : undefined };
}

/** The newest tap on each message, from any of its controls: the server's answer to an older tap is out of date. */
const newestTap = new Map<string, number>();
let taps = 0;

function useReaction(threadId: string, message: Message) {
  const { dispatch } = useStoreRef();
  const me = useReactor();
  const latest = useRef(message);
  useLayoutEffect(() => { latest.current = message; });
  const own = message.reactions?.find((reaction) => reaction.by === me);
  const mine = own?.emoji ?? null;
  const react = (emoji: Reaction) => {
    const on = mine !== emoji;
    const shown = on ? { emoji, by: me, at: Date.now() } : null;
    const key = `${threadId}:${message.id}`;
    const tap = ++taps;
    newestTap.set(key, tap);
    const newest = () => newestTap.get(key) === tap;
    dispatch({ type: "messagePatched", threadId, message: withOwn(message, me, shown) });
    api<{ message?: Message }>(`/api/threads/${threadId}/messages/${message.id}/reactions`, {
      method: "POST",
      body: JSON.stringify({ emoji, on }),
    })
      .then((body) => {
        if (on) { feature("reaction_added"); action("reply_reaction", { emoji: REACTION_WORD[emoji], on: true }); }
        if (body.message && newest()) dispatch({ type: "messagePatched", threadId, message: body.message });
      })
      .catch((error: unknown) => {
        const now = latest.current.reactions?.find((reaction) => reaction.by === me);
        if (newest() && (sameEntry(now, shown) || sameEntry(now, own))) dispatch({ type: "messagePatched", threadId, message: withOwn(latest.current, me, own) });
        dispatch({ type: "error", message: friendlyError(error) });
      })
      .finally(() => { if (newest()) newestTap.delete(key); });
  };
  return { me, mine, react };
}

export function ReactAction({ threadId, message }: { threadId: string; message: Message }) {
  const { mine, react } = useReaction(threadId, message);
  const [open, setOpen] = useState(false);
  const [end, setEnd] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus({ preventScroll: true });
  };
  usePopoverDismiss(open, rootRef, () => close(rootRef.current?.contains(document.activeElement) ?? false));

  useLayoutEffect(() => {
    if (!open) return;
    const box = rowRef.current?.getBoundingClientRect();
    const button = buttonRef.current?.getBoundingClientRect();
    if (box && button) setEnd(button.left + box.width > window.innerWidth - 8 && button.right - box.width >= 8);
    const choices = [...(rowRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    (choices.find((choice) => choice.getAttribute("aria-pressed") === "true") ?? choices[0])?.focus({ preventScroll: true });
  }, [open]);

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    const choices = [...(rowRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const index = choices.indexOf(document.activeElement as HTMLButtonElement);
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const forward = rtl ? "ArrowLeft" : "ArrowRight";
    const back = rtl ? "ArrowRight" : "ArrowLeft";
    const next = event.key === forward ? index + 1 : event.key === back ? index - 1
      : event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1 : null;
    if (next === null || !choices.length) return;
    event.preventDefault();
    choices[(next + choices.length) % choices.length]?.focus();
  };

  return (
    <div
      ref={rootRef}
      className="relative"
      onBlur={(event) => { if (!(event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget))) setOpen(false); }}
    >
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={t("chat.react")}
        title={open ? undefined : t("chat.react")}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        className={cn(messageActionClass, open && "bg-ink/[0.06]")}
      >
        <Icon name="smiley-happy" size={14} />
      </button>
      {open && (
        <div
          ref={rowRef}
          id={id}
          role="toolbar"
          aria-label={t("chat.reactions")}
          onKeyDown={onKey}
          className={cn(
            "popover-surface animate-pop-in absolute top-full z-40 mt-1 flex origin-top-left items-center gap-1 rounded-full bg-menu p-1.5 shadow-(--shadow-popover)",
            end ? "end-0" : "start-0",
          )}
        >
          {REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-pressed={mine === emoji}
              aria-label={labelOf(emoji)}
              onClick={() => {
                react(emoji);
                close(true);
              }}
              className={cn(
                "flex size-8 items-center justify-center rounded-full text-[20px] leading-none hover:bg-ink/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                mine === emoji && "bg-ink/[0.08]",
              )}
            >
              <span aria-hidden="true">{emoji}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export const useCanReact = (threadId: string) => useCanWriteIn(threadId) !== false;

/** `float`: grok's tapbacks, white pills riding the bubble's top corner instead of a row under it. */
type ChipProps = { threadId: string; message: Message; bots?: readonly Bot[]; align?: "start" | "end"; canReact?: boolean; float?: boolean };

export function ReactionChips(props: ChipProps) {
  return props.message.reactions?.length ? <Chips {...props} /> : null;
}

function Chips({ threadId, message, bots = [], align = "start", canReact = true, float = false }: ChipProps) {
  const { me, mine, react } = useReaction(threadId, message);
  const reactions = message.reactions ?? [];
  const nameOf = (reaction: NonNullable<Message["reactions"]>[number]) => {
    if (reaction.by === me) return t("chat.you");
    const botId = reactorBotId(reaction.by) ?? reaction.by;
    return bots.find((bot) => bot.id === botId)?.name ?? reaction.name ?? t("approval.someone");
  };
  const justNow = Date.now() - 4_000;
  const shown = [...new Set(reactions.map((reaction) => reaction.emoji))]
    .sort((a, b) => REACTIONS.indexOf(a as Reaction) - REACTIONS.indexOf(b as Reaction))
    .map((emoji) => {
      const chose = reactions.filter((reaction) => reaction.emoji === emoji);
      return { emoji, people: chose.map(nameOf), botsOnly: chose.every((reaction) => reactorBotId(reaction.by)), fresh: chose.some((reaction) => (reaction.at ?? 0) > justNow) };
    });
  return (
    <div role="group" aria-label={t("chat.reactions")} data-copy-skip={float ? "" : undefined}
      className={cn("flex flex-wrap gap-1", float ? cn("absolute -top-[22px] z-[1]", align === "end" ? "-start-4" : "-end-4") : cn("mt-1", align === "end" ? "justify-end" : "justify-start"))}>
      {shown.map(({ emoji, people, botsOnly, fresh }) => {
        const label = t("chat.reaction.chip", { reaction: labelOf(emoji), people: people.join(", ") });
        const chip = float
          ? cn("chat-reaction-pill flex h-[30px] items-center rounded-full bg-composer px-[7px] text-[12px] leading-4 text-ink/[0.68]", fresh && "chat-reaction-pop")
          : cn(
            "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[13px] leading-5",
            fresh && "animate-pop-in",
            mine === emoji ? "border-transparent bg-ink/[0.08]" : "border-transparent bg-panel",
          );
        const face = (
          <>
            <span aria-hidden="true" className={float ? "text-[16px] leading-4" : undefined}>{emoji}</span>
            {people.length > 1 && <span aria-hidden="true" className="text-[12px] tabular-nums text-ink-secondary">{people.length}</span>}
          </>
        );
        return canReact && !botsOnly && Object.hasOwn(LABEL, emoji) ? (
          <button key={emoji} type="button" aria-pressed={mine === emoji} aria-label={label} title={people.join(", ")}
            onClick={() => react(emoji as Reaction)}
            className={cn(chip, float ? "composer-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" : "hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus")}>
            {face}
          </button>
        ) : (
          <span key={emoji} role="img" aria-label={label} title={people.join(", ")} className={chip}>{face}</span>
        );
      })}
    </div>
  );
}
