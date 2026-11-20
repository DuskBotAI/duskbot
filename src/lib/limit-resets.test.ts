import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineLimit } from "../../shared/limit-reset";

const api = vi.fn((_path: string) => Promise.resolve({ checkedAt: 2, engines: [] }));
vi.mock("@/state/store", () => ({ api: (path: string) => api(path) }));
const { noteTurnForLimits, rememberLimits } = await import("./limit-resets");

const blocked: EngineLimit = { engine: "claude", name: "Claude", driver: "claude", window: null, usedPercent: 100, resetsAt: Date.now() + 3_600_000, blocked: true };

describe("noteTurnForLimits", () => {
  beforeEach(() => api.mockClear());

  it("asks again when a turn works while an engine reads as at its limit, so the banner goes", () => {
    rememberLimits({ checkedAt: 1, engines: [blocked] });
    noteTurnForLimits({ type: "turn.completed", ok: true });
    expect(api).toHaveBeenCalledWith("/api/limit-resets?refresh=1");
  });

  it("asks again when a turn is refused by a limit", () => {
    rememberLimits({ checkedAt: 1, engines: [] });
    noteTurnForLimits({ type: "runtime.error", limit: "engine" });
    noteTurnForLimits({ type: "runtime.error", limitResetsAt: Date.now() + 60_000 });
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("leaves ordinary turns to the poll", () => {
    rememberLimits({ checkedAt: 1, engines: [] });
    noteTurnForLimits({ type: "turn.completed", ok: true });
    noteTurnForLimits({ type: "turn.completed", ok: false });
    noteTurnForLimits({ type: "runtime.error" });
    expect(api).not.toHaveBeenCalled();
  });
});
