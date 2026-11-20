/** "managed" is a hosted or Cloud server that is updated for its owner. */
export type InstallKind = "desktop" | "managed" | "docker" | "podman" | "npm" | "git" | "unknown";

/** GET /api/updates/check for the current workspace. Only a signed-in owner receives host controls. */
export interface UpdateCheck {
  current: string;
  install: InstallKind;
  latest?: string;
  available: boolean;
  releaseUrl?: string;
  command?: string;
  restart?: boolean;
  pinned?: string;
  compose?: ComposeUpdateStatus;
}

/** The host updater's state, as seen by the authenticated owner of its workspace. */
export interface ComposeUpdateStatus {
  supported: boolean;
  automatic: boolean;
  phase: "idle" | "updating" | "updated" | "failed" | "waiting";
  message?: string;
}
