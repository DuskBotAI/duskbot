// stdout is the MCP transport. Never log there.
// A person's MCP server, mounted for an automation's test run: reads pass through; every other call is answered here
// with what the run should do instead, and never reaches the server. Whether a tool only reads comes from the server's
// own tools/list (read-only and not destructive, with no write word in its name) or from its name (get, list, search…).
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { isReadOnlyTool } from "../shared/outbound.ts";
import { readsByHint, toolHint, type McpToolHint } from "./mcp-tool-hints.ts";

export const DRY_RUN_UPSTREAM_ENV = "DUSK_DRY_RUN_UPSTREAM";

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Whether a test run may make this call: only a tool that reads. A tool the server never listed is held. */
export function testRunMayCall(tool: string, hints: ReadonlyMap<string, McpToolHint>): boolean {
  return readsByHint(tool, hints.get(tool)) || (hints.has(tool) && hints.get(tool)!.destructive !== true && isReadOnlyTool(tool));
}

export function heldInTestRun(server: string, tool: string, args: unknown): string {
  const shown = JSON.stringify(args ?? {});
  return `Test run: ${server} ${tool} was not called, so nothing was sent, written or changed. Carry on as if it had worked, and put in your report exactly what it would have done: ${tool} ${shown.length > 600 ? `${shown.slice(0, 600)}…` : shown}`;
}

function main(): void {
  const name = process.env.DUSK_DRY_RUN_NAME ?? "server";
  let upstream: { command: string; args: string[]; env: Record<string, string> };
  try {
    upstream = JSON.parse(process.env[DRY_RUN_UPSTREAM_ENV] ?? "");
    if (typeof upstream?.command !== "string" || !Array.isArray(upstream.args)) throw new Error();
  } catch {
    process.stderr.write("dry-run-mcp: invalid configuration\n");
    process.exit(1);
  }
  const env: NodeJS.ProcessEnv = { ...process.env, ...upstream.env };
  delete env[DRY_RUN_UPSTREAM_ENV];
  delete env.DUSK_DRY_RUN_NAME;
  const child = spawn(upstream.command, upstream.args, { env, stdio: ["pipe", "pipe", "inherit"] });
  const hints = new Map<string, McpToolHint>();
  const listing = new Set<string>();
  const key = (id: unknown) => JSON.stringify(id);

  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const message = JSON.parse(line) as Json;
      if (message.id !== undefined && listing.delete(key(message.id)) && isRecord(message.result) && Array.isArray(message.result.tools)) {
        for (const tool of message.result.tools) {
          const hint = toolHint(tool);
          if (hint) hints.set(hint[0], hint[1]);
        }
      }
    } catch { /* not ours to judge: pass it on */ }
    process.stdout.write(`${line}\n`);
  });
  createInterface({ input: process.stdin }).on("line", (line) => {
    let message: Json | null = null;
    try { message = JSON.parse(line) as Json; } catch { /* pass it on */ }
    const params = isRecord(message?.params) ? message.params : undefined;
    if (message?.method === "tools/list" && message.id !== undefined) listing.add(key(message.id));
    if (message?.method === "tools/call" && message.id !== undefined && typeof params?.name === "string" && !testRunMayCall(params.name, hints)) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: heldInTestRun(name, params.name, params.arguments) }] } })}\n`);
      return;
    }
    child.stdin.write(`${line}\n`);
  });
  process.stdin.on("end", () => child.stdin.end());
  child.on("exit", (code) => process.exit(code ?? 0));
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { child.kill(signal); });
}

if (process.argv[1] && /dry-run-mcp\.(?:ts|js)$/.test(process.argv[1])) main();
