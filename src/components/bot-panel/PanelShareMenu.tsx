import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { phoneApp } from "@/lib/store-app";
import { systemMenu } from "@/lib/system-menu";
import { SheetPush } from "@/mobile/SheetPush";
import { useStore, type Bot } from "@/state/store";
import { BotAvatar } from "../Avatar";
import { useChatMoreItems } from "../ChatMoreMenu";
import { Icon, type IconName } from "../Icon";
import { useMenuMotion } from "../MenuMotion";
import { saveAccess } from "../bot-access/access";
import { UndoToast, useTeamName } from "../bot-access/ShareBotButton";
import { ShareBotDialog, type AccessChange } from "../bot-access/ShareBotDialog";
import { roundButtonCls } from "./rows";
import { BOT_SHARING_ENABLED } from "../../../shared/bot-sharing";

const GAP = 4;

interface Entry {
  key: string;
  title: string;
  hint: ReactNode;
  detail?: string;
  tile: ReactNode;
  disabled?: boolean;
  keepOpen?: boolean;
  onSelect: () => void;
}

const SHARE_KEYS = ["copy", "download"];
const MORE_ICON: Record<string, IconName> = { usage: "gauge", activity: "list-checks" };
const SHARE_SYMBOL: Record<string, string> = {
  people: "person.2",
  duplicate: "doc.on.doc",
  copy: "doc.on.clipboard",
  download: "arrow.down.circle",
  usage: "gauge.with.needle",
  activity: "checklist",
};

/** Grok's icon tile: a 36px elevated circle in a 40px slot. */
function IconTile({ name }: { name: IconName }) {
  return (
    <span aria-hidden="true" className="relative flex size-10 shrink-0 items-center justify-center">
      <span className="flex size-9 items-center justify-center rounded-full border-[0.5px] border-edge bg-composer text-ink">
        <Icon name={name} size={16} />
      </span>
    </span>
  );
}

/** Grok's Share on the panel, one menu of rich items under the button's right edge: share the bot (a copy, or on a team
 * who can use it) and this chat (copy, download), then the chat's usage and Activity. */
export function PanelShareMenu({ bot }: { bot: Bot }) {
  // a "Copied" note never follows the panel into another conversation
  return <ShareMenu key={bot.threadId} bot={bot} />;
}

function ShareMenu({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const team = useTeamName();
  const { items } = useChatMoreItems(bot);
  const [open, setOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [change, setChange] = useState<AccessChange | null>(null);
  const settled = useCallback(() => setChange(null), []);
  const motion = useMenuMotion(open);
  const [place, setPlace] = useState<{ top: number; right: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };

  const trailingText = (key: string) => {
    const trailing = items.find((item) => item.key === key)?.trailing;
    return typeof trailing === "string" ? trailing : undefined;
  };
  const status = (key: string) => {
    const trailing = items.find((item) => item.key === key)?.trailing;
    return trailing ? <span className="contents">{trailing}</span> : null;
  };
  const shareRows: Array<Entry | null> = [
    team
      ? BOT_SHARING_ENABLED ? { key: "people", title: t("botPanel.share.people"), hint: t("botPanel.share.peopleHint", { name: bot.name }), detail: t("botPanel.share.peopleHint", { name: bot.name }), tile: <IconTile name="people" />, onSelect: () => setSharing(true) } : null
      : {
          key: "duplicate",
          title: t("botPanel.share.copy"),
          hint: t("botPanel.share.copyHint"),
          detail: t("botPanel.share.copyHint"),
          // grok draws the bot and its copy: the copy up and to the right, paler
          tile: (
            <span aria-hidden="true" className="relative size-10 shrink-0">
              <span className="absolute right-0.5 top-0.5 flex opacity-55"><BotAvatar bot={bot} size={20} animated={false} trackPointer={false} /></span>
              <span className="absolute bottom-0.5 left-0.5 flex"><BotAvatar bot={bot} size={20} animated={false} trackPointer={false} /></span>
            </span>
          ),
          onSelect: () => dispatch({ type: "duplicateBot", botId: bot.id }),
        },
    ...items.filter((item) => SHARE_KEYS.includes(item.key)).map((item): Entry => ({
      key: item.key,
      title: t(item.key === "copy" ? "botPanel.share.copyChat" : "botPanel.share.download"),
      hint: (item.key === "copy" && status("copy")) || t(item.key === "copy" ? "botPanel.share.copyChatHint" : "botPanel.share.downloadHint"),
      detail: (item.key === "copy" && trailingText("copy")) || t(item.key === "copy" ? "botPanel.share.copyChatHint" : "botPanel.share.downloadHint"),
      tile: <IconTile name={item.key === "copy" ? "copy" : "arrow-bracket-to-down"} />,
      disabled: item.disabled,
      keepOpen: item.keepOpen,
      onSelect: item.onSelect,
    })),
  ];
  const share = shareRows.filter((entry): entry is Entry => entry !== null);
  const more: Entry[] = items.filter((item) => item.key in MORE_ICON).map((item) => {
    const usageText = item.key === "usage" ? trailingText("usage") : undefined;
    return {
      key: item.key,
      title: item.label,
      hint: item.key === "usage" ? <>{status("usage")}{" · "}{t("botPanel.share.usageHint")}</>
        : t("botPanel.share.activityHint", { name: bot.name }),
      detail: item.key === "usage"
        ? (usageText ? `${usageText} · ${t("botPanel.share.usageHint")}` : t("botPanel.share.usageHint"))
        : t("botPanel.share.activityHint", { name: bot.name }),
      tile: <IconTile name={MORE_ICON[item.key]!} />,
      onSelect: item.onSelect,
    };
  });

  const openShare = () => {
    const native = systemMenu();
    if (native && trigger.current) {
      const rect = trigger.current.getBoundingClientRect();
      const nativeChrome = document.documentElement.hasAttribute("data-native-chrome");
      const anchor = !nativeChrome && rect.width > 0 && rect.height > 0
        ? rect
        : new DOMRect(Math.max(16, window.innerWidth - 60), 12, 44, 44);
      const all = [...share, ...more];
      void native(anchor, [
        ...share.map((entry) => ({
          key: entry.key,
          label: entry.title,
          detail: entry.detail,
          symbol: SHARE_SYMBOL[entry.key],
          disabled: entry.disabled,
        })),
        ...more.map((entry, index) => ({
          key: entry.key,
          label: entry.title,
          detail: entry.detail,
          symbol: SHARE_SYMBOL[entry.key],
          disabled: entry.disabled,
          separated: index === 0,
        })),
      ]).then((key) => {
        if (key !== null) all.find((entry) => entry.key === key)?.onSelect();
      });
      return;
    }
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const box = trigger.current.getBoundingClientRect();
    setPlace({ top: box.bottom + GAP, right: window.innerWidth - box.right });
  }, [open]);

  useEffect(() => {
    if (open && place) menu.current?.querySelector<HTMLElement>("[role=menuitem]:not(:disabled)")?.focus({ preventScroll: true });
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target)) close(false);
    };
    const dismiss = () => close(false);
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [open]);

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === "Tab") { close(); return; }
    const rows = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not(:disabled)") ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown" ? (at + 1) % rows.length
      : event.key === "ArrowUp" ? (at - 1 + rows.length) % rows.length
        : event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : null;
    if (next === null || rows.length === 0) return;
    event.preventDefault();
    rows[next]?.focus();
  };

  const row = (entry: Entry) => (
    <button
      key={entry.key}
      type="button"
      role="menuitem"
      data-panel-share-item={entry.key}
      disabled={entry.disabled}
      onClick={() => {
        if (!entry.keepOpen) close(false);
        entry.onSelect();
      }}
      className="relative flex w-full cursor-pointer items-center gap-2 px-1.5 py-[5px] text-left outline-none before:pointer-events-none before:absolute before:inset-0 before:rounded-[10px] before:content-[''] enabled:hover:before:bg-ink/[0.06] focus-visible:before:bg-ink/[0.06] disabled:cursor-default disabled:opacity-45"
    >
      {entry.tile}
      <span className="relative flex min-w-0 flex-col">
        <span className="truncate font-medium">{entry.title}</span>
        <span className="truncate text-[13px] leading-[18px] tracking-[0.015em] text-ink-secondary">{entry.hint}</span>
      </span>
    </button>
  );

  return (
    <>
      <button
        ref={trigger}
        type="button"
        data-panel-share=""
        aria-label={t("botPanel.share.menu")}
        title={t("chat.export.heading")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : openShare())}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
        className={roundButtonCls}
      >
        <Icon name="arrow-bracket-from-up" size={16} />
      </button>
      {typeof document !== "undefined" && createPortal(
        motion.shown && place && (
          <div
            ref={menu}
            role="menu"
            aria-label={t("botPanel.share.menu")}
            data-panel-share-menu=""
            {...motion.exitProps}
            onKeyDown={onMenuKey}
            style={{ top: place.top, right: place.right, transformOrigin: "right top" }}
            className={cn(motion.className, "fixed z-[2147482000] flex max-h-[calc(100dvh-80px)] w-[256px] max-w-[calc(100vw-16px)] flex-col gap-0.5 overflow-y-auto rounded-2xl bg-menu p-1.5 text-[14px] leading-5 tracking-[0.01em] text-ink shadow-(--shadow-popover) outline-none [scrollbar-width:none]")}
          >
            {share.map(row)}
            {more.length > 0 && <div role="separator" className="mx-2 my-1 h-px shrink-0 bg-ink/8" />}
            {more.map(row)}
          </div>
        ),
        document.body,
      )}
      {phoneApp() ? (
        team && BOT_SHARING_ENABLED && (
          <SheetPush
            open={sharing}
            onClose={() => setSharing(false)}
            title={t("botAccess.title", { bot: bot.name })}
            pageId="share-bot"
          >
            <ShareBotDialog embedded bot={bot} teamName={team} onClose={() => setSharing(false)} onChanged={setChange} />
          </SheetPush>
        )
      ) : (
        sharing && team && BOT_SHARING_ENABLED && <ShareBotDialog bot={bot} teamName={team} onClose={() => setSharing(false)} onChanged={setChange} />
      )}
      {change && <UndoToast key={`${change.text}:${JSON.stringify(change.after)}`} text={change.text}
        onUndo={() => saveAccess(bot.id, change.before)} onDone={settled} />}
    </>
  );
}
