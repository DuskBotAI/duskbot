import { useCallback, useEffect, useRef, useState } from "react";

import { useStore, type Bot } from "@/state/store";
import type { useBotSettingsDerived } from "../bot-settings/useBotSettingsDerived";
import { openBotSettings } from "@/lib/open-settings";
import { wakeSystemControls } from "@/lib/system-control";
import { VoiceChatCard } from "./DetailsTab";
import { LibrarySection } from "./LibraryTab";
import { FilesSection, useFiles } from "../documents/FilesSection";
import { takePanelModalRequest, usePanelModalRequest, type SheetPage } from "./modals/panel-modal";
import type { SimplePageId } from "./page-registry";
import { PanelSections } from "../ListRows";
import { SettingsPage } from "./SettingsPage";
import { PanelModal } from "./modals/PanelModals";
import { usePanelLink } from "./panel-link";
import { phoneApp } from "@/lib/store-app";
import { SheetPush } from "@/mobile/SheetPush";

// a link opens Settings once: a panel drawn again for the same link (it reads the link as it mounts) must not reopen it
let openedForLink = -1;

/** Every native per-bot feature Grok's Details tab has no room for, in Grok's list language: what the bot made, its voice
 * chat, the bot's own rows (each opening Settings' Bots page on this bot, at that row's page) and its rare actions. A deep link to one of those pages lands in Settings there. */
export function AdvancedTab({ bot, derived, onOpen }: {
  bot: Bot;
  derived: ReturnType<typeof useBotSettingsDerived>;
  onOpen: (page: SimplePageId) => void;
}) {
  const { dispatch } = useStore();
  const request = usePanelModalRequest();
  const link = usePanelLink();
  const files = useFiles(bot, onOpen);
  // the phone has no Settings window: every bot-settings page opens over the profile in the same sheet style
  const [phonePage, setPhonePage] = useState<SheetPage | null>(null);
  const lastPhonePage = useRef<SheetPage | null>(null);
  if (phonePage) lastPhonePage.current = phonePage;
  const openOnPhone = (page: SheetPage) => {
    wakeSystemControls();
    setPhonePage(page);
  };
  const openPage = (page: SheetPage) => phoneApp() ? openOnPhone(page) : dispatch(openBotSettings({ kind: "bot", id: bot.id, row: page }));

  useEffect(() => {
    if (!request) return;
    takePanelModalRequest(request);
    const linkNonce = link?.nonce ?? 0;
    if (linkNonce !== 0 && linkNonce === openedForLink) return;
    openedForLink = linkNonce;
    if (phoneApp()) openOnPhone(request.page);
    else dispatch(openBotSettings({ kind: "bot", id: bot.id, row: request.page }));
  }, [request, link, bot.id, dispatch]);

  const shownPage = phonePage ?? lastPhonePage.current;

  return (
    <PanelSections data-panel-tabpanel="advanced">
      <FilesSection bot={bot} files={files} onOpen={onOpen} />
      <LibrarySection bot={bot} onOpen={onOpen} quietWhenEmpty={Boolean(files.documents?.length) || phoneApp()} />
      <VoiceChatCard bot={bot} patch={derived.patch} />
      <SettingsPage bot={bot} derived={derived} onOpen={openPage} />
      {shownPage && (
        <PhonePage
          open={Boolean(phonePage)}
          page={shownPage}
          bot={bot}
          derived={derived}
          onClose={() => setPhonePage(null)}
        />
      )}
    </PanelSections>
  );
}

/** One of the bot's settings pages on the phone, pushed over its profile with native UIKit physics and swipe-back. */
function PhonePage({ open, page, bot, derived, onClose }: { open: boolean; page: SheetPage; bot: Bot; derived: ReturnType<typeof useBotSettingsDerived>; onClose: () => void }) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [meta, setMeta] = useState({ title: "", innerBack: false });

  useEffect(() => {
    if (!root) return;
    const read = () => {
      const layer = root.querySelector(".settings-wipe-layer:not([data-wipe-out])") ?? root;
      const title = layer.querySelector(".settings-pane-title")?.textContent?.trim() ?? "";
      const innerBack = Boolean(layer.querySelector("[data-settings-back]"));
      setMeta((prev) => (prev.title === title && prev.innerBack === innerBack ? prev : { title, innerBack }));
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [root, page]);

  const goBack = useCallback(() => {
    const layer = root?.querySelector(".settings-wipe-layer:not([data-wipe-out])") ?? root;
    const inner = layer?.querySelector<HTMLButtonElement>("[data-settings-back]");
    if (inner) inner.click();
    else onClose();
  }, [root, onClose]);

  return (
    <SheetPush
      open={open}
      onClose={onClose}
      onBack={goBack}
      swipeBack={!meta.innerBack}
      title={meta.title || undefined}
      pageId={page}
      flush
      bodyClassName="pt-0! pb-0"
      contentRef={setRoot}
    >
      <PanelModal page={page} bot={bot} derived={derived} onClose={onClose} />
    </SheetPush>
  );
}
