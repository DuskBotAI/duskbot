/** `available`: a newer version was found; `progress` (0 to 1) while it downloads; `ready` once it waits for a restart */
export interface AppUpdateState {
  ready: string | null; available?: string | null; progress?: number | null;
  /** a check runs now; `failed`: the last one could not finish; `retrying`: a download try failed and the next waits */
  checking?: boolean; failed?: boolean; retrying?: boolean;
  /** "move": this mac runs a copy the updater can't replace (translocated, or on a disk image) until it is moved to Applications */
  blocked?: "move" | null;
  /** a newer version this app can't install by itself, and the link that downloads it (an installer, or dusk.bot/download) */
  manual?: { version: string; url: string } | null;
  /** main's word on how this app updates: "self" installs its own, "dev" runs from a code checkout, "notice" points at the download page */
  mode?: "self" | "dev" | "notice";
  /** the version this app updated to, until the window has said so once */
  updated?: string | null;
}
export interface AppUpdateBridge {
  state(): Promise<AppUpdateState>;
  /** downloads the newer version now (again, after a failed try); the version once ready, null when there is none */
  download?(): Promise<string | null>;
  /** restarts into the downloaded update now; false when none is waiting */
  restart(): Promise<boolean>;
  /** the "updated to" note was shown */
  seen?(): Promise<void>;
  /** opens the state's `manual` link, or dusk.bot/download */
  open?(): Promise<boolean>;
  /** moves the app to Applications and relaunches it from there; false (and dusk.bot/download opens) when it can't */
  move?(): Promise<boolean>;
  onState(cb: (state: AppUpdateState) => void): () => void;
}
export declare const DESKTOP_MANIFEST_URL: string;
export declare const RELEASE_KEYS: readonly { kid: string; x: string }[];
export declare const QUIET_IDLE_MS: number;
export declare function sumsUrl(version: string): string;
export declare function zipUrl(version: string, name: string): string;
export declare const DOWNLOAD_PAGE: string;
export declare function mirrorUrl(version: string, name: string): string;
export declare function zipSources(version: string, name: string): string[];
export declare function installerIn(sums: string, version: string, platform: string, options?: { appImage?: boolean }): string | null;
export declare function installerUrl(version: string, name: string | null, fetchImpl?: typeof fetch): Promise<string>;
export declare function updatePlace(bundle: string, writable?: (dir: string) => boolean): "move" | "readonly" | null;
export declare function verifiedRelease(body: unknown, keys?: readonly { kid: string; x: string }[]): { version: string; sums: string } | null;
export declare function newer(a: string, b: string): boolean;
export declare function setupIn(sums: string, version: string): { name: string; sha256: string } | null;
export declare function setupSources(version: string, name: string): string[];
export declare function windowsUpdatePlace(exe: string, options?: { productName?: string; exists?(file: string): boolean; writable?(dir: string): boolean }): "readonly" | null;
export declare function zipIn(sums: string, version: string, arch: string): { name: string; sha256: string } | null;
export declare function developerIdSigned(bundle: string, run?: (file: string, args: string[]) => Promise<string>): Promise<boolean>;
export interface AppInstaller { prepare(file: string, version: string): Promise<void>; install(): void }
export declare function squirrelInstaller(options: { autoUpdater: unknown; timeoutMs?: number }): AppInstaller;
export declare function nsisInstaller(options: { quit(): void; spawn?(file: string, args: string[]): void; log?(line: string): void }): AppInstaller & { quitting(options?: { exitCode?: number; unsafe?: boolean }): boolean };
export declare function quietNow(signals: { locked(): boolean; idleMs(): number; typedAt(): number; work(): Promise<string | null>; busy?(): string | null; focused?(): boolean }, now?: number): Promise<boolean>;
export declare function justUpdated(memory: { read(): { version?: string } | null; write(value: { version: string }): void }, current: string, installedHere?: () => boolean): boolean;
export interface AppUpdater { check(): Promise<string | null>; restart(): boolean; state(): AppUpdateState; start(): void; soon(delayMs?: number): void; stop(): void }
export declare function createAppUpdater(options: {
  current: string; arch: string; dir: string; fetchImpl?: typeof fetch; keys?: readonly { kid: string; x: string }[];
  installs?: boolean; platform?: string; appImage?: boolean; blocked?(): Promise<"move" | "readonly" | null>;
  signed?(): Promise<boolean>; installer?: AppInstaller; quiet?(): Promise<boolean>; fallback: { check(): Promise<unknown> };
  onState?(state: AppUpdateState): void; /** a check or download failed: its message, the stage and a short reason word */ onFailed?(message: string, info: { stage: string | null; reason: string }): void;
  download?: Partial<{ attempts: number; stallMs: number; headersMs: number; backoffMs: readonly number[]; wait(ms: number): Promise<void> }>; log?(line: string): void; firstDelayMs?: number; intervalMs?: number; jitterMs?: number; random?: () => number; quietEveryMs?: number;
  timers?: Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
}): AppUpdater;
