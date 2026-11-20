import { describe, expect, it } from "vitest";
import { acceptPolicy, compareVersions, freshUpdateRecord, idleForUpdate, inRollout, parsePolicy, refusal, review, rolledBack, sawRun, selfTested, settle, startTrial, TRIAL_MS } from "./update-guard.ts";

const v = (version: string) => ({ version, sha256: version.replace(/\./g, "").padEnd(64, "a").slice(0, 64) });

describe("update guard", () => {
  it("compares versions as numbers", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.4.2", "1.4.2")).toBe(0);
    expect(compareVersions("junk", "0.0.1")).toBe(-1);
  });

  it("updates: a newer signed release goes on trial and settles after its self-test and two runs", () => {
    const r = freshUpdateRecord(v("1.4.1"));
    expect(refusal(r, v("1.4.2"))).toBeNull();
    startTrial(r, v("1.4.2"), 0);
    expect(r.current?.version).toBe("1.4.2");
    expect(selfTested(r, true, 1)).toEqual({ action: "wait" });
    expect(sawRun(r, { id: "a", ok: false }, 2)).toEqual({ action: "wait" });
    expect(sawRun(r, { id: "b", ok: true }, 3)).toEqual({ action: "settle" });
    settle(r, 3);
    expect(r.last).toMatchObject({ kind: "updated", version: "1.4.2" });
    expect(r.previous?.version).toBe("1.4.1");
  });

  it("settles on time when no runs come", () => {
    const r = freshUpdateRecord(v("1.0.0"));
    startTrial(r, v("1.1.0"), 0);
    selfTested(r, true, 1);
    expect(review(r, TRIAL_MS - 1)).toEqual({ action: "wait" });
    expect(review(r, TRIAL_MS)).toEqual({ action: "settle" });
  });

  it("rolls back on a failed self-test, never offers that version again", () => {
    const r = freshUpdateRecord(v("1.4.1"));
    startTrial(r, v("1.4.2"), 0);
    const verdict = selfTested(r, false, 1);
    expect(verdict).toEqual({ action: "rollback", reason: "self_test", to: v("1.4.1") });
    rolledBack(r, v("1.4.1"), "self_test", 2);
    expect(r.current?.version).toBe("1.4.1");
    expect(r.last).toMatchObject({ kind: "rolled_back", version: "1.4.2", reason: "self_test" });
    expect(refusal(r, v("1.4.2"))).toBe("failed_here");
    expect(refusal(r, v("1.4.3"))).toBeNull();
  });

  it("rolls back when the next two runs fail in a row, and names them for a free re-run", () => {
    const r = freshUpdateRecord(v("2.0.0"));
    startTrial(r, v("2.1.0"), 0);
    selfTested(r, true, 1);
    expect(sawRun(r, { id: "x", ok: false }, 2)).toEqual({ action: "wait" });
    expect(sawRun(r, { id: "x", ok: false }, 2)).toEqual({ action: "wait" });
    const verdict = sawRun(r, { id: "y", ok: false }, 3);
    expect(verdict).toMatchObject({ action: "rollback", reason: "runs_failed" });
    expect(rolledBack(r, v("2.0.0"), "runs_failed", 4).failedRuns).toEqual(["x", "y"]);
  });

  it("refuses a blocked version and rolls a running blocked one back", () => {
    const r = freshUpdateRecord(v("1.0.0"));
    startTrial(r, v("1.1.0"), 0); selfTested(r, true, 1); sawRun(r, { id: "a", ok: true }, 2); sawRun(r, { id: "b", ok: true }, 3); settle(r, 3);
    expect(acceptPolicy(r, parsePolicy({ serial: 2, floor: null, blocked: ["1.1.0", "1.2.0"] }))).toBe(true);
    expect(refusal(r, v("1.2.0"))).toBe("blocked");
    expect(review(r, 4)).toEqual({ action: "rollback", reason: "blocked", to: v("1.0.0") });
    // a replayed older policy never loosens the block
    expect(acceptPolicy(r, parsePolicy({ serial: 1, floor: null, blocked: [] }))).toBe(false);
    expect(r.policy.blocked).toContain("1.1.0");
  });

  it("a paused policy holds every install until a newer policy lifts it, and keeps rollbacks", () => {
    const r = freshUpdateRecord(v("1.0.0"));
    startTrial(r, v("1.1.0"), 0);
    expect(acceptPolicy(r, parsePolicy({ serial: 3, floor: null, blocked: [], paused: true }))).toBe(true);
    expect(refusal(r, v("1.2.0"))).toBe("paused");
    expect(selfTested(r, false, 1)).toEqual({ action: "rollback", reason: "self_test", to: v("1.0.0") });
    expect(acceptPolicy(r, parsePolicy({ serial: 4, floor: null, blocked: [] }))).toBe(true);
    expect(refusal(r, v("1.2.0"))).toBeNull();
  });

  it("a staged rollout lets in only installs under its share", () => {
    const policy = parsePolicy({ serial: 1, floor: null, blocked: [], rollout: { "1.2.0": 10 } });
    expect(inRollout(policy, "1.2.0", 9)).toBe(true);
    expect(inRollout(policy, "1.2.0", 10)).toBe(false);
    expect(inRollout(policy, "1.3.0", 99)).toBe(true);
    expect(inRollout(null, "1.2.0", 99)).toBe(true);
    expect(() => parsePolicy({ serial: 1, floor: null, blocked: [], rollout: { "1.2.0": 101 } })).toThrow();
    expect(() => parsePolicy({ serial: 1, floor: null, blocked: [], paused: "yes" })).toThrow();
    // an old policy signs the same body it always did
    expect(JSON.stringify(parsePolicy({ serial: 1, floor: null, blocked: [] }))).toBe('{"serial":1,"floor":null,"blocked":[]}');
  });

  it("refuses a downgrade, and never rolls back below the signed floor", () => {
    const r = freshUpdateRecord(v("3.0.0"));
    expect(refusal(r, v("2.9.9"))).toBe("not_newer");
    expect(refusal(r, v("3.0.0"))).toBe("not_newer");
    acceptPolicy(r, parsePolicy({ serial: 1, floor: "3.0.0", blocked: [] }));
    startTrial(r, v("3.1.0"), 0);
    acceptPolicy(r, parsePolicy({ serial: 2, floor: "3.1.0", blocked: [] }));
    expect(selfTested(r, false, 1)).toEqual({ action: "stuck", reason: "self_test" });
    expect(refusal(freshUpdateRecord(null), v("3.0.0"))).toBeNull();
    const fresh = freshUpdateRecord(null); acceptPolicy(fresh, parsePolicy({ serial: 1, floor: "3.0.0", blocked: [] }));
    expect(refusal(fresh, v("2.0.0"))).toBe("below_floor");
  });

  it("holds an update while a turn, a routine run, an upload or a backup runs", () => {
    expect(idleForUpdate(["recent-activity", "just-woke"])).toBe(true);
    for (const code of ["turn", "run", "maintenance"]) expect(idleForUpdate([code])).toBe(false);
  });

  it("rejects malformed policies", () => {
    expect(() => parsePolicy({ serial: 0, floor: null, blocked: [] })).toThrow();
    expect(() => parsePolicy({ serial: 1, floor: "1.0", blocked: [] })).toThrow();
    expect(() => parsePolicy({ serial: 1, floor: null, blocked: ["x"] })).toThrow();
  });
});
