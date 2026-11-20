import { describe, expect, it } from "vitest";
import { LATE_MS } from "./late-routine";
import { MISSED_WITHIN_MS, routineSleep, SLEPT_FRESH_MS, sleepDevice } from "./routine-sleep";

const NOW = Date.UTC(2026, 10, 12, 12);
const DAY = 86_400_000;
const routine = { id: "r1", name: "Morning brief", enabled: true, runOn: "maus" as const, schedule: { type: "daily" } as never };
const late = (id: string, dueAgo: number) => ({
  id, routineId: "r1", runOn: "maus" as const, manual: false, status: "completed" as const,
  scheduledFor: NOW - dueAgo, startedAt: NOW - dueAgo + LATE_MS,
}) as never;
const missed = (id: string, dueAgo: number) => ({
  id, routineId: "r1", runOn: "maus" as const, manual: false, status: "missed" as const,
  scheduledFor: NOW - dueAgo, error: "This computer was offline for more than 12 hours after the scheduled time",
}) as never;
const awake = { pluggedIn: false, sleptAt: null };

describe("when the routine sleep card is due", () => {
  it("after this computer went to sleep with a routine enabled here, for a while", () => {
    expect(routineSleep({ pluggedIn: false, sleptAt: NOW - 3_600_000 }, [routine], [], NOW)).toEqual({ reason: "slept" });
    expect(routineSleep({ pluggedIn: false, sleptAt: NOW - SLEPT_FRESH_MS }, [routine], [], NOW)).toBeNull();
  });

  it("after two or more scheduled runs this week ran late or never ran while it slept", () => {
    expect(routineSleep(awake, [routine], [late("a", DAY)], NOW)).toBeNull();
    expect(routineSleep(awake, [routine], [late("a", DAY), missed("b", 3 * DAY)], NOW)).toEqual({ reason: "missed", count: 2 });
    expect(routineSleep(awake, [routine], [late("a", DAY), late("b", MISSED_WITHIN_MS + DAY)], NOW)).toBeNull();
  });

  it("never while keep awake while plugged in is on", () => {
    expect(routineSleep({ pluggedIn: true, sleptAt: NOW - 60_000 }, [routine], [late("a", DAY), late("b", 2 * DAY)], NOW)).toBeNull();
  });

  it("never with no routine enabled here: off, held or on dusk cloud", () => {
    const slept = { pluggedIn: false, sleptAt: NOW - 60_000 };
    for (const patch of [{ enabled: false }, { heldFor: "limit" }, { runOn: "cloud" }]) {
      expect(routineSleep(slept, [{ ...routine, ...patch } as never], [], NOW), JSON.stringify(patch)).toBeNull();
    }
    expect(routineSleep(slept, [], [], NOW)).toBeNull();
  });

  it("waits for the desktop's answer, and stays quiet without one", () => {
    expect(routineSleep(undefined, [routine], [], NOW)).toBeUndefined();
    expect(routineSleep(null, [routine], [late("a", DAY), late("b", 2 * DAY)], NOW)).toBeNull();
    expect(routineSleep(undefined, [], [], NOW)).toBeNull();
  });

  it("names this Mac, this PC or this computer", () => {
    expect([sleepDevice("darwin"), sleepDevice("win32"), sleepDevice("linux"), sleepDevice(undefined)]).toEqual(["mac", "pc", "computer", "computer"]);
  });
});
