import { describe, expect, it } from "vitest";

import { catalogProfileFromEnv } from "./agents-catalog-profile.ts";
import { BRIDGE_HOT_TOOL_NAMES } from "./agents-bridge.ts";
import { AGENTS_DEFER_ENV, AGENTS_MCP_ENV } from "./agents-mcp-env.ts";
import { agentsMcp, agentsToolList } from "./agents-mcp.ts";
import { TOOL_BYTE_BUDGET_ENV } from "../tool-byte-budget.ts";
import { TOOL_SCHEMA_PROFILE_ENV } from "../tool-schema-profile.ts";

describe("the agents server's settings", () => {
  it("carry every switch the catalog reads, so a turn reaching the server over HTTP is listed the same tools", () => {
    const read = new Set<string>();
    catalogProfileFromEnv(new Proxy({}, { get: (_target, key) => { if (typeof key === "string") read.add(key); return undefined; } }));
    expect(read.size).toBeGreaterThan(10);
    for (const key of read) expect(AGENTS_MCP_ENV, key).toContain(key);
  });

  it("defer: only the hot tools stay always loaded for Claude, the rest are marked for tool search", () => {
    const env = { DUSK_BOT_ID: "b", DUSK_THREAD_ID: "t", DUSK_MEMORY_ENABLED: "1" };
    const meta = (tool: object) => (tool as { _meta?: Record<string, unknown> })._meta?.["anthropic/alwaysLoad"];
    const plain = agentsToolList(env).listed;
    expect(plain.some((tool) => meta(tool) !== undefined), "other engines see the catalog unchanged").toBe(false);
    const deferred = agentsToolList({ ...env, [AGENTS_DEFER_ENV]: "1" }).listed;
    expect(deferred.map((tool) => tool.name)).toEqual(plain.map((tool) => tool.name));
    const up = deferred.filter((tool) => meta(tool) !== false).map((tool) => tool.name);
    expect(up).toEqual(expect.arrayContaining(["memory_update", "attach_file", "coordinate_bots"]));
    for (const name of up) expect(BRIDGE_HOT_TOOL_NAMES.has(name), name).toBe(true);
    expect(up, "a reminder needs no tool search").toContain("trigger");
    expect(meta(deferred.find((tool) => tool.name === "delete_trigger")!), "deleting a routine loads through tool search").toBe(false);
  });

  it("marks listed tools always-loaded when running under the Antigravity schema profile", async () => {
    const baseEnv = { DUSK_BOT_ID: "b", DUSK_THREAD_ID: "t", DUSK_MEMORY_ENABLED: "1" };
    const plain = await agentsMcp(baseEnv)({ jsonrpc: "2.0", id: 1, method: "tools/list" }) as { result: { tools: Array<{ name: string; _meta?: Record<string, unknown> }> } };
    expect(plain.result.tools.some((tool) => tool._meta?.["antigravity/alwaysLoad"] !== undefined)).toBe(false);

    const agy = await agentsMcp({ ...baseEnv, [TOOL_SCHEMA_PROFILE_ENV]: "antigravity" })({ jsonrpc: "2.0", id: 1, method: "tools/list" }) as { result: { tools: Array<{ name: string; _meta?: Record<string, unknown> }> } };
    expect(agy.result.tools.length).toBe(plain.result.tools.length);
    for (const tool of agy.result.tools) expect(tool._meta?.["antigravity/alwaysLoad"], tool.name).toBe(true);
  });

  it("prioritizes hot agents tools first when capped by an eager byte budget", async () => {
    const baseEnv = { DUSK_BOT_ID: "b", DUSK_THREAD_ID: "t", DUSK_MEMORY_ENABLED: "1", [TOOL_SCHEMA_PROFILE_ENV]: "antigravity" };
    const full = await agentsMcp(baseEnv)({ jsonrpc: "2.0", id: 1, method: "tools/list" }) as { result: { tools: Array<{ name: string }> } };
    const budgeted = await agentsMcp({ ...baseEnv, [TOOL_BYTE_BUDGET_ENV]: "12000" })({ jsonrpc: "2.0", id: 1, method: "tools/list" }) as { result: { tools: Array<{ name: string }> } };
    expect(budgeted.result.tools.length).toBeLessThan(full.result.tools.length);
    expect(budgeted.result.tools.length).toBeGreaterThan(0);
    const names = budgeted.result.tools.map((tool) => tool.name);
    expect(names.every((name) => BRIDGE_HOT_TOOL_NAMES.has(name))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(budgeted.result.tools), "utf8")).toBeLessThanOrEqual(12_000);
  });
});
