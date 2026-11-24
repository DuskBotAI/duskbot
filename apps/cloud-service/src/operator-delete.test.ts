// an operator's deletion and an ended plan never lose a home's data at once: archived first, kept for the retention days
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { DAY_MS, TRIAL_DATA_DAYS } from "./retention.ts";
import { homeFixture } from "./test-fixture.ts";

const backupFiles = (f: Awaited<ReturnType<typeof homeFixture>>, cloudId: string) => { try { return readdirSync(join(f.dataDir, "managed-backups", cloudId)); } catch { return []; } };

it("saves a still-running home as a ready snapshot before the operator's delete reaches its machine", async () => {
  const f = await homeFixture();
  const { c, sub } = await f.paid();
  await f.service.managed!.backupNow!(c);
  sub.status = "ended"; sub.currentPeriodEnd = f.now(); sub.lastEventAt = f.now();
  const serverId = c.serverId!;
  f.api.slowSnapshots(2);
  f.service.managed!.operatorDelete(c, "test_account");
  await f.settle(c, c => c.status === "destroyed", 30);
  const save = f.api.requests.findIndex(r => r.method === "POST" && r.path === `/v1/machines/${serverId}/snapshots`);
  const machineDelete = f.api.requests.findIndex(r => r.method === "DELETE" && r.path === `/v1/machines/${serverId}`);
  expect(save).toBeGreaterThanOrEqual(0);
  expect(machineDelete).toBeGreaterThan(save);
  // the snapshot was read back as ready between the save and the delete
  expect(f.api.requests.slice(save, machineDelete).some(r => r.method === "GET" && r.path.startsWith("/v1/snapshots"))).toBe(true);
  const snapshot = c.managed!.archive!.snapshotId;
  expect(f.api.snapshots.get(snapshot)).toMatchObject({ status: "ready", source: serverId });
  expect(f.api.deletes()).toHaveLength(0);
  expect(f.audit.entries(c.id).map(e => e.action)).toEqual(expect.arrayContaining(["archived", "deleted"]));
});

it("keeps the machine when the snapshot cannot be saved, and deletes nothing", async () => {
  const f = await homeFixture();
  const { c, sub } = await f.paid();
  sub.status = "ended"; sub.currentPeriodEnd = f.now(); sub.lastEventAt = f.now();
  const serverId = c.serverId!;
  const archive = vi.spyOn(f.provider, "archive").mockRejectedValue(new Error("snapshot_failed"));
  f.service.managed!.operatorDelete(c, "test_account");
  for (let n = 0; n < 6; n++) { c.nextAttemptAt = 0; await f.service.reconcile(); }
  expect(archive).toHaveBeenCalled();
  expect(c.status).not.toBe("destroyed");
  expect(f.api.machines.has(serverId)).toBe(true);
  expect(f.api.requests.some(r => r.method === "DELETE")).toBe(false);
});

it("keeps backups and the archive after an operator's delete until the retention days pass, then drops them", async () => {
  const f = await homeFixture();
  const { c, sub } = await f.paid();
  await f.service.managed!.backupNow!(c);
  sub.status = "ended"; sub.currentPeriodEnd = f.now(); sub.lastEventAt = f.now();
  await f.settle(c, c => c.status === "stopped" && c.serverId === null && !!c.managed!.archive);
  const snapshot = c.managed!.archive!.snapshotId;
  f.service.managed!.operatorDelete(c, "test_account");
  await f.settle(c, c => c.status === "destroyed");
  const kept = c.managed!.backups.length;
  expect(kept).toBeGreaterThan(0);
  expect(c.managed!.backupsDeleteAfter).toBe(f.now() + 30 * DAY_MS);
  for (let day = 0; day < 29; day++) { f.advance(DAY_MS); c.nextAttemptAt = 0; await f.service.reconcile(); }
  expect(c.managed!.backups).toHaveLength(kept);
  expect(backupFiles(f, c.id).length).toBeGreaterThan(0);
  expect(f.api.snapshots.has(snapshot)).toBe(true);
  f.advance(2 * DAY_MS); c.nextAttemptAt = 0; await f.service.reconcile();
  expect(c.managed!.backups).toHaveLength(0);
  expect(f.api.snapshots.has(snapshot)).toBe(false);
});

it("keeps an unpaid trial's copies after an operator's delete for the trial's data days, not less", async () => {
  const f = await homeFixture();
  const { c, sub } = await f.paid();
  await f.service.managed!.backupNow!(c);
  Object.assign(sub, { status: "ended", currentPeriodEnd: f.now(), lastEventAt: f.now(), paymentProblem: { since: f.now(), fixBy: f.now() + TRIAL_DATA_DAYS * DAY_MS, sent: ["first"], trial: true } });
  await f.settle(c, c => c.status === "stopped" && c.serverId === null && !!c.managed!.archive);
  f.service.managed!.operatorDelete(c, "test_account");
  await f.settle(c, c => c.status === "destroyed");
  expect(c.managed!.backupsDeleteAfter).toBe(f.now() + TRIAL_DATA_DAYS * DAY_MS);
  // an unpaid plan's backups used to go on the next pass after a deletion
  c.nextAttemptAt = 0; await f.service.reconcile();
  expect(c.managed!.backups.length).toBeGreaterThan(0);
  expect(c.managed!.archive).not.toBeNull();
});

it("an ended plan whose period end on record is long past is still kept for the retention days from when its end was seen", async () => {
  const f = await homeFixture();
  const { c, sub } = await f.paid();
  await f.service.managed!.backupNow!(c);
  sub.status = "ended"; sub.currentPeriodEnd = f.now() - 60 * DAY_MS; sub.lastEventAt = f.now();
  await f.settle(c, c => c.status === "stopped" && c.serverId === null && !!c.managed!.archive);
  expect(c.managed!.archive).toBeTruthy();
  expect(f.api.deletes()).toHaveLength(0);
  for (let day = 0; day < 29; day++) { f.advance(DAY_MS); c.nextAttemptAt = 0; await f.service.reconcile(); }
  expect(c.status).toBe("stopped");
  expect(f.api.deletes()).toHaveLength(0);
  f.advance(2 * DAY_MS);
  await f.settle(c, c => c.status === "destroyed");
});
