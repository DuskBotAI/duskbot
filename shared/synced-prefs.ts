/** The app's own preferences that follow the person to every place of theirs (server/settings-sync.ts), by the name the
 * page keeps each under. Window sizes, drafts, pins of one place's bots and hints already seen stay with the page. */
export const SYNCED_UI_PREFS = [
  "dusk-skin", "dusk-font", "dusk-chat-width", "dusk-send-key", "dusk-follow-up", "dusk-show-run-card", "dusk-show-peer-replies", "dusk-color-user-bubbles",
  "dusk-halloween-dress", "dusk-language", "dusk-notification-sounds", "dusk-finished-notifications", "dusk-notification-sound",
  "duskbot.callMode.v1", "duskbot.sidebarDensity", "duskbot.sidebarCollapsedSections.v1", "duskbot.sidebarSectionOrder.v1",
  "duskbot.sidebarSectionOrder.simple.v1", "duskbot.starredModels.v1",
] as const;
export type SyncedUiPref = (typeof SYNCED_UI_PREFS)[number];
