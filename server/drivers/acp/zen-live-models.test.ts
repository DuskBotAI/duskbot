import { afterEach, describe, expect, it, vi } from "vitest";

import { coolFreeRung, freeFailure, freeRungCooling, FREE_RUNG_COOL_MS, resetFreeLadder } from "./free-ladder.ts";
import { openCodeFreeModelOrder } from "./opencode-go.ts";
import { parseZenModels, refreshZenModels, resetZenModelsForTests, zenFreeModels, zenServes, ZEN_LIST_TTL_MS } from "./zen-live-models.ts";

const BODY = { object: "list", data: [
  { id: "big-pickle", type: "chat", cost: { text: { input: { price: 0 }, output: { price: 0 } } } },
  { id: "deepseek-v4.1-flash-free", type: "chat", cost: { text: { input: { price: 0 }, output: { price: 0 } } } },
  { id: "claude-sonnet-5", type: "chat", cost: { text: { input: { price: 3 }, output: { price: 15 } } } },
  { id: "bge-m3", type: "embedding", cost: { text: { input: { price: 0 }, output: { price: 0 } } } },
] };
const catalog = (ids: string[]) => ({ default: ids[0]!, options: ids.map((id) => ({ id, label: id })) });

afterEach(() => { resetZenModelsForTests(); resetFreeLadder(); });

describe("Zen's live model list", () => {
  it("keeps chat models, and which of them are free", () => {
    resetZenModelsForTests(parseZenModels(BODY, 0));
    expect(zenFreeModels()).toEqual(["opencode/big-pickle", "opencode/deepseek-v4.1-flash-free"]);
    expect(zenServes("opencode/claude-sonnet-5")).toBe(true);
    expect(zenServes("opencode/retired-free")).toBe(false);
    expect(zenServes("deepseek/deepseek-chat"), "another provider's model").toBe(true);
  });

  it("serves everything until a list was read, is read once per TTL, and keeps the last list when a read fails", async () => {
    expect(zenServes("opencode/anything-free")).toBe(true);
    const fetchOk = vi.fn(async () => new Response(JSON.stringify(BODY)));
    await refreshZenModels(fetchOk as never, 1_000, {});
    await refreshZenModels(fetchOk as never, 2_000, {});
    expect(fetchOk).toHaveBeenCalledTimes(1);
    await refreshZenModels(vi.fn(async () => { throw new Error("offline"); }) as never, 1_000 + ZEN_LIST_TTL_MS + 1, {});
    expect(zenServes("opencode/big-pickle")).toBe(true);
    expect(zenServes("opencode/retired-free")).toBe(false);
  });

  it("leaves models Zen no longer serves out of the free fallback ladder", () => {
    resetZenModelsForTests(parseZenModels(BODY, Date.now()));
    const order = openCodeFreeModelOrder("opencode/deepseek-v4.1-flash-free", false, catalog(["opencode/old-one-free", "opencode/deepseek-v4.1-flash-free", "opencode/gone-free"]));
    expect(order).toEqual(["opencode/deepseek-v4.1-flash-free"]);
  });
});

describe("a free model its provider retired", () => {
  it("is read as gone and skipped for hours, not minutes", () => {
    expect(freeFailure("Model opencode/old-one-free is no longer available")).toBe("unavailable");
    coolFreeRung("opencode/old-one-free", "unavailable", 0);
    expect(freeRungCooling("opencode/old-one-free", FREE_RUNG_COOL_MS * 3)).toBe(true);
    expect(freeFailure("FreeUsageLimitError: free usage limit reached")).toBe("pool_limit");
  });
});
