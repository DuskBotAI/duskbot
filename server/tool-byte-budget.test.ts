import { describe, expect, it } from "vitest";

import {
  ANTIGRAVITY_EAGER_BYTE_BUDGET,
  capToolListByBytes,
  capToolListResultByBytes,
  parseToolByteBudget,
  shareToolByteBudget,
  TOOL_BYTE_BUDGET_ENV,
  toolByteBudgetFromEnv,
} from "./tool-byte-budget.ts";

describe("tool byte budget parsing", () => {
  it("accepts positive integer budgets and ignores invalid values", () => {
    expect(parseToolByteBudget("54000")).toBe(54_000);
    expect(toolByteBudgetFromEnv({ [TOOL_BYTE_BUDGET_ENV]: "12000" })).toBe(12_000);
    expect(parseToolByteBudget("0")).toBeUndefined();
    expect(parseToolByteBudget("-10")).toBeUndefined();
    expect(parseToolByteBudget("5000000")).toBeUndefined();
    expect(parseToolByteBudget("abc")).toBeUndefined();
    expect(parseToolByteBudget(undefined)).toBeUndefined();
  });
});

describe("sharing an eager byte budget across servers", () => {
  it("prioritizes primary servers over computer and custom servers without exceeding the budget", () => {
    const shares = shareToolByteBudget([
      { name: "agents", tier: "primary", ceiling: 15_000 },
      { name: "composio-connect", tier: "primary", ceiling: 10_000 },
      { name: "browser", tier: "primary", ceiling: 9_000 },
      { name: "data", tier: "primary", ceiling: 4_500 },
      { name: "computer", tier: "core", ceiling: 10_000 },
      { name: "custom-a", tier: "custom" },
      { name: "custom-b", tier: "custom" },
    ], ANTIGRAVITY_EAGER_BYTE_BUDGET);

    expect(shares.get("agents")).toBe(15_000);
    expect(shares.get("composio-connect")).toBe(10_000);
    expect(shares.get("browser")).toBe(9_000);
    expect(shares.get("data")).toBe(4_500);
    expect(shares.get("computer")).toBe(10_000);
    expect(shares.get("custom-a")).toBe(2_750);
    expect(shares.get("custom-b")).toBe(2_750);
    expect([...shares.values()].reduce((sum, n) => sum + n, 0)).toBe(ANTIGRAVITY_EAGER_BYTE_BUDGET);
  });

  it("redistributes unused budget across mounted servers when no custom or computer servers compete", () => {
    const shares = shareToolByteBudget([
      { name: "agents", tier: "primary", ceiling: 15_000 },
      { name: "browser", tier: "primary", ceiling: 9_000 },
      { name: "data", tier: "primary", ceiling: 4_500 },
    ], ANTIGRAVITY_EAGER_BYTE_BUDGET);

    expect(shares.get("agents")).toBe(23_500);
    expect(shares.get("browser")).toBe(17_500);
    expect(shares.get("data")).toBe(13_000);
    expect([...shares.values()].reduce((sum, n) => sum + n, 0)).toBe(ANTIGRAVITY_EAGER_BYTE_BUDGET);
  });

  it("never exceeds the budget for any size including tight budgets", () => {
    for (const budget of [0, 1, 500, 10_000, ANTIGRAVITY_EAGER_BYTE_BUDGET]) {
      const shares = shareToolByteBudget([
        { name: "agents", tier: "primary", ceiling: 15_000 },
        { name: "composio", tier: "primary", ceiling: 10_000 },
        { name: "computer", tier: "core", ceiling: 10_000 },
        { name: "notes", tier: "custom" },
      ], budget);
      expect([...shares.values()].reduce((sum, n) => sum + n, 0)).toBeLessThanOrEqual(budget);
    }
  });
});

describe("capping a tool list by bytes", () => {
  const make = (name: string, pad = 0) => ({ name, description: "x".repeat(pad), inputSchema: { type: "object", properties: {} } });

  it("keeps tools in priority order up to maxBytes and skips an oversized outlier so smaller tools still fit", () => {
    const small1 = make("first", 10);
    const huge = make("giant", 600);
    const small2 = make("second", 10);
    const capped = capToolListByBytes([small1, huge, small2], 250);
    expect(capped.tools.map((tool) => tool.name)).toEqual(["first", "second"]);
    expect(capped.omitted).toBe(1);
    expect(capped.bytes).toBeLessThanOrEqual(250);
  });

  it("returns the original result untouched when everything fits or no budget is set", () => {
    const result = { tools: [make("a"), make("b")], nextCursor: "p2" };
    expect(capToolListResultByBytes(result, undefined)).toBe(result);
    expect(capToolListResultByBytes(result, 10_000)).toBe(result);
  });

  it("drops nextCursor and logs once when tools are omitted", () => {
    const lines: string[] = [];
    const result = { tools: [make("a", 10), make("b", 400), make("c", 10)], nextCursor: "p2" };
    const capped = capToolListResultByBytes(result, 250, (line) => lines.push(line)) as { tools: Array<{ name: string }>; nextCursor?: string };
    expect(capped.tools.map((tool) => tool.name)).toEqual(["a", "c"]);
    expect(capped.nextCursor).toBeUndefined();
    expect(lines).toEqual([expect.stringMatching(/^listed 2 of 3 tools \(\d+ of 250 bytes\) to fit the eager tool budget$/)]);
  });
});
