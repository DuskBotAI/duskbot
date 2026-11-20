/** what the desktop page sends through the preload bridge's errorReports.send */
export interface DesktopErrorReport { type: string; message: string; stack: string; path: string }
export interface ErrorReportsBridge { send(report: DesktopErrorReport): Promise<boolean> }
export interface AccountErrors {
  send(input: unknown): boolean;
  capture(error: unknown, source?: "desktop" | "desktop-main"): boolean;
  watch(app: { on(event: string, listener: (...args: any[]) => void): unknown }, proc?: NodeJS.Process, options?: { ending?: () => boolean; platform?: string }): void;
}
export declare function createAccountErrors(options: { origin: string; enabled: () => boolean; platform: string; release?: string; version: string; fetch?: typeof fetch; now?: () => number }): AccountErrors;
