import { lazyScreen } from "./lazy-screen";
import { PanelAdvancedTab, PanelAvatarEditor, PanelDetailsTab, PanelPageBody } from "./bot-panel/PanelShell";

export { lazyScreen, type LazyScreen } from "./lazy-screen";
export { BotSettingsDialog } from "./BotSettingsDialog";

export const KeyboardShortcutsModal = lazyScreen("KeyboardShortcutsModal", async () => (await import("./KeyboardShortcutsModal")).KeyboardShortcutsModal);
export const RemoteAgentSettingsPanel = lazyScreen("RemoteAgentSettingsPanel", async () => (await import("./RemoteAgentSettingsPanel")).RemoteAgentSettingsPanel);
export const RoomPanel = lazyScreen("RoomPanel", async () => (await import("./room-panel/RoomPanel")).RoomPanel);
export const SettingsModal = lazyScreen("SettingsModal", async () => (await import("./SettingsModal")).SettingsModal);
export const VoiceSetupDialog = lazyScreen("VoiceSetupDialog", async () => (await import("./VoiceSetupDialog")).VoiceSetupDialog);

// Rarely opened, so never fetched ahead. The team library is what brings the YAML parser in.
export const CloudAddDialog = lazyScreen("CloudAddDialog", async () => (await import("./CloudAddDialog")).CloudAddDialog);
export const PhoneAppDialog = lazyScreen("PhoneAppDialog", async () => (await import("./PhoneAppDialog")).PhoneAppDialog);
export const TeamLibraryPanel = lazyScreen("TeamLibraryPanel", async () => (await import("./TeamLibraryPanel")).TeamLibraryPanel);

// Most opened first: a Cloud page fetches these in this order.
const SCREENS = [
  SettingsModal, KeyboardShortcutsModal,
  RemoteAgentSettingsPanel, RoomPanel,
];
const DEV_SCREENS = [
  ...SCREENS,
  PanelDetailsTab, PanelAdvancedTab, PanelPageBody, PanelAvatarEditor,
];

if (typeof location !== "undefined" && new URLSearchParams(location.search).has("desktop-settings")) {
  void SettingsModal.preload().catch(() => {});
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const REMOTE_PRELOAD_AFTER_MS = 5_000;
const DEV_PRELOAD_AFTER_MS = 1_500;

// In production on this machine a first open costs 8-28 ms, so a local page fetches each when it opens. Over a network,
// or under Vite's unbundled dev server (hundreds of individual modules), preloading one per idle moment avoids stalls.
export function preloadScreens(hostname = location.hostname, dev = false): () => void {
  if (!dev && LOCAL_HOSTS.has(hostname)) return () => {};
  const list = dev ? DEV_SCREENS : SCREENS;
  const delayMs = dev ? DEV_PRELOAD_AFTER_MS : REMOTE_PRELOAD_AFTER_MS;
  let stopped = false;
  let cancelWait = () => {};
  const whenIdle = (run: () => void) => {
    if (typeof requestIdleCallback === "function") {
      const handle = requestIdleCallback(run, { timeout: 2_000 });
      cancelWait = () => cancelIdleCallback(handle);
    } else {
      // Safari has no requestIdleCallback.
      const timer = setTimeout(run, 1_000);
      cancelWait = () => clearTimeout(timer);
    }
  };
  const fetchFrom = (index: number) => {
    const screen = list[index];
    if (!screen) return;
    whenIdle(() => {
      void screen.preload().catch(() => {}).then(() => {
        if (!stopped) fetchFrom(index + 1);
      });
    });
  };
  const start = setTimeout(() => fetchFrom(0), delayMs);
  cancelWait = () => clearTimeout(start);
  return () => {
    stopped = true;
    cancelWait();
  };
}
