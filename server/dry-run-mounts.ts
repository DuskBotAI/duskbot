import type { McpServerSpec } from "./contracts.ts";
import { DRY_RUN_UPSTREAM_ENV } from "./dry-run-mcp.ts";
import { mcpStdioServer } from "./mcp-gate-config.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";

/** An automation's test run mounts each of the person's MCP servers behind dry-run-mcp, so only its reads reach the
 * server. A server that cannot be wrapped is left out of the run rather than mounted unguarded. */
export function testRunMounts(custom: Record<string, McpServerSpec>, nodeEnv: Record<string, string> = { ELECTRON_RUN_AS_NODE: "1" }): Record<string, McpServerSpec> {
  const out: Record<string, McpServerSpec> = {};
  for (const [name, server] of Object.entries(custom)) {
    const upstream = mcpStdioServer(server, { nodeEnv });
    if (!upstream) continue;
    out[name] = {
      command: process.execPath,
      args: [SPAWNED_PROXIES.dryRunMcp],
      env: { ...nodeEnv, DUSK_DRY_RUN_NAME: name, [DRY_RUN_UPSTREAM_ENV]: JSON.stringify({ command: upstream.command, args: upstream.args ?? [], env: upstream.env ?? {} }) },
    } as McpServerSpec;
  }
  return out;
}
