import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { t } from "@/lib/i18n";
import { PANEL_PUSH, SWAP } from "@/lib/motion-presets";
import { MotionDiv } from "../ui/SheetMotion";
import { closeRoomPanel } from "@/lib/room-panel";
import type { LocaleKey } from "@/locales";
import { useStore, type Bot, type Group } from "@/state/store";
import { BotFaces } from "../BotFaces";
import { roomWorkingIds } from "../RoomWorkingLines";
import { useCaptionChrome } from "../DesktopCapabilities";
import { Icon } from "../Icon";
import { ManageMembersPage, ManageMembersPanel } from "../ManageMembersPanel";
import { TAB_LABEL, type PanelTab } from "../bot-panel/page-registry";
import { panelTabs, phoneApp, screenViewAllowed } from "@/lib/store-app";
import { wakeSystemControls } from "@/lib/system-control";
import { feel, phoneTabFade, phoneTabSlide } from "@/mobile/motion";
import { SheetPush } from "@/mobile/SheetPush";
import { pageSurfaceCls } from "../bot-panel/pages";
import { roundButtonCls } from "../bot-panel/rows";
import { PanelResizeEdge } from "../bot-panel/PanelResizeEdge";
import { nameCls, useInlineEdit } from "../bot-panel/PanelHero";
import { cn } from "@/lib/cn";
import { sidePanelCls } from "../bot-panel/side-panel";
import { SegmentedTabs } from "../ui/SegmentedTabs";
import { RoomAdvancedTab } from "./RoomAdvancedTab";
import { RoomComputerTab } from "./RoomComputerTab";
import { TabBoundary } from "../bot-panel/TabBoundary";
import { PerBotModels, RoomDetailsTab, type RoomPage, type RoomTarget } from "./RoomDetailsTab";
import { RoomAboutModal, RoomFolderModal, RoomInstructionsModal, RoomResponderModal, type RoomDialog } from "./RoomModals";
import { RoomSheet } from "./RoomSheet";

const PAGES: Record<RoomPage, { title: LocaleKey }> = {
  models: { title: "room.panel.perBot" },
};

const DIALOG_TITLE: Record<RoomDialog, LocaleKey> = {
  responder: "room.panel.whoResponds",
  folder: "room.folder.title",
  instructions: "room.panel.instructions",
  about: "room.panel.about",
};

/** The longest room name the sidebar's rename takes. */
const ROOM_NAME_LIMIT = 100;

function RoomHero({ group, members }: { group: Group; members: Bot[] }) {
  const { dispatch } = useStore();
  const name = useInlineEdit((value) => {
    const next = value.trim();
    if (next && next !== group.name) dispatch({ type: "patchGroup", groupId: group.id, patch: { name: next } });
  });
  const working = new Set(roomWorkingIds(group, group.messages.at(-1)));
  return (
    <div className="flex flex-col items-center text-center">
      <div data-room-panel-faces className="flex h-16 items-center">
        <BotFaces members={members} size={members.length > 1 ? 52 : 64} working={working} rest="happy" overlap={16} ground="var(--color-app)" />
      </div>
      <div data-panel-name-row className="mt-4 flex max-w-full flex-col items-center gap-1">
        <h2 className="flex min-w-0 max-w-full justify-center">
          {name.draft !== null ? (
            <input
              autoFocus
              data-panel-rename-input
              aria-label={t("botPanel.ui.botSettingsSimpleName")}
              placeholder={t("botPanel.ui.botSettingsSimpleName")}
              maxLength={ROOM_NAME_LIMIT}
              value={name.draft}
              onChange={(event) => name.setDraft(event.target.value)}
              onKeyDown={name.onKeyDown}
              onBlur={name.onBlur}
              className={cn(nameCls, "min-w-[2ch] border-focus outline-none [field-sizing:content]")}
            />
          ) : (
            <button
              ref={name.buttonRef}
              type="button"
              data-panel-rename
              title={t("rename.named", { name: group.name })}
              onClick={() => name.start(group.name)}
              className={cn(nameCls, "cursor-text truncate focus-visible:border-focus focus-visible:outline-none!")}
            >
              {group.name}
            </button>
          )}
        </h2>
        {group.description && (
          <p dir="auto" className="line-clamp-2 max-w-full px-2.5 text-[13px] leading-[18px] tracking-[0.015em] text-ink-secondary">{group.description}</p>
        )}
      </div>
    </div>
  );
}

export function RoomPanel({ group, overlay = false, initialTab = "details" }: { group: Group; overlay?: boolean; initialTab?: PanelTab }) {
  const { state, dispatch } = useStore();
  const { dragProps } = useCaptionChrome();
  // the side panel stays shut for every chat until the person opens it again, as the bot panel does
  const close = () => {
    closeRoomPanel({ refocus: true });
    dispatch({ type: "toggleSettings", open: false });
  };
  const [tab, setTab] = useState<PanelTab>(initialTab);
  const [page, setPage] = useState<RoomPage | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const [membersEpoch, setMembersEpoch] = useState(0);
  const dialogRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const membersRowRef = useRef<HTMLButtonElement>(null);
  const leftPage = useRef<RoomPage | null>(null);
  const members = useMemo(
    () => group.memberIds.map((id) => state.bots.find((bot) => bot.id === id)).filter((bot): bot is Bot => Boolean(bot)),
    [group.memberIds, state.bots],
  );
  const openMembers = useCallback(() => {
    wakeSystemControls();
    setMembersEpoch((n) => n + 1);
    setMembersOpen(true);
  }, []);
  const closeMembers = useCallback(() => setMembersOpen(false), []);

  // only a tab picked from the tabs swaps in; coming back from a page, the list is simply there under the wipe
  const [tabSwapped, setTabSwapped] = useState(false);
  const openTab = (next: PanelTab) => {
    wakeSystemControls();
    setTab(next);
    setTabSwapped(true);
    bodyRef.current?.scrollTo({ top: 0 });
  };
  const [dialog, setDialog] = useState<RoomDialog | null>(null);
  const closeDialog = useCallback(() => setDialog(null), []);
  const open = (target: RoomTarget) => {
    wakeSystemControls();
    if (target === "models") setPage(target);
    else setDialog(target);
  };
  const back = () => {
    wakeSystemControls();
    leftPage.current = page;
    setTabSwapped(false);
    setPage(null);
  };

  // the pressed row or Back button leaves with its view, so focus moves to its counterpart and Escape still lands here
  useEffect(() => {
    if (page !== null) {
      dialogRef.current?.querySelector<HTMLElement>("[data-panel-back]")?.focus();
    } else if (leftPage.current) {
      dialogRef.current?.querySelector<HTMLElement>(`[data-panel-page="${leftPage.current}"]`)?.focus();
      leftPage.current = null;
    }
  }, [page]);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (dialog && event.target instanceof Node && !dialog.contains(event.target)) return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented || page === null) return;
    event.preventDefault();
    event.stopPropagation();
    back();
  };

  const nav = useRef({ page, direction: 1 });
  if (nav.current.page !== page) nav.current = { page, direction: page !== null ? 1 : -1 };
  const direction = nav.current.direction;
  const prefersReduced = useReducedMotion();
  const reduced = prefersReduced || (typeof document !== "undefined" && document.documentElement.dataset.reducedMotion === "true");
  const viewKey = page === null ? "tabs" : `1:${page}`;
  const backLabel = t(TAB_LABEL[tab]);
  const order = panelTabs();
  const tabMove = useRef({ tab, direction: 1, span: 1 });
  if (tabMove.current.tab !== tab) {
    const delta = order.indexOf(tab) - order.indexOf(tabMove.current.tab);
    tabMove.current = { tab, direction: delta >= 0 ? 1 : -1, span: Math.max(1, Math.abs(delta)) };
  }
  const phone = phoneApp();
  const lastRoomPage = useRef<RoomPage | null>(null);
  if (page) lastRoomPage.current = page;
  const shownRoomPage = page ?? lastRoomPage.current;
  const lastRoomDialog = useRef<RoomDialog | null>(null);
  if (dialog) lastRoomDialog.current = dialog;
  const shownRoomDialog = dialog ?? lastRoomDialog.current;

  const rowProps = { group, members, onOpen: open, onMembers: openMembers, membersRef: membersRowRef };
  const tabContent = (
    <>
      {tab === "details" && <RoomDetailsTab {...rowProps} />}
      {tab === "computer" && screenViewAllowed() && <TabBoundary name={group.name}><RoomComputerTab members={members} /></TabBoundary>}
      {tab === "advanced" && <RoomAdvancedTab {...rowProps} />}
    </>
  );
  const tabsView = (
    <>
      <div data-panel-head className="contents">
        <div className="relative pb-3 pt-2">
          <RoomHero group={group} members={members} />
        </div>
        <div
          data-panel-tabs
          className="sticky top-0 z-[1] -mx-4 flex justify-center bg-app px-4 pb-2.5 pt-1 after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-3 after:bg-linear-to-b after:from-app after:to-transparent"
        >
          <SegmentedTabs
            attr="data-panel-tab"
            label={t("room.panel.open")}
            value={tab}
            onChange={openTab}
            tabs={panelTabs().map((id) => ({ value: id, label: t(TAB_LABEL[id]) }))}
            slide={phone ? (reduced ? null : feel.soft) : undefined}
          />
        </div>
      </div>
      {phone ? (
        <AnimatePresence initial={false} mode="popLayout" custom={tabMove.current}>
          <MotionDiv
            key={tab}
            role="tabpanel" aria-label={t(TAB_LABEL[tab])} className="pt-2.5"
            custom={tabMove.current}
            variants={reduced ? phoneTabFade : phoneTabSlide}
            initial={tabSwapped ? "enter" : false}
            animate="center"
            exit="exit"
          >
            {tabContent}
          </MotionDiv>
        </AnimatePresence>
      ) : (
        <MotionDiv
          key={tab}
          role="tabpanel" aria-label={t(TAB_LABEL[tab])} className="pt-2.5"
          initial={reduced || !tabSwapped ? false : SWAP.initial}
          animate={SWAP.animate}
        >
          {tabContent}
        </MotionDiv>
      )}
    </>
  );

  const pageView = page === null ? null : (
    <div data-panel-page-view={page} className="pt-1">
      <div className={pageSurfaceCls}>
        <PerBotModels members={members} />
      </div>
    </div>
  );

  const viewCls = "@container absolute inset-0 flex flex-col overflow-x-hidden overflow-y-auto overscroll-contain bg-app px-4 pb-8 [scrollbar-gutter:stable] [scrollbar-width:thin]";
  const setBody = (element: HTMLDivElement | null) => { if (element) bodyRef.current = element; };
  const view = (content: ReactNode) => reduced ? (
    <div key={viewKey} ref={setBody} className={viewCls}>{content}</div>
  ) : (
    <motion.div
      key={viewKey}
      ref={setBody}
      custom={direction}
      variants={WIPE_VARIANTS}
      initial="enter"
      animate="center"
      exit="exit"
      transition={{ duration: PANEL_PUSH.duration, ease: PANEL_PUSH.ease }}
      className={viewCls}
    >
      {content}
    </motion.div>
  );

  return (
    <>
      <aside
        ref={dialogRef}
        role={phoneApp() ? undefined : "dialog"}
        aria-labelledby={phoneApp() ? undefined : "room-panel-title"}
        tabIndex={-1}
        data-room-panel
        onKeyDown={onKeyDown}
        className={sidePanelCls(overlay)}
      >
        <span id="room-panel-title" className="sr-only">{group.name}</span>
        <PanelResizeEdge />
        <div {...dragProps} data-panel-bar className="relative ms-2 flex h-[60px] shrink-0 items-center gap-2 p-3 ps-1">
          {phone || page === null ? (
            <span className="ms-auto" />
          ) : (
            <>
              <button
                type="button"
                data-panel-back
                aria-label={t("botPanel.backTo", { place: backLabel })}
                title={backLabel}
                onClick={back}
                className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-ink/[0.66] transition-[background-color,color] duration-[120ms] ease-[ease-out] hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <Icon name="chevron-left" size={14} />
              </button>
              <span data-panel-page-title className="pointer-events-none absolute left-1/2 top-1/2 max-w-[60%] -translate-x-1/2 -translate-y-1/2 truncate text-[13px] font-medium leading-[18px]">
                {t(PAGES[page].title)}
              </span>
              <span className="ms-auto" />
            </>
          )}
          <button type="button" onClick={close} aria-label={t("botPanel.closePanel")} title={t("botPanel.closePanel")} className={roundButtonCls}>
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden">
          {phone ? (
            <>
              <div ref={setBody} className={viewCls}>{tabsView}</div>
              {shownRoomPage && (
                <SheetPush
                  open={page !== null}
                  onClose={back}
                  title={t(PAGES[shownRoomPage].title)}
                  pageId={`room:${shownRoomPage}`}
                >
                  <div data-panel-page-view={shownRoomPage} className="px-4 pb-8 pt-2">
                    <div className={pageSurfaceCls}>
                      <PerBotModels members={members} />
                    </div>
                  </div>
                </SheetPush>
              )}
              {shownRoomDialog && (
                <SheetPush
                  open={dialog !== null}
                  onClose={closeDialog}
                  title={t(DIALOG_TITLE[shownRoomDialog])}
                  pageId={`room:${shownRoomDialog}`}
                  flush
                  bodyClassName="pt-0! pb-0"
                >
                  {shownRoomDialog === "responder" && <RoomResponderModal group={group} members={members} onClose={closeDialog} />}
                  {shownRoomDialog === "folder" && <RoomFolderModal group={group} onClose={closeDialog} />}
                  {shownRoomDialog === "instructions" && <RoomInstructionsModal group={group} onClose={closeDialog} />}
                  {shownRoomDialog === "about" && <RoomAboutModal group={group} onClose={closeDialog} />}
                </SheetPush>
              )}
              <SheetPush
                open={membersOpen}
                onClose={closeMembers}
                title={t("room.members.manage")}
                pageId="room:members"
              >
                <ManageMembersPage key={membersEpoch} group={group} onClose={closeMembers} />
              </SheetPush>
            </>
          ) : reduced ? view(page === null ? tabsView : pageView) : (
            <AnimatePresence initial={false} custom={direction}>
              {view(page === null ? tabsView : pageView)}
            </AnimatePresence>
          )}
        </div>
      </aside>
      {!phone && dialog && <RoomSheet initial={dialog} group={group} members={members} onClose={closeDialog} />}
      {!phone && (
        <AnimatePresence>
          {membersOpen && <ManageMembersPanel key="members" group={group} onClose={closeMembers} triggerRef={membersRowRef} />}
        </AnimatePresence>
      )}
    </>
  );
}

const WIPE_VARIANTS = {
  enter: (direction: number) => ({ x: direction > 0 ? PANEL_PUSH.pushFrom : PANEL_PUSH.under, opacity: 1, zIndex: direction > 0 ? 1 : 0 }),
  center: { x: "0%", opacity: 1 },
  exit: (direction: number) => (direction > 0 ? { x: PANEL_PUSH.under, opacity: 0, zIndex: 0 } : { x: PANEL_PUSH.pushFrom, opacity: 1, zIndex: 1 }),
};
