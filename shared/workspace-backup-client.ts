// Exact app-owned browser state that belongs in an encrypted full backup.
// Never include cookies, authentication tokens, connection caches or unknown keys.
export const WORKSPACE_BACKUP_CLIENT_KEYS = [
  "dusk-drafts",
  "dusk-draft-attachments",
  "dusk-draft-send-ids",
  "dusk-draft-channel-modes",
  "dusk-skin",
  "dusk-show-threads",
  "dusk-show-run-card",
  "dusk-show-peer-replies",
  "dusk-send-key",
  "dusk-color-user-bubbles",
  "dusk-chat-width",
  "duskbot.sidebarDensity",
  "duskbot.sidebarToolsLayout",
  "duskbot.sidebarCollapsedSections.v1",
  "duskbot.sidebarSectionOrder.v1",
  "dusk-analytics-opt-out",
  "duskbot.remote-voice.v1",
] as const;

export type WorkspaceBackupClientState = Partial<Record<(typeof WORKSPACE_BACKUP_CLIENT_KEYS)[number], string>>;
