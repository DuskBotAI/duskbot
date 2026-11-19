import { describe, expect, it, vi } from "vitest";
import { createComposeUpdates } from "./compose-updates.ts";
import { WorkspaceBackupMaintenance } from "./workspace-backup-maintenance.ts";
import type { ComposeUpdateStatus } from "../shared/server-update.ts";
import type { UpdateCheck } from "./update-check.ts";

function fixture() {
  const gate = new WorkspaceBackupMaintenance();
  const check = vi.fn(async (): Promise<UpdateCheck> => ({ current: "0.2.22", latest: "0.2.23", install: "docker", available: true }));
  const state: ComposeUpdateStatus = { automatic: false, phase: "idle", supported: true };
  const idle = vi.fn(() => true);
  const eligible = vi.fn(() => true);
  let claim: { action?: string; permit?: string } | null = null;
  const host = vi.fn(async (_path: string, token?: string) => {
    if (token) {
      claim = service.redeem("claim", token);
      expect(service.redeem("claim", token)).toBeNull();
    }
    return state;
  });
  const service: ReturnType<typeof createComposeUpdates> = createComposeUpdates({ check, eligible, idle, reserve: () => gate.reserveUpdate(idle), host });
  return { gate, check, state, idle, eligible, host, service, claim: () => claim };
}

describe("Compose updater handoff", () => {
  it("requires a fresh owner intent and checks for work again after the pull", async () => {
    const { service, idle, gate, claim } = fixture();
    expect(service.redeem("claim", "made-up")).toBeNull();
    expect(service.redeem("reserve", undefined)).toBeNull();
    idle.mockReturnValue(false);
    await expect(service.request("apply")).rejects.toThrow(/busy/);
    idle.mockReturnValue(true);
    await service.request("apply");
    const token = claim()?.permit;
    expect(claim()).toMatchObject({ action: "apply", latest: "0.2.23" });
    idle.mockReturnValue(false);
    expect(service.redeem("reserve", token)).toEqual({ busy: true });
    idle.mockReturnValue(true);
    const upload = gate.request();
    expect(service.redeem("reserve", token)).toEqual({ busy: true });
    upload();
    expect(service.redeem("reserve", token)).toEqual({ ready: true });
    expect(() => gate.request()).toThrow(/installing an update/);
    expect(service.redeem("reserve", token)).toBeNull();
    expect(service.redeem("release", token)).toEqual({ ok: true });
    expect(service.redeem("reserve", token)).toBeNull();
    expect(() => gate.assertAvailable()).not.toThrow();
  });

  it("recovers admission when the host disappears after reserving", async () => {
    vi.useFakeTimers();
    try {
      const { service, gate, claim } = fixture();
      await service.request("apply");
      expect(service.redeem("reserve", claim()?.permit)).toEqual({ ready: true });
      vi.advanceTimersByTime(180_001);
      expect(gate.active).toBe(false);
      expect(service.redeem("release", claim()?.permit)).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it("checks automatically only with an eligible owner, a working opted-in helper and an idle server", async () => {
    const { service, state, idle, eligible, check, claim } = fixture();
    await service.tick();
    state.automatic = true;
    state.supported = false;
    await service.tick();
    state.supported = true;
    state.phase = "failed";
    await service.tick();
    state.phase = "idle";
    idle.mockReturnValue(false);
    await service.tick();
    idle.mockReturnValue(true);
    eligible.mockReturnValue(false);
    await service.tick();
    expect(check).not.toHaveBeenCalled();
    eligible.mockReturnValue(true);
    await service.tick();
    expect(claim()?.action).toBe("auto");
  });
});
