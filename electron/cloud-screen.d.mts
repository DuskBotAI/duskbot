import type { spawn } from "node:child_process";

export declare function driverCommand(connection: unknown): { command: string; args: string[]; env: Record<string, string> } | null;
export declare function screenOutcome(result: unknown): { ok: true; result: { text: string; image?: { data: string; mimeType: string }; structured?: Record<string, unknown>; isError?: true } };
export declare function createScreenDriver(deps: { connection(): unknown; spawnImpl?: typeof spawn; log?(line: string): void; idleMs?: number; requestAccess?(): Promise<unknown> }): {
  requestAccess?(): Promise<unknown>;
  available(): boolean;
  version(): string;
  tools(): Promise<{ driver: string; tools: Array<{ name: string; description?: string; inputSchema?: unknown }> }>;
  call(name: string, args: unknown, signal?: AbortSignal): Promise<Record<string, unknown>>;
  close(): void;
};
