import { CLOUD_HOME } from "../../../electron/legacy-names.mjs";
import { chmodSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { StoredSubscription } from "../../dashboard/server/billing/store.ts";
import { homeBackupKey } from "./backups.ts";
import { INSTABOX_BOOT_FILE, INSTABOX_PACKAGE_FILE, INSTABOX_SETUP_FILE } from "./home.ts";
import { OWNER_SLEEP_GRACE_MS } from "./lifecycle.ts";
import { pooledCostProfile } from "./power/pooled-profile.ts";
import { DAY_MS, deletionVerdict, entitlementOf } from "./retention.ts";
import { createSealer } from "../../dashboard/server/clouds/seal.ts";
import { BACKUP_SECRET, homeFixture, plan, SHA } from "./test-fixture.ts";

const execs = (f: Awaited<ReturnType<typeof homeFixture>>) => f.api.requests.filter(r => r.path.endsWith("/exec")).map(r => (r.body as { cmd: string }).cmd);

it("provisions a paid cloud: a labelled machine, secrets only in its boot file, package installed, home started", async () => {
  const f = await homeFixture();
  const { c } = await f.paid();
  expect(c).toMatchObject({ backend: "managed", status: "running", setupStep: null });
  expect(c.origin).toMatch(/^https:\/\/8080-[a-z0-9]+\.instabox\.tech$/);
  const create = f.api.requests.find(r => r.method === "POST" && r.path === "/v1/machines")!.body as Record<string, any>;
  const secret = createSealer(Buffer.alloc(32, 7)).unseal(c.bootstrapSecret);
  expect(JSON.stringify(create)).not.toContain(secret);
  expect(create.metadata).toMatchObject({ "omb.cloud": c.id, "omb.scope": "0123456789abcdef" });
  const machine = f.api.machines.get(c.serverId!)!;
  expect(machine.files.get(INSTABOX_SETUP_FILE)!.toString()).not.toContain(secret);
  expect(machine.files.get(INSTABOX_BOOT_FILE)!.toString()).toContain(secret);
  const commands = execs(f).filter(cmd => cmd.includes("omb-home"));
  expect(commands[0]).toContain(`omb-home install ${INSTABOX_PACKAGE_FILE} ${SHA}`);
  expect(commands[1]).toBe(`sudo -n ${CLOUD_HOME.root}/bin/omb-home start '${c.origin}' '${c.origin}'`);
  expect(JSON.stringify(f.audit.entries(c.id))).not.toContain(secret);
  expect(f.service.view(c)).toMatchObject({ provider: "managed", status: "running" });
});

it("calls a new home ready only once its bot computers can start, and never waits more than 15 minutes for their image", async () => {
  for (const finished of [true, false]) {
    const f = await homeFixture();
    let building = true;
    f.api.onExec(({ cmd }) => cmd.includes("omb-home desktop-status") ? { exitCode: 0, stdout: building ? "building\n" : "ready\n" } : null);
    const c = f.service.order({ ...plan, accountId: "acct_1", name: "My Cloud", color: null, region: "eu" });
    f.subscriptions.push({ id: "sub_img", accountId: "acct_1", cloudId: c.id, status: "active", currentPeriodEnd: f.now() + 30 * DAY_MS, updatedAt: f.now() } as unknown as StoredSubscription);
    f.service.activate(c.id, "sub_img", plan);
    for (let n = 0; n < 20; n++) { c.nextAttemptAt = 0; await f.service.reconcile(); }
    expect(c).toMatchObject({ status: "provisioning", setupStep: "checking", attempts: 0, error: null });
    if (finished) building = false; else f.advance(16 * 60_000);
    await f.settle(c, x => x.status === "running");
    expect(c.error).toBeNull();
  }
});

it("waits out a slow setup script without counting it as a failure", async () => {
  const f = await homeFixture({ setupPolls: 30 });
  const c = f.service.order({ ...plan, accountId: "acct_1", name: "My Cloud", color: null, region: "eu" });
  f.subscriptions.push({ id: "sub_slow", accountId: "acct_1", cloudId: c.id, status: "active", currentPeriodEnd: f.now() + 30 * DAY_MS, updatedAt: f.now() } as unknown as StoredSubscription);
  f.service.activate(c.id, "sub_slow", plan);
  for (let n = 0; n < 40 && c.status === "provisioning"; n++) { c.nextAttemptAt = 0; await f.service.reconcile(); }
  expect(c).toMatchObject({ status: "running", attempts: 0, error: null });
});

it("sleeps an idle home after the handshake, wakes it for its owner, and wakes it before a routine", async () => {
  const f = await homeFixture();
  const { c } = await f.paid();
  f.advance(5 * 60_000); f.power.idle = true; f.power.busy = [];
  await f.settle(c, c => c.status === "sleeping", 60, 5 * 60_000);
  // the handshake asks the home to agree to the idle time the policy saw, never less than the rails' minimum
  const asked = f.home.sleep.mock.calls.at(-1)! as unknown as [string, string, number];
  expect(asked[0]).toBe(c.origin);
  expect(asked[2]).toBeGreaterThanOrEqual(3);
  expect(f.api.machines.get(c.serverId!)!.state).toBe("suspended");
  await f.service.power(c.accountId, c.id, "on");
  await f.settle(c, c => c.status === "running");
  expect(f.api.machines.get(c.serverId!)!.processesPreserved).toBe(true);
  expect(f.audit.entries(c.id).map(e => e.action)).toEqual(expect.arrayContaining(["sleep", "wake", "awake"]));
  // a routine three hours out, far past a start's break-even: asleep now, awake within the lead and this home's spread before it
  f.advance(5 * 60_000); const due = f.now() + 3 * 60 * 60_000; f.power.nextDueAt = due;
  await f.settle(c, c => c.status === "sleeping", 60, 5 * 60_000);
  f.advance(due - 10 * 60_000 - f.now()); c.nextAttemptAt = 0; await f.service.reconcile();
  expect(c.status).toBe("sleeping");
  f.advance(9 * 60_000); await f.settle(c, c => c.status === "running");
  expect(f.audit.entries(c.id).filter(e => e.action === "wake").at(-1)!.reason).toBe("routine_due");
});

it("says who stopped it: our idle sleep, then the owner's pause of a home already asleep, which their wake clears", async () => {
  const f = await homeFixture();
  const { c } = await f.paid();
  f.advance(5 * 60_000); f.power.idle = true; f.power.busy = [];
  await f.settle(c, c => c.status === "sleeping", 60, 5 * 60_000);
  expect(f.service.view(c).stoppedBy).toBe("idle");
  await f.service.power(c.accountId, c.id, "off");
  c.nextAttemptAt = 0; await f.service.reconcile();
  expect(c.status).toBe("sleeping");
  expect(f.service.view(c).stoppedBy).toBe("user");
  expect(c.pauseRequestedAt).toBeUndefined();
  await f.service.power(c.accountId, c.id, "on");
  await f.settle(c, c => c.status === "running");
  expect(f.service.view(c).stoppedBy).toBeNull();
});

it("backs up an idle home's volume from the running machine before it sleeps, encrypted off the provider, and keeps the newest generations", async () => {
  const f = await homeFixture();
  const { c } = await f.paid();
  for (let day = 0; day < 4; day++) {
    f.advance(DAY_MS); f.power.idle = true; f.power.busy = [];
    await f.settle(c, c => c.status === "sleeping", 60, 5 * 60_000);
    expect(f.audit.entries(c.id).filter(e => e.action === "backup").at(-1)!.reason).toBe("before_sleep");
    await f.service.power(c.accountId, c.id, "on"); await f.settle(c, c => c.status === "running");
  }
  expect(c.managed!.backups).toHaveLength(3);
  expect(c.managed!.backups.every(g => g.verifiedAt !== null)).toBe(true);
  // the backup came from the live snapshot, which is removed from the machine once read
  expect(execs(f).filter(cmd => cmd.includes("omb-home snapshot-done")).length).toBeGreaterThanOrEqual(4);
  const files = readdirSync(join(f.dataDir, "managed-backups", c.id));
  expect(files).toHaveLength(3);
  for (const file of files) expect(readFileSync(join(f.dataDir, "managed-backups", c.id, file)).includes("Test bot")).toBe(false);
});

it("recovers a lost machine from its newest backup into a fresh one and tells the owner", async () => {
  const f = await homeFixture();
  const { c } = await f.paid();
  f.advance(DAY_MS); f.power.idle = true; f.power.busy = [];
  await f.settle(c, c => c.status === "sleeping", 60, 5 * 60_000);
  expect(c.managed!.backups).toHaveLength(1);
  const lost = c.serverId!;
  f.api.lose(lost);
  // one 404 is not a lost machine: only repeated ones over half an hour, and gone from the account's list
  c.nextAttemptAt = 0; await f.service.reconcile();
  expect(c.serverId).toBe(lost);
  for (let n = 0; n < 40 && !(c.status === "running" && c.serverId !== lost); n++) { f.advance(11 * 60_000); c.nextAttemptAt = 0; await f.service.reconcile(); }
  expect(c.status === "running" && c.serverId !== lost).toBe(true);
  expect(c.managed!.attempt).toBe(1);
  const fresh = f.api.machines.get(c.serverId!)!;
  expect(JSON.parse(fresh.volume.get("data/.omb-cloud-home.json")!.toString())).toMatchObject({ machine: c.id });
  expect(fresh.volume.get(`data/${CLOUD_HOME.dataName}/bots.json`)!.toString()).toContain("Test bot");
  expect(f.notices.map(n => n.kind)).toContain("recovered");
  expect(f.api.deletes()).toHaveLength(0);
});

async function twoBackupsThenLost(corrupt: "newest" | "all") {
  const f = await homeFixture();
  const { c } = await f.paid();
  for (let day = 0; day < 2; day++) {
    f.advance(DAY_MS); f.power.idle = true; f.power.busy = [];
    await f.settle(c, c => c.status === "sleeping", 60, 5 * 60_000);
    if (day === 0) { await f.service.power(c.accountId, c.id, "on"); await f.settle(c, c => c.status === "running"); }
  }
  const generations = c.managed!.backups.filter(g => g.verifiedAt !== null);
  expect(generations).toHaveLength(2);
  for (const g of corrupt === "all" ? generations : generations.slice(-1)) {
    const path = join(f.dataDir, "managed-backups", c.id, g.file);
    chmodSync(path, 0o600); writeFileSync(path, "damaged");
  }
  const lost = c.serverId!;
  f.api.lose(lost);
  for (let n = 0; n < 80 && !(c.serverId !== lost && (c.status === "running" || c.status === "error")); n++) { f.advance(11 * 60_000); c.nextAttemptAt = 0; await f.service.reconcile(); }
  return { f, c, generations };
}

it("a restore that keeps failing falls back to the next older verified backup, a bounded number of tries each", async () => {
  const { f, c, generations } = await twoBackupsThenLost("newest");
  expect(c.status).toBe("running");
  expect(c.managed!.restoredFrom).toMatchObject({ file: generations[0]!.file, at: generations[0]!.snapshotAt });
  expect(c.managed!.badRestores).toEqual([generations[1]!.file]);
  const actions = f.audit.entries(c.id).map(e => e.action);
  expect(actions.filter(a => a === "restore_failed")).toHaveLength(3);
  expect(actions).toContain("restore_fallback");
  expect(f.notices.findLast(n => n.kind === "recovered")).toMatchObject({ at: generations[0]!.snapshotAt });
});

it("a recovery with no backup that restores stops in the error state for the operator instead of retrying forever", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { f, c } = await twoBackupsThenLost("all");
  expect(c.status).toBe("error");
  expect(f.audit.entries(c.id).filter(e => e.action === "restore_failed")).toHaveLength(6);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("no backup of it restores"));
  expect(f.api.deletes()).toHaveLength(0);
  warn.mockRestore();
});

it("keeps an ended plan's home asleep for 30 days with notices, then deletes it only after the final backup it took before sleeping", async () => {
  const f = await homeFixture();
  const { c, sub } = await f.paid();
  sub.status = "ended"; sub.currentPeriodEnd = f.now(); sub.lastEventAt = f.now();
  await f.settle(c, c => c.status === "stopped");
  // the final copy was read from the running home right before it slept for its plan, and the verdict accepts it
  const final = c.managed!.backups.at(-1)!;
  expect(final.verifiedAt).not.toBeNull();
  expect(final.snapshotAt).toBeGreaterThanOrEqual(c.managed!.lastStopAt!);
  expect(f.audit.entries(c.id).filter(e => e.action === "backup").map(e => e.reason)).toEqual(["plan_ended"]);
  expect(f.api.machines.get(c.serverId!)!.state).toBe("suspended");
  expect(f.notices.map(n => n.kind)).toEqual(["ended"]);
  for (const day of [15, 23, 29, 29.9]) { f.advance((day - (f.now() - sub.currentPeriodEnd!) / DAY_MS) * DAY_MS); c.nextAttemptAt = 0; await f.service.reconcile(); await f.service.reconcile(); }
  expect(f.notices.map(n => n.kind)).toEqual(["ended", "left_7"]);
  expect(f.api.deletes()).toHaveLength(0);
  expect(c.status).toBe("stopped");
  // kept as a free provider snapshot, its machine and the disk we pay for deleted at once
  const archive = c.managed!.archive!;
  expect(c.serverId).toBeNull();
  expect(f.api.snapshots.get(archive.snapshotId)!.volume.get(`data/${CLOUD_HOME.dataName}/bots.json`)!.toString()).toContain("Test bot");
  expect(f.api.machines.size).toBe(0);
  expect(f.api.machineDeletes()).toHaveLength(1);
  f.advance(0.2 * DAY_MS);
  await f.settle(c, c => c.status === "destroyed");
  expect(f.api.deletes()).toHaveLength(1);
  expect(f.api.snapshots.size).toBe(0);
  expect(f.alerts).toEqual(expect.arrayContaining(["snapshot_deleted:retention_over", "deleted:retention_over"]));
  expect(f.notices.at(-1)!.kind).toBe("deleted");
  expect(f.workspaces.remove).toHaveBeenCalledWith("workspace-1");
  // the backups outlive the machine for the tail, then go
  expect(f.backups.list(c.id).length).toBeGreaterThan(0);
  f.advance(31 * DAY_MS); await f.service.reconcile();
  expect(f.backups.list(c.id)).toEqual([]);
});

it("an ended plan's home that paused itself with no final backup is woken once to take it, then deleted after retention", async () => {
  const f = await homeFixture();
  const { c, sub } = await f.paid();
  // our lease lapsed: the provider paused the machine on its own, with data newer than any backup
  f.advance(60_000); f.api.autoPause(c.serverId!);
  sub.status = "ended"; sub.currentPeriodEnd = f.now(); sub.lastEventAt = f.now();
  await f.settle(c, c => c.status === "stopped" && (c.managed!.backups.at(-1)?.verifiedAt ?? null) !== null, 20, 60_000);
  for (let n = 0; n < 10; n++) { f.advance(30 * 60_000); c.nextAttemptAt = 0; await f.service.reconcile(); }
  const wakes = f.audit.entries(c.id).filter(e => e.action === "wake");
  expect(wakes.map(e => e.reason)).toEqual(["final_backup"]);
  expect(c.managed!.archive).toMatchObject({ serverId: null });
  expect(c.managed!.backups.at(-1)!.snapshotAt).toBeGreaterThanOrEqual(c.managed!.lastStopAt!);
  f.advance(46 * DAY_MS);
  await f.settle(c, c => c.status === "destroyed");
  expect(f.api.deletes()).toHaveLength(1);
});

it("an ended plan's paused home is woken once for its final backup while its resume still reads as paused, then archived", async () => {
  const f = await homeFixture();
  const { c, sub } = await f.paid();
  f.advance(60_000); f.api.autoPause(c.serverId!);
  f.api.queueStarts();
  sub.status = "ended"; sub.currentPeriodEnd = f.now(); sub.lastEventAt = f.now();
  for (let n = 0; n < 16; n++) { f.advance(15_000); c.nextAttemptAt = 0; await f.service.reconcile(); }
  expect(f.audit.entries(c.id).filter(e => e.action === "wake" && e.reason === "final_backup")).toHaveLength(1);
  f.api.queueStarts(false); f.api.finishStarts();
  await f.settle(c, x => x.managed!.archive?.serverId === null, 20, 15_000);
  expect(c.serverId).toBeNull();
  expect(f.api.machines.size).toBe(0);
});

it("an ended plan's home whose pause is refused for a while is asked again without outdating its final backup, then archived", async () => {
  const f = await homeFixture();
  const { c, sub } = await f.paid();
  sub.status = "ended"; sub.currentPeriodEnd = f.now(); sub.lastEventAt = f.now();
  f.api.busyNext(6);
  for (let n = 0; n < 12 && !c.managed!.archive; n++) { f.advance(15_000); c.nextAttemptAt = 0; await f.service.reconcile(); }
  const entries = f.audit.entries(c.id);
  expect(entries.filter(e => e.action === "sleep" && e.reason === "plan")).toHaveLength(1);
  expect(entries.filter(e => e.action === "backup").map(e => e.reason)).toEqual(["plan_ended"]);
  expect(entries.filter(e => e.action === "wake")).toHaveLength(0);
  expect(c.managed!.backups.at(-1)!.snapshotAt).toBeGreaterThanOrEqual(c.managed!.lastStopAt!);
  expect(c.managed!.archive).toMatchObject({ serverId: null });
  expect(c.serverId).toBeNull();
});

it("a failed lifecycle step is logged with its cause, not only counted", async () => {
  const f = await homeFixture();
  const { c } = await f.paid();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  f.api.failNext(50);
  c.nextAttemptAt = 0; await f.service.reconcile();
  expect(c.attempts).toBe(1);
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^clouds: cloud ${c.id} step failed \\(attempt 1\\): \\w*Error: .+`)));
  warn.mockRestore();
});

it("renewing before the end of retention brings the home back without losing anything", async () => {
  const f = await homeFixture();
  const { c, sub } = await f.paid();
  sub.status = "ended"; sub.currentPeriodEnd = f.now(); sub.lastEventAt = f.now();
  await f.settle(c, c => c.status === "stopped");
  f.advance(20 * DAY_MS);
  sub.status = "active"; sub.currentPeriodEnd = f.now() + 30 * DAY_MS;
  await f.settle(c, c => c.status === "running");
  expect(f.notices.map(n => n.kind)).toContain("resumed");
  expect(f.api.deletes()).toHaveLength(0);
});

it("a new subscription within retention revives the paused home with its data; once retention is over it cannot", async () => {
  const f = await homeFixture();
  const { c, sub } = await f.paid();
  const serverId = c.serverId!;
  sub.status = "ended"; sub.currentPeriodEnd = f.now(); sub.lastEventAt = f.now();
  f.service.end(c.id, f.now() + 7 * DAY_MS);
  await f.settle(c, c => c.status === "stopped");
  f.advance(20 * DAY_MS); c.nextAttemptAt = 0; await f.service.reconcile();
  expect(f.service.revivable(c.id, plan)).toBe(true);
  const next: StoredSubscription = { ...sub, id: "sub_again", status: "active", currentPeriodStart: f.now(), currentPeriodEnd: f.now() + 30 * DAY_MS };
  f.subscriptions.push(next);
  expect(f.service.revive(c.id, next.id, plan)).toBe(true);
  await f.settle(c, c => c.status === "running", 20, 1_000);
  // a new machine booted from the archive's snapshot: no setup ran on it, its data is the old disk's
  expect(c.serverId).not.toBe(serverId);
  expect(f.api.machines.has(serverId)).toBe(false);
  const create = f.api.requests.filter(r => r.method === "POST" && r.path === "/v1/machines").at(-1)!.body as Record<string, unknown>;
  expect(create).toMatchObject({ snapshotId: expect.stringMatching(/^sn_/) });
  expect(create.templateId).toBeUndefined();
  expect(f.api.machines.get(c.serverId!)!.volume.get(`data/${CLOUD_HOME.dataName}/bots.json`)!.toString()).toContain("Test bot");
  expect(f.notices.map(n => n.kind)).toContain("resumed");
  expect(f.notices.map(n => n.kind)).not.toContain("recovered");
  // the snapshot did its job and is gone; nothing else was deleted
  expect(c.managed!.archive).toBeNull();
  expect(f.api.snapshots.size).toBe(0);
  expect(f.api.deletes().map(d => d.path)).toEqual([expect.stringMatching(/^\/v1\/snapshots\/sn_/)]);

  const other = await f.paid("acct_2");
  other.sub.status = "ended"; other.sub.currentPeriodEnd = f.now(); other.sub.lastEventAt = f.now();
  f.service.end(other.c.id, f.now() + 7 * DAY_MS);
  await f.settle(other.c, c => c.status === "stopped");
  f.advance(31 * DAY_MS);
  expect(f.service.revivable(other.c.id, plan)).toBe(false);
  expect(f.service.revive(other.c.id, "sub_late", plan)).toBe(false);
});

it("a provider outage while running never marks the cloud failed", async () => {
  const f = await homeFixture();
  const { c } = await f.paid();
  for (let n = 0; n < 12; n++) { f.api.failNext(1); c.nextAttemptAt = 0; await f.service.reconcile(); }
  expect(c.status).toBe("running");
  expect(c.error).toBeNull();
});

it("pauses machines no live cloud runs on and never deletes one that may hold someone's data", async () => {
  const f = await homeFixture();
  const { c } = await f.paid();
  const stray = await f.provider.create({ cloudId: `c${"e".repeat(24)}`, spec: plan.spec, region: "eu", userData: "", ttlSeconds: 3600 });
  f.advance(1000);
  const duplicate = await f.provider.create({ cloudId: c.id, spec: plan.spec, region: "eu", userData: "", ttlSeconds: 3600, attempt: 9 });
  f.advance(31 * 60_000); c.nextAttemptAt = 0; await f.service.reconcile();
  expect(f.api.machines.get(stray.id)!.state).toBe("suspended");
  expect(f.api.machines.get(duplicate.id)!.state).toBe("suspended");
  // newer than the cloud's own machine: kept for an operator, never retired
  expect(c.managed!.retired.map(r => r.serverId)).not.toContain(duplicate.id);
  expect(f.audit.entries(c.id).map(e => e.action)).toContain("orphan_kept");
  for (let day = 0; day < 50; day++) { f.advance(DAY_MS); c.nextAttemptAt = 0; await f.service.reconcile(); }
  expect(f.api.deletes()).toHaveLength(0);
  expect(f.audit.entries().map(e => e.action)).toContain("orphan_unclaimed");
  expect(f.api.machines.has(stray.id) && f.api.machines.has(duplicate.id) && f.api.machines.has(c.serverId!)).toBe(true);
});

it("a failed charge stops the cloud at once: a paid plan's data is kept 30 days from the failure, a trial's 7 from its end", async () => {
  const problem = { since: 10 * DAY_MS, fixBy: 40 * DAY_MS, sent: ["first"] };
  const sub = { id: "sub_x", cloudId: "c1", status: "payment_problem", cancelAtPeriodEnd: false, currentPeriodEnd: 10 * DAY_MS, paymentProblem: problem } as unknown as StoredSubscription;
  const cloud = { id: "c1", subscriptionId: "sub_x" }, verdict = (entitlement: ReturnType<typeof entitlementOf>, now: number) =>
    deletionVerdict({ now, retentionDays: 30, entitlement, finalBackup: null, lastStopAt: null, ownerRequest: null, hold: false });
  expect(entitlementOf([sub], cloud, 10 * DAY_MS + 1)).toEqual({ active: false, until: 10 * DAY_MS, known: true, unpaid: { trial: false } });
  // billing ends the plan at the deletion date: the clock still runs from the failure
  const ended = { ...sub, status: "ended" } as StoredSubscription;
  const at40 = entitlementOf([ended], { ...cloud, ended: true, endedAt: 40 * DAY_MS }, 40 * DAY_MS);
  expect(at40).toMatchObject({ until: 10 * DAY_MS, unpaid: { trial: false } });
  expect(verdict(at40, 40 * DAY_MS)).toMatchObject({ delete: false, reason: "no_final_backup", earliestAt: 40 * DAY_MS });
  // a trial's first charge: kept 7 days from the trial's end, with no final backup owed
  const trial = { ...sub, trialEndsAt: 9 * DAY_MS, paymentProblem: { ...problem, fixBy: 16 * DAY_MS, trial: true } } as unknown as StoredSubscription;
  const trialEntitlement = entitlementOf([trial], cloud, 12 * DAY_MS);
  expect(trialEntitlement).toMatchObject({ active: false, until: 9 * DAY_MS, unpaid: { trial: true } });
  expect(verdict(trialEntitlement, 12 * DAY_MS)).toMatchObject({ delete: false, earliestAt: 16 * DAY_MS });
  expect(verdict(trialEntitlement, 16 * DAY_MS)).toMatchObject({ delete: true, reason: "retention_over" });
  // a trial billing gave a later date (it ended long before this policy): kept to that date
  const late = entitlementOf([{ ...trial, paymentProblem: { ...problem, fixBy: 30 * DAY_MS, trial: true } } as unknown as StoredSubscription], cloud, 12 * DAY_MS);
  expect(verdict(late, 29 * DAY_MS)).toMatchObject({ delete: false, earliestAt: 30 * DAY_MS });
  const f = await homeFixture();
  const { c, sub: paid } = await f.paid();
  paid.status = "payment_problem"; paid.paymentProblem = { since: f.now(), fixBy: f.now() + 30 * DAY_MS, sent: ["first"] };
  await f.settle(c, c => c.status === "stopped");
  expect(c.status).toBe("stopped");
  f.advance(25 * DAY_MS); for (let n = 0; n < 5; n++) { c.nextAttemptAt = 0; await f.service.reconcile(); }
  expect(f.notices.filter(n => n.kind.startsWith("left_")), "billing sends this story's emails").toEqual([]);
  paid.status = "active"; delete paid.paymentProblem; paid.currentPeriodEnd = f.now() + 30 * DAY_MS;
  await f.settle(c, c => c.status === "running", 40);
  expect(c.status).toBe("running");
});

it("a plan that drops the desktop ends its entitlement at the drop, and a renewal cancels a pending owner delete", async () => {
  const sub = { id: "sub_x", cloudId: null, status: "active", currentPeriodEnd: 50 * DAY_MS, updatedAt: 0, lastEventAt: 5 * DAY_MS } as unknown as StoredSubscription;
  expect(entitlementOf([sub], { id: "c1", subscriptionId: "sub_x", endsAt: 20 * DAY_MS }, 10 * DAY_MS)).toMatchObject({ active: true, until: null });
  expect(entitlementOf([sub], { id: "c1", subscriptionId: "sub_x", endsAt: 20 * DAY_MS }, 21 * DAY_MS)).toMatchObject({ active: false, until: 20 * DAY_MS });
  expect(entitlementOf([sub], { id: "c1", subscriptionId: "sub_x", ended: true, endedAt: 15 * DAY_MS }, 21 * DAY_MS)).toMatchObject({ active: false, until: 15 * DAY_MS });
  // later events never move the date: a renewal of the same subscription after the cloud ended changes nothing
  expect(entitlementOf([{ ...sub, lastEventAt: 30 * DAY_MS, currentPeriodEnd: 80 * DAY_MS } as StoredSubscription], { id: "c1", subscriptionId: "sub_x", ended: true, endedAt: 15 * DAY_MS }, 31 * DAY_MS)).toMatchObject({ until: 15 * DAY_MS });
  // a subscription that will not renew counts only to its period end, whatever its status
  expect(entitlementOf([{ ...sub, cloudId: "c1", cancelAtPeriodEnd: true, currentPeriodEnd: 20 * DAY_MS } as StoredSubscription], { id: "c1", subscriptionId: "sub_x" }, 21 * DAY_MS)).toMatchObject({ active: false, until: 20 * DAY_MS });
  const f = await homeFixture();
  const { c, sub: paid } = await f.paid();
  paid.status = "ended"; paid.currentPeriodEnd = f.now(); paid.lastEventAt = f.now();
  await f.settle(c, c => c.status === "stopped");
  f.service.managed!.requestDelete(c, token => `https://dash.example.test/#${token}`);
  const token = f.notices.findLast(n => n.kind === "delete_requested")!.link!.split("#")[1]!;
  f.service.managed!.confirmDelete(c, token);
  paid.status = "active"; paid.currentPeriodEnd = f.now() + 30 * DAY_MS;
  await f.settle(c, c => c.status === "running");
  expect(c.managed!.deleteRequest!.cancelledAt).not.toBeNull();
  paid.status = "ended"; paid.currentPeriodEnd = f.now(); paid.lastEventAt = f.now();
  f.advance(8 * DAY_MS); await f.settle(c, c => c.status === "stopped");
  for (let n = 0; n < 4; n++) { c.nextAttemptAt = 0; await f.service.reconcile(); }
  expect(f.api.deletes()).toHaveLength(0);
});

it("a delete whose answer was lost is never mistaken for a lost machine, and cannot be cancelled mid-way", async () => {
  const f = await homeFixture();
  const { c, sub } = await f.paid();
  sub.status = "ended"; sub.currentPeriodEnd = f.now(); sub.lastEventAt = f.now();
  await f.settle(c, c => c.status === "stopped");
  expect(c.managed!.backups.at(-1)?.verifiedAt ?? null).not.toBeNull();
  f.service.managed!.requestDelete(c, token => `https://dash.example.test/#${token}`);
  f.service.managed!.confirmDelete(c, f.notices.findLast(n => n.kind === "delete_requested")!.link!.split("#")[1]!);
  f.advance(8 * DAY_MS);
  const real = f.provider.requestDelete;
  f.provider.requestDelete = async id => { await real(id); throw new Error("answer lost"); };
  c.nextAttemptAt = 0; await f.service.reconcile();
  expect(c.status).toBe("destroying");
  expect(c.managed!.deleteRequest!.cancelledAt).toBeNull();
  expect(() => f.service.managed!.cancelDelete(c)).toThrow("unavailable");
  f.provider.requestDelete = real;
  await f.settle(c, c => c.status === "destroyed");
  expect(c.managed!.attempt).toBe(0);
  expect(f.notices.map(n => n.kind)).not.toContain("recovered");
});

it("a plan upgrade resizes the machine in place: its disk kept, booted on the new size, started", async () => {
  const f = await homeFixture();
  const { c } = await f.paid();
  const machine = f.api.machines.get(c.serverId!)!;
  machine.volume.set(`data/${CLOUD_HOME.dataName}/kept.json`, Buffer.from("kept"));
  expect([machine.vcpus, machine.memMiB]).toEqual([2, 4096]);
  f.service.changePlan(c.id, { kind: "shared_m", placement: "pool", spec: { vcpu: 4, ramGb: 8, diskGb: 80 }, botComputers: 5 });
  // waits for the owner's "restart now" (or the next idle sleep); here the owner asks
  f.advance(5 * 60_000); c.nextAttemptAt = 0; await f.service.reconcile();
  expect(machine.vcpus).toBe(2);
  f.service.managed!.resizeNow(c);
  for (let n = 0; n < 20 && !(c.status === "running" && !f.service.managed!.resizing(c)); n++) { c.nextAttemptAt = 0; await f.service.reconcile(); }
  expect(c).toMatchObject({ status: "running", spec: { vcpu: 4, ramGb: 8, diskGb: 20 } });
  expect(c.serverId).toBe(machine.id);
  expect([machine.vcpus, machine.memMiB]).toEqual([4, 8192]);
  expect(machine.volume.get(`data/${CLOUD_HOME.dataName}/kept.json`)!.toString()).toBe("kept");
  expect(f.audit.entries(c.id).map(e => e.action)).toContain("resize");
  expect(f.service.managed!.resizing(c)).toBe(false);
});

it("a replaced machine that answers again is saved as a snapshot, then its machine and disk are deleted", async () => {
  const f = await homeFixture();
  const { c } = await f.paid();
  f.advance(DAY_MS); f.power.idle = true; f.power.busy = [];
  await f.settle(c, c => c.status === "sleeping", 60, 5 * 60_000);
  await f.service.power(c.accountId, c.id, "on"); await f.settle(c, c => c.status === "running");
  const original = c.serverId!;
  // the provider stops answering for this one machine long enough, and leaves it off the list: it is taken for lost
  const machine = f.provider.machine, listed = f.provider.listed;
  f.provider.machine = async id => id === original ? null : machine(id);
  f.provider.listed = async id => id === original ? false : listed(id);
  for (let n = 0; n < 40 && !(c.status === "running" && c.serverId !== original); n++) { f.advance(11 * 60_000); c.nextAttemptAt = 0; await f.service.reconcile(); }
  expect(c.serverId).not.toBe(original);
  expect(c.managed!.retired.map(r => r.serverId)).toContain(original);
  // it answers again, still running: saved whole, then deleted; its snapshot stays for the operator
  f.provider.machine = machine; f.provider.listed = listed;
  for (let n = 0; n < 6; n++) { f.advance(11 * 60_000); c.nextAttemptAt = 0; await f.service.reconcile(); }
  for (let day = 0; day < 20; day++) { f.advance(DAY_MS); c.nextAttemptAt = 0; await f.service.reconcile(); }
  const retired = c.managed!.retired.find(r => r.serverId === original)!;
  expect(f.audit.entries(c.id).map(e => e.action)).toContain("retired_deleted");
  expect(f.api.snapshots.get(retired.snapshotId!)!.volume.get(`data/${CLOUD_HOME.dataName}/bots.json`)!.toString()).toContain("Test bot");
  expect(f.api.machines.has(original)).toBe(false);
  expect(f.api.deletes()).toHaveLength(0);
  // a backup still opens with this service's key only
  expect(f.backups.read(c.id, homeBackupKey(BACKUP_SECRET, c.id), c.managed!.backups.at(-1)!.file).includes("Test bot")).toBe(true);
});

it("charges every start to the home's monthly book, and keeps a home up once the provider caused the reserve's worth of starts", async () => {
  const f = await homeFixture({ costProfile: pooledCostProfile() });
  const { c } = await f.paid();
  const lines = () => readFileSync(join(f.dataDir, "spend", "2026-11.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l) as { c: string; e: string; cents?: number; kind?: string });
  // the create: charged at the worst price before the provider was asked, settled to the included price the pool proves
  expect(lines().filter(l => l.c === c.id).map(l => `${l.e}${l.cents === undefined ? "" : `:${l.cents}`}`).slice(0, 3)).toEqual(["open", "start:7", "settle:7"]);
  // the provider stops the machine five times behind our back: each restart is a start nobody chose
  for (let n = 0; n < 5; n++) {
    f.api.machines.get(c.serverId!)!.state = "stopped";
    f.api.machines.get(c.serverId!)!.ready = false;
    await f.settle(c, c => c.status === "running" && f.api.machines.get(c.serverId!)!.state === "running", 20, 30_000);
  }
  expect(lines().filter(l => l.c === c.id && l.e === "start").length).toBe(6);
  f.advance(5 * 60_000); f.power.idle = true; f.power.busy = [];
  for (let n = 0; n < 20; n++) { c.nextAttemptAt = 0; await f.service.reconcile(); f.advance(5 * 60_000); }
  expect(c.status).toBe("running");
  expect(c.managed!.stayReason).toBe("cost_reserve_used");
  expect(f.audit.entries(c.id).filter(e => e.action === "cost_ceiling_alert").map(e => e.reason)).toEqual(["reserve"]);
});

it("free starts keep no reserve: a home the provider restarted five times still sleeps once idle", async () => {
  const f = await homeFixture();
  const { c } = await f.paid();
  for (let n = 0; n < 5; n++) {
    f.api.machines.get(c.serverId!)!.state = "stopped";
    f.api.machines.get(c.serverId!)!.ready = false;
    await f.settle(c, c => c.status === "running" && f.api.machines.get(c.serverId!)!.state === "running", 20, 30_000);
  }
  f.advance(5 * 60_000); f.power.idle = true; f.power.busy = [];
  for (let n = 0; n < 20 && c.status === "running"; n++) { c.nextAttemptAt = 0; await f.service.reconcile(); f.advance(5 * 60_000); }
  expect(c.status).toBe("sleeping");
  expect(c.managed!.stayReason).not.toBe("cost_reserve_used");
  expect(f.audit.entries(c.id).filter(e => e.action === "cost_ceiling_alert")).toHaveLength(0);
});

it("the operator deletes an ended plan's cloud at once, never a paid one, and keeps its archive and backups for the retention days", async () => {
  const f = await homeFixture();
  const { c, sub } = await f.paid();
  expect(() => f.service.managed!.operatorDelete(c, "test_account")).toThrow("billing_active");
  sub.status = "ended"; sub.currentPeriodEnd = f.now(); sub.lastEventAt = f.now();
  await f.settle(c, c => c.status === "stopped" && c.serverId === null && !!c.managed!.archive);
  const snapshot = c.managed!.archive!.snapshotId;
  f.service.managed!.operatorDelete(c, "test_account");
  await f.settle(c, c => c.status === "destroyed");
  expect(f.api.deletes()).toHaveLength(0);
  expect(f.api.snapshots.get(snapshot)?.status).toBe("ready");
  expect(c.managed!.backups.at(-1)?.verifiedAt ?? null).not.toBeNull();
  expect(() => f.service.managed!.operatorDelete(c, "test_account")).toThrow("unavailable");
});

it("a deleted account's home is deleted at once, paid period or not, and only once", async () => {
  const f = await homeFixture();
  const { c } = await f.paid();
  expect(f.service.destroyForDeletedAccount(c.id)).toBe(true);
  expect(c.ended).toBe(true);
  await f.settle(c, c => c.status === "destroyed");
  expect(f.api.deletes()).toHaveLength(1);
  expect(f.audit.entries(c.id).some(e => e.action === "delete_confirmed" && e.reason === "account_deleted")).toBe(true);
  expect(f.service.destroyForDeletedAccount(c.id)).toBe(false);
});

it("a machine whose create was still in flight when the account was deleted is found and deleted within minutes", async () => {
  const f = await homeFixture();
  const { c } = await f.paid();
  const late = await f.provider.create({ cloudId: c.id, spec: plan.spec, region: "eu", userData: "", ttlSeconds: 3600, attempt: 9 });
  f.service.destroyForDeletedAccount(c.id);
  await f.settle(c, c => c.status === "destroyed");
  for (let n = 0; n < 4 && f.api.machines.has(late.id); n++) { f.advance(61_000); c.nextAttemptAt = 0; await f.service.reconcile(); }
  expect(f.api.deletes().length).toBeGreaterThanOrEqual(2);
  expect(f.audit.entries().some(e => e.action === "delete_requested" && e.reason === "orphan_of_deleted_cloud" && e.serverId === late.id)).toBe(true);
});

it("tells a busy home's open apps it is going to sleep on the owner's pause, then stops it after the grace", async () => {
  const f = await homeFixture();
  const { c } = await f.paid();
  f.power.idle = false; f.power.busy = ["turn"];
  await f.service.power(c.accountId, c.id, "off");
  const asked = f.home.sleep.mock.calls.at(-1)! as unknown as [string, string, number, { force?: boolean }];
  expect(asked[0]).toBe(c.origin);
  expect(asked[3]).toEqual({ force: true });
  expect(c.status).toBe("running");
  expect(f.api.machines.get(c.serverId!)!.state).toBe("running");
  c.nextAttemptAt = 0; await f.service.reconcile();
  expect(c.status).toBe("running");
  expect(f.home.sleep).toHaveBeenCalledTimes(1);
  f.advance(OWNER_SLEEP_GRACE_MS); c.nextAttemptAt = 0; await f.service.reconcile();
  expect(c.status).toBe("sleeping");
  expect(f.api.machines.get(c.serverId!)!.state).not.toBe("running");
  expect(f.audit.entries(c.id).map(e => e.action)).toEqual(expect.arrayContaining(["sleep_notice", "sleep"]));
  // a later pause notices again
  await f.service.power(c.accountId, c.id, "on"); await f.settle(c, c => c.status === "running");
  await f.service.power(c.accountId, c.id, "off");
  expect(f.home.sleep).toHaveBeenCalledTimes(2);
});

it("keeps an awake home up while its owner has the dashboard on it, capped like an open app, and counts several minutes of use", async () => {
  const f = await homeFixture();
  const { c } = await f.paid();
  f.power.idle = true; f.power.busy = [];
  // the dashboard's pulse every minute: the home stays up past the base idle
  for (let n = 0; n < 20; n++) { f.service.managed!.noteView!(c); f.advance(60_000); c.nextAttemptAt = 0; await f.service.reconcile(); }
  expect(c.status).toBe("running");
  expect(c.managed!.stayReason).toBe("focused");
  // still on screen, but no input for half an hour: the hint runs out
  for (let n = 0; n < 30 && c.status === "running"; n++) { f.service.managed!.noteView!(c); f.advance(60_000); c.nextAttemptAt = 0; await f.service.reconcile(); }
  expect(c.status).toBe("sleeping");
});

it("waits half an hour after the last input once the owner has used the home in several separate minutes", async () => {
  const f = await homeFixture();
  const { c } = await f.paid();
  f.power.idle = false; f.power.busy = ["recent-activity"];
  for (let n = 0; n < 4; n++) { f.advance(3 * 60_000); f.power.lastActivityAt = f.now(); c.nextAttemptAt = 0; await f.service.reconcile(); }
  const last = f.now();
  f.power.idle = true; f.power.busy = [];
  for (let n = 0; n < 40 && c.status === "running"; n++) { f.advance(60_000); c.nextAttemptAt = 0; await f.service.reconcile(); }
  expect(c.status).toBe("sleeping");
  const slept = f.audit.entries(c.id).filter(e => e.action === "sleep").at(-1)!;
  expect(slept.at - last).toBeGreaterThanOrEqual(30 * 60_000);
});

it("alerts the operator once when a home's hold is stuck, and once a day about clouds awake over half a day without work", async () => {
  const f = await homeFixture();
  const { c } = await f.paid();
  f.power.idle = false; f.power.busy = ["computer"];
  (f.power as { stuck?: string[] }).stuck = ["computer"];
  for (let n = 0; n < 3; n++) { f.advance(60_000); c.nextAttemptAt = 0; await f.service.reconcile(); }
  expect(f.audit.entries(c.id).filter(e => e.action === "hold_stuck")).toHaveLength(1);
  // a whole day up with nothing to explain it (a hold no work, routine or use accounts for): one alert after midnight
  (f.power as { stuck?: string[] }).stuck = undefined; f.power.busy = ["team"];
  const midnight = Math.ceil((f.now() + 1) / 86_400_000) * 86_400_000;
  while (f.now() < midnight + 5 * 60_000) { f.advance(5 * 60_000); c.nextAttemptAt = 0; await f.service.reconcile(); }
  const day = 86_400_000;
  while (f.now() < midnight + day + 5 * 60_000) { f.advance(5 * 60_000); c.nextAttemptAt = 0; await f.service.reconcile(); }
  expect(f.audit.entries(c.id).filter(e => e.action === "awake_without_work")).toHaveLength(1);
}, 120_000);

it("a routine due while asleep: the cloud wakes before it, stays up while the run works, then sleeps again", async () => {
  const f = await homeFixture();
  const { c } = await f.paid();
  f.power.idle = true; f.power.busy = [];
  const due = f.now() + 2 * 60 * 60_000; f.power.nextDueAt = due;
  await f.settle(c, c => c.status === "sleeping", 60, 5 * 60_000);
  expect(c.managed!.nextDueAt).toBe(due);
  // the wake comes before the run is due, never after
  for (let n = 0; n < 400 && c.status === "sleeping"; n++) { f.advance(30_000); c.nextAttemptAt = 0; await f.service.reconcile(); }
  expect(c.status).not.toBe("sleeping");
  expect(f.now()).toBeLessThanOrEqual(due);
  await f.settle(c, c => c.status === "running", 20, 5_000);
  expect(f.audit.entries(c.id).filter(e => e.action === "wake").at(-1)!.reason).toBe("routine_due");
  // the run works for 20 minutes: never put to sleep under it
  f.power.idle = false; f.power.busy = ["run"]; f.power.nextDueAt = due + 15 * 60_000;
  for (let n = 0; n < 40; n++) { f.advance(30_000); c.nextAttemptAt = 0; await f.service.reconcile(); }
  expect(c.status).toBe("running");
  // done, and the next run a few hours out: asleep again soon after
  f.power.idle = true; f.power.busy = []; f.power.nextDueAt = f.now() + 3 * 60 * 60_000;
  const done = f.now();
  await f.settle(c, c => c.status === "sleeping", 60, 60_000);
  expect(f.now() - done).toBeLessThan(15 * 60_000);
});

it("never flags a Team Cloud's day: its home refuses every sleep by design", async () => {
  const f = await homeFixture();
  const { c } = await f.paid();
  c.team = { id: "team_1", name: "Team" };
  f.power.idle = false; f.power.busy = ["team"];
  const midnight = Math.ceil((f.now() + 1) / 86_400_000) * 86_400_000, day = 86_400_000;
  while (f.now() < midnight + day + 5 * 60_000) { f.advance(5 * 60_000); c.nextAttemptAt = 0; await f.service.reconcile(); }
  expect(c.status).toBe("running");
  expect(f.audit.entries(c.id).filter(e => e.action === "awake_without_work")).toHaveLength(0);
}, 120_000);

it("never flags a day the person's own routines and checks kept the cloud up", async () => {
  const f = await homeFixture();
  const { c } = await f.paid();
  // a check due every few minutes all day: the home reports it due soon, so the cloud stays up for it
  f.power.idle = false; f.power.busy = ["due-soon"];
  const midnight = Math.ceil((f.now() + 1) / 86_400_000) * 86_400_000, day = 86_400_000;
  while (f.now() < midnight + day + 5 * 60_000) { f.advance(5 * 60_000); c.nextAttemptAt = 0; await f.service.reconcile(); }
  expect(c.status).toBe("running");
  expect(f.audit.entries(c.id).filter(e => e.action === "awake_without_work")).toHaveLength(0);
}, 120_000);

it("treats App Review's demo cloud as always paid for, so no plan end, retention, archive or delete verdict reaches it", () => {
  const now = 1_800_000_000_000;
  const ended = [{ id: "s1", cloudId: "c1", status: "ended", cancelAtPeriodEnd: true, currentPeriodEnd: now - 90 * DAY_MS } as StoredSubscription];
  const cloud = { id: "c1", subscriptionId: "s1", ended: true, endedAt: now - 90 * DAY_MS };
  expect(entitlementOf(ended, cloud, now)).toMatchObject({ active: false });
  const review = entitlementOf(ended, { ...cloud, review: true }, now);
  expect(review).toEqual({ active: true, until: null, known: true });
  expect(entitlementOf([], { id: "c2", subscriptionId: null, review: true }, now).active).toBe(true);
  const verdict = deletionVerdict({ now, retentionDays: 30, entitlement: review, finalBackup: { at: now - 80 * DAY_MS, verifiedAt: now - 80 * DAY_MS }, lastStopAt: now - 85 * DAY_MS,
    ownerRequest: { requestedAt: now - 20 * DAY_MS, confirmedAt: now - 20 * DAY_MS, executeAfter: now - DAY_MS, cancelledAt: null }, hold: false });
  expect(verdict).toMatchObject({ delete: false, reason: "subscribed" });
});

it("asks the provider once per wake while the machine still reads as stopped right after the start was accepted", async () => {
  const f = await homeFixture();
  const { c } = await f.paid();
  f.advance(5 * 60_000); f.power.idle = true; f.power.busy = [];
  await f.settle(c, c => c.status === "sleeping", 60, 5 * 60_000);
  const starts = () => f.api.requests.filter(r => r.method === "POST" && /\/(start|resume)$/.test(r.path)).length;
  const before = starts(), wakes = () => f.audit.entries(c.id).filter(e => e.action === "wake").length, wakesBefore = wakes();
  f.api.queueStarts();
  await f.service.power(c.accountId, c.id, "on");
  for (let pass = 0; pass < 5; pass++) { f.advance(1_000); c.nextAttemptAt = 0; await f.service.reconcile(); }
  expect(starts() - before).toBe(1);
  expect(wakes() - wakesBefore).toBe(1);
  // a start the provider never carried out is asked again, once, after the settle time
  f.advance(2 * 60_000); c.nextAttemptAt = 0; await f.service.reconcile();
  expect(starts() - before).toBe(2);
  f.api.queueStarts(false); f.api.finishStarts();
  await f.settle(c, c => c.status === "running");
});
