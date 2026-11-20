import { useMemo, useState, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { usePageOpener } from "@/lib/page-open";
import { usePhoneLayout } from "@/lib/use-media-query";
import { useStore, visibleMessages, type Bot, type Message } from "@/state/store";
import { useLocalFileSave } from "../AttachmentPreview";
import { recentChangedFiles, sharedFileReferences } from "../ComputerFilesPane";
import { Icon } from "../Icon";
import { chipNameAction, useFilePreview } from "../HtmlFilePreview";
import { FileKindIcon } from "./FileKindIcon";
import type { SimplePageId } from "./page-registry";
import { Card, LabelAction, PanelEmpty } from "./rows";

export interface LibraryItems {
  pages: Array<{ messageId: string; title: string; url: string }>;
  apps: Array<{ messageId: string; title: string }>;
  shared: Array<NonNullable<ReturnType<ReturnType<typeof sharedFileReferences>["get"]>>>;
  unshared: string[];
}

/** What the bot made in the open conversation, newest first: its live published pages, its apps, and its files. */
export function libraryItems(bot: Bot, messages: readonly Message[] = visibleMessages(bot)): LibraryItems {
  const pages: LibraryItems["pages"] = [];
  const apps: LibraryItems["apps"] = [];
  const seenPages = new Set<string>();
  for (const message of [...messages].reverse()) {
    const page = message.publishedPage;
    if (page?.state === "live" && page.url && !seenPages.has(page.url)) {
      seenPages.add(page.url);
      pages.push({ messageId: message.id, title: page.title || page.url, url: page.url });
    }
    if (message.kind === "app" && message.app?.doc) apps.push({ messageId: message.id, title: message.app.title });
  }
  const references = sharedFileReferences(bot);
  const shared: LibraryItems["shared"] = [];
  const seenFiles = new Set<string>();
  for (const reference of references.values()) {
    if (seenFiles.has(reference.file.path)) continue;
    seenFiles.add(reference.file.path);
    shared.push(reference);
  }
  const unshared = recentChangedFiles(bot).filter((path) => !references.has(path));
  return { pages, apps, shared, unshared };
}

const fileName = (path: string) => path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);

type GroupKey = "today" | "week" | "older";
const GROUPS: readonly GroupKey[] = ["today", "week", "older"];
const GROUP_LABEL = { today: "botPanel.library.today", week: "botPanel.library.week", older: "botPanel.library.older" } as const;
const STEP = 5;

function dayStart(now: number, daysBack: number): number {
  const day = new Date(now);
  day.setDate(day.getDate() - daysBack);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** Grok's library groups: made today, in the six days before, or earlier. */
export function libraryGroup(at: number | undefined, now: number): GroupKey {
  if (at === undefined) return "older";
  return at >= dayStart(now, 0) ? "today" : at >= dayStart(now, 6) ? "week" : "older";
}

/** The short age Grok shows on a hovered row: 9m, 3h, 2d, then the date. */
export function shortAge(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return t("botPanel.library.now");
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface Entry {
  key: string;
  at?: number;
  render: (age: string | null) => ReactNode;
}

const rowCls = "group flex min-h-9 w-full min-w-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[13px] leading-[18px] tracking-[0.015em] text-ink";
const leadCls = "flex size-6 shrink-0 items-center justify-center text-ink-secondary";

function RowBody({ lead, name, age }: { lead: ReactNode; name: string; age: string | null }) {
  return (
    <>
      <span className={leadCls}>{lead}</span>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {age && (
          <span className="shrink-0 text-ink/[0.56] opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-visible:opacity-100 group-focus-within:opacity-100 touch:opacity-100">{age}</span>
        )}
      </span>
    </>
  );
}

function ActionRow({ name, lead, age, onClick, ...rest }: { name: string; lead: ReactNode; age: string | null; onClick: () => void; "data-panel-row"?: string }) {
  return (
    <button
      type="button"
      {...rest}
      title={name}
      onClick={onClick}
      className={cn(rowCls, "cursor-pointer hover:bg-ink/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus")}
    >
      <RowBody lead={lead} name={name} age={age} />
    </button>
  );
}

/** A shared file: its name opens an HTML preview or saves it, as its chip in the conversation does. */
function FileRow({ reference, age }: { reference: LibraryItems["shared"][number]; age: string | null }) {
  const { file, message } = reference;
  const save = useLocalFileSave(file.path, file.name, message);
  const preview = useFilePreview(file.path, file.name, message);
  const usable = file.private || file.linked;
  if (!usable) {
    return (
      <div data-panel-row="file" title={t("attach.legacyFile", { name: file.name })} className={cn(rowCls, "opacity-60")}>
        <RowBody lead={<FileKindIcon name={file.name} />} name={file.name} age={age} />
      </div>
    );
  }
  const action = chipNameAction(preview, save, file.name, save.state === "failed" && !save.outsideWorkspace);
  return (
    <>
      <button
        type="button"
        data-panel-row="file"
        title={file.name}
        onClick={action.onClick}
        disabled={action.disabled}
        aria-label={action["aria-label"]}
        className={cn(rowCls, "cursor-pointer hover:bg-ink/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-wait")}
      >
        <RowBody lead={<FileKindIcon name={file.name} />} name={file.name} age={age} />
      </button>
      {preview.dialog}
    </>
  );
}

function Group({ group, entries, now }: { group: GroupKey; entries: Entry[]; now: number }) {
  const [count, setCount] = useState(STEP);
  return (
    <Card label={t(GROUP_LABEL[group])} anchor={`library-${group}`}>
      {entries.slice(0, count).map((entry) => (
        <div key={entry.key} className="min-w-0">{entry.render(entry.at === undefined ? null : shortAge(entry.at, now))}</div>
      ))}
      {count < entries.length && (
        <button
          type="button"
          data-panel-action="show-more"
          onClick={() => setCount((shown) => shown + STEP)}
          className="flex h-8 w-full items-center justify-center rounded-lg text-[13px] leading-[18px] tracking-[0.015em] text-ink-secondary hover:bg-ink/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {t("botPanel.library.showMore")}
        </button>
      )}
    </Card>
  );
}

/** Everything the bot made in this conversation as Library rows, newest first, with when each was made. */
function useLibraryEntries(bot: Bot): Entry[] {
  const { dispatch } = useStore();
  const openPage = usePageOpener();
  const phone = usePhoneLayout();
  const items = useMemo(() => libraryItems(bot), [bot]);
  const showInChat = (messageId: string) => {
    dispatch({ type: "focusMessage", threadId: bot.threadId, messageId });
    if (phone) dispatch({ type: "toggleSettings", open: false });
  };

  const messages = visibleMessages(bot);
  const atOf = (messageId: string) => messages.find((message) => message.id === messageId)?.at;
  const changedAt = new Map<string, number>();
  for (const message of messages) {
    const files = message.digest?.files;
    if (files) for (const path of [...files.added, ...files.changed]) changedAt.set(path, message.at);
  }

  return [
    ...items.pages.map((page): Entry => ({
      key: `page:${page.url}`,
      at: atOf(page.messageId),
      render: (age) => <ActionRow data-panel-row="page" name={page.title} lead={<Icon name="globe" size={16} />} age={age} onClick={() => openPage(page.url)} />,
    })),
    ...items.apps.map((app): Entry => ({
      key: `app:${app.messageId}`,
      at: atOf(app.messageId),
      render: (age) => <ActionRow data-panel-row="app" name={app.title} lead={<Icon name="sparkle" size={16} />} age={age} onClick={() => showInChat(app.messageId)} />,
    })),
    ...items.shared.map((reference): Entry => ({
      key: `file:${reference.message.messageId}:${reference.file.path}`,
      at: atOf(reference.message.messageId),
      render: (age) => <FileRow reference={reference} age={age} />,
    })),
    ...items.unshared.map((path): Entry => ({
      key: `changed:${path}`,
      at: changedAt.get(path),
      render: (age) => (
        <div data-panel-row="changed" title={t("computer.files.notSharedHint")} className={rowCls}>
          <RowBody lead={<FileKindIcon name={fileName(path)} />} name={fileName(path)} age={age} />
        </div>
      ),
    })),
  ].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

/** Grok's Library: everything the bot made in this conversation, newest first, under Today, This week and Older. */
export function LibraryPage({ bot }: { bot: Bot }) {
  const entries = useLibraryEntries(bot);
  const now = Date.now();
  if (entries.length === 0) {
    return (
      <div data-panel-library="">
        <PanelEmpty data-panel-empty="library">{t("botPanel.library.empty")}</PanelEmpty>
      </div>
    );
  }
  return (
    <div data-panel-library="">
      {GROUPS.map((group) => {
        const inGroup = entries.filter((entry) => libraryGroup(entry.at, now) === group);
        return inGroup.length > 0 && <Group key={group} group={group} entries={inGroup} now={now} />;
      })}
    </div>
  );
}

const PREVIEW = 3;

/** The Advanced tab's Library section: the newest few things the bot made, and View all for the whole Library. */
/** `quietWhenEmpty`: an empty Library says nothing, under the bot's Files or on the phone's Advanced tab. */
export function LibrarySection({ bot, onOpen, quietWhenEmpty = false }: { bot: Bot; onOpen: (page: SimplePageId) => void; quietWhenEmpty?: boolean }) {
  const entries = useLibraryEntries(bot);
  const now = Date.now();
  const more = entries.length > PREVIEW;
  // nothing made yet reads as grok's empty Library tab, the centred line with no card, as Details does for routines
  if (entries.length === 0) {
    if (quietWhenEmpty) return null;
    return (
      <section data-panel-card="library">
        <PanelEmpty data-panel-empty="library">{t("botPanel.library.empty")}</PanelEmpty>
      </section>
    );
  }
  return (
    <Card
      label={t("botPanel.tab.library")}
      anchor="library"
      action={more ? <LabelAction data-panel-page="library" onClick={() => onOpen("library")}>{t("botPanel.library.viewAll")}</LabelAction> : undefined}
    >
      {entries.slice(0, PREVIEW).map((entry) => (
        <div key={entry.key} className="min-w-0">{entry.render(entry.at === undefined ? null : shortAge(entry.at, now))}</div>
      ))}
    </Card>
  );
}
