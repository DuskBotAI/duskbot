import type { spawn } from "node:child_process";

import type { MacJob, MacJobOutcome } from "../shared/mac-control.ts";

export declare const OUTPUT_TAIL: number;
export declare const SEND_MAX: number;
export declare function macLogFile(home?: string): string;
export declare function resolveMacPath(value: unknown, home?: string): string;
export declare function folderName(value: unknown): string;
export declare function downloadName(url: URL, disposition: string | null): string;
export declare function jobSummary(job: Pick<MacJob, "tool" | "arguments">): string;
export declare function runShell(command: string, options: { cwd: string; timeoutMs: number; shell?: string; spawnImpl?: typeof spawn; signal?: AbortSignal }):
  Promise<{ code: number | string | null; output: string; timedOut: boolean; stopped: boolean; cut: boolean }>;
export declare function createMacExecutor(options?: {
  home?: string; shell?: string; log?(line: string): void; now?(): Date; spawnImpl?: typeof spawn;
  screenshot?(): Promise<{ data: string; mimeType: string }>; opener?(args: string[]): Promise<unknown>;
  fetch?: typeof fetch; source?: string; defaultCwd?(): string;
}): (job: MacJob, io?: { download?(path: string): Promise<Response>; signal?: AbortSignal }) => Promise<MacJobOutcome>;
export declare function servesMacJobs(platform?: string): boolean;
