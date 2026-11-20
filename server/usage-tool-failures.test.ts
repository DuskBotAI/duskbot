import { describe, expect, it } from "vitest";

import { USAGE_TURN_KEYS, cleanUsageTurn, failedToolName, toolErrorClass, toolFailures } from "../shared/usage-signals.ts";
import { parseWorkspaceReport } from "../shared/dashboard-protocol.ts";
import { turnRecord } from "./usage-signals.ts";

const NOW = Date.now();
const SECRET = "Navigation to https://bank.example.com/acct?u=jane.doe@acme.com failed: Jane Doe";
const base = { id: "abcdefgh12", at: NOW, engine: "claude", outcome: "ok", ms: 10, tools: ["browser"], apps: [], category: "research", from: "app", place: "desktop", room: false };

describe("tool error class", () => {
  it.each([
    ["Navigation timeout of 30000 ms exceeded", "timeout"],
    ["Timed out after 20s waiting for the page", "timeout"],
    ["The app needs Screen Recording permission", "permission"],
    ["EACCES: permission denied, open '/x'", "permission"],
    ["No element matches #submit.", "not_found"],
    ["Frame with the given id was not found: 12", "not_found"],
    ["Invalid arguments: expected string at path url", "schema_invalid"],
    ["MCP error -32602: Invalid params", "schema_invalid"],
    ["\"ref\" is required", "schema_invalid"],
    ["Unknown tool: browser_flyto", "schema_invalid"],
    ["net::ERR_NAME_NOT_RESOLVED at https://x.example", "network"],
    ["connect ECONNREFUSED 127.0.0.1:9222", "network"],
    ["The page shows a human check (cloudflare_turnstile).", "bot_wall"],
    ["Sorry, you have been blocked", "bot_wall"],
    ["This tab's page crashed. Reload it or open it again.", "crashed"],
    ["The browser connection closed (pipe) before Page.navigate answered.", "crashed"],
    ["something odd", "other"],
    [undefined, "other"],
  ])("%s -> %s", (text, kind) => expect(toolErrorClass(text)).toBe(kind));
});

describe("failed tool name", () => {
  it.each([
    ["mcp__computer__click", "computer.click"],
    ["computer_type_text", "computer.type_text"],
    ["agent_browser_open", "browser.open"],
    ["mcp__browser__browser_navigate", "browser.navigate"],
    ["browser_click", "computer.browser_click"],
    ["Bash", "terminal"],
    ["GMAIL_SEND_EMAIL", "app"],
    ["mcp__browser__Go To https://x.example/jane", "browser.other"],
  ])("%s -> %s", (name, label) => expect(failedToolName(name)).toBe(label));
});

describe("tool failures on a turn", () => {
  it("counts calls per tool and class, never carries error text", () => {
    const rows = toolFailures([
      { name: "mcp__computer__click", error: "Timed out" }, { name: "mcp__computer__click", error: "timeout after 5s" },
      { name: "agent_browser_open", error: SECRET }, { name: "mcp__computer__click", error: "Invalid arguments" },
    ]);
    expect(rows).toEqual([
      { tool: "computer.click", error: "timeout", count: 2 },
      { tool: "browser.open", error: "other", count: 1 },
      { tool: "computer.click", error: "schema_invalid", count: 1 },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/example|jane|acme/i);
  });

  it("leaves bad-argument calls out of the failed tool kinds", () => {
    const record = turnRecord({ driverKind: "claudeAgent", status: "ok", startedAt: NOW - 1000, endedAt: NOW, toolNames: ["mcp__computer__click", "Bash"], trigger: { kind: "owner" }, room: false,
      failedNames: ["mcp__computer__click", "Bash"], failedCalls: [{ name: "mcp__computer__click", error: "Invalid arguments: x is required" }, { name: "Bash", error: SECRET }] }, "desktop", NOW)!;
    expect(record.failedTools).toEqual(["terminal"]);
    expect(record.toolFailures).toEqual([{ tool: "computer.click", error: "schema_invalid", count: 1 }, { tool: "terminal", error: "other", count: 1 }]);
    expect(Object.keys(record).every((key) => (USAGE_TURN_KEYS as readonly string[]).includes(key))).toBe(true);
    expect(JSON.stringify(record)).not.toMatch(/example|jane|acme/i);
  });

  it("keeps the old failed names path when no calls are given", () => {
    const record = turnRecord({ driverKind: "claudeAgent", status: "ok", startedAt: NOW - 1000, endedAt: NOW, toolNames: ["Bash"], trigger: { kind: "owner" }, room: false, failedNames: ["Bash"] }, "desktop", NOW)!;
    expect(record.failedTools).toEqual(["terminal"]);
    expect(record).not.toHaveProperty("toolFailures");
  });
});

describe("ingest of tool failures", () => {
  it("accepts a turn without them, as older workspaces send", () => {
    const turn = cleanUsageTurn({ ...base, failedTools: ["browser"] }, NOW)!;
    expect(turn).toMatchObject({ failedTools: ["browser"] });
    expect(turn).not.toHaveProperty("toolFailures");
  });

  it("keeps valid rows, merges repeats and drops anything that could carry text", () => {
    const turn = cleanUsageTurn({ ...base, toolFailures: [
      { tool: "browser.navigate", error: "timeout", count: 2 }, { tool: "browser.navigate", error: "timeout", count: 1 }, { tool: "terminal", error: "crashed", count: 1 },
      { tool: "browser.https://x.example", error: "timeout", count: 1 }, { tool: "computer.click", error: "Jane said no", count: 1 }, { tool: "computer.click", error: "other", count: 0 },
      { tool: "computer.click", error: "other", count: 1.5 }, { tool: "evil", error: "other", count: 1 }, "browser.navigate", null,
    ] }, NOW)!;
    expect(turn.toolFailures).toEqual([{ tool: "browser.navigate", error: "timeout", count: 3 }, { tool: "terminal", error: "crashed", count: 1 }]);
  });

  it("passes through the dashboard's report parser for new and old shapes", () => {
    const old = { ...base, id: "oldturn001" }, fresh = { ...base, id: "newturn001", toolFailures: [{ tool: "computer.click", error: "permission", count: 1 }] };
    const parsed = parseWorkspaceReport({ v: 1, seq: 1, at: NOW, workspace: { name: "w", kind: "mac", version: "1", platform: "darwin" }, usage: { turns: [old, fresh], runs: [] } });
    const turns = (parsed as { usage?: { turns: Array<Record<string, unknown>> } }).usage?.turns ?? [];
    expect(turns.map((turn) => turn.id)).toEqual(["oldturn001", "newturn001"]);
    expect(turns[1]!.toolFailures).toEqual([{ tool: "computer.click", error: "permission", count: 1 }]);
  });
});
