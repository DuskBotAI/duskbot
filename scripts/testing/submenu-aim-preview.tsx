import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BotContextMenu } from "../../src/components/SidebarBotMenu";
import { SidebarPopoverMenu, type SidebarMenuItem } from "../../src/components/SidebarPopoverMenu";
import { applySkin, readSkin } from "../../src/lib/skins";
import { BotEditorStore, initialState, type Bot } from "../../src/state/store";
import "../../src/styles.css";

const rawFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("/api/auth/session")) {
    return Promise.resolve(new Response(JSON.stringify({ kind: "loopback" }), { status: 200, headers: { "content-type": "application/json" } }));
  }
  return rawFetch(input, init);
};

const noop = () => {};
const items: SidebarMenuItem[] = [
  { key: "usage", label: "Usage", onSelect: noop },
  { key: "support", label: "Support", onSelect: noop, submenu: [
    { key: "help", label: "Help center", onSelect: noop },
    { key: "keys", label: "Keyboard shortcuts", onSelect: noop },
    { key: "feedback", label: "Send feedback", onSelect: noop },
    { key: "export", label: "Export usage log", onSelect: noop },
    { key: "about", label: "About", onSelect: noop },
  ] },
  { key: "settings", label: "Settings", onSelect: noop },
  { key: "signout", label: "Sign out", onSelect: noop },
];

const sampleBot: Bot = {
  id: "scout",
  threadId: "scout-main",
  name: "Scout",
  title: "",
  description: "",
  color: "green",
  notifications: true,
  unread: false,
  messages: [],
  modelSelection: { instanceId: "fake", model: "test" },
};

const storeState = {
  ...initialState,
  sections: ["Grok Bot"],
  bots: [sampleBot, { ...sampleBot, id: "other", threadId: "other-main", name: "Other" }],
  selectedId: sampleBot.id,
};

function Preview() {
  const [botMenu, setBotMenu] = useState<{ botId: string; x: number; y: number } | null>(null);
  return (
    <BotEditorStore value={{ state: storeState, dispatch: noop, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} }}>
      <div style={{ position: "fixed", left: 24, bottom: 24 }}>
        <SidebarPopoverMenu items={items} ariaLabel="Account" renderTrigger={() => <span>Account</span>} />
      </div>
      <div data-right-popover="" style={{ position: "fixed", right: 24, bottom: 24 }}>
        <SidebarPopoverMenu grok align="end" items={items} ariaLabel="Right account" renderTrigger={() => <span>Right account</span>} />
      </div>
      <button
        type="button"
        data-open-bot-menu=""
        style={{ position: "fixed", left: 320, top: 24 }}
        onClick={() => setBotMenu({ botId: sampleBot.id, x: 320, y: 64 })}
      >
        Bot menu
      </button>
      <BotContextMenu
        menu={botMenu}
        onClose={() => setBotMenu(null)}
        onArchive={noop}
        onDelete={noop}
        onRename={noop}
        onNewSection={noop}
      />
    </BotEditorStore>
  );
}

applySkin(readSkin());
createRoot(document.getElementById("root")!).render(<Preview />);
