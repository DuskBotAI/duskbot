import { CLOUD_HOME } from "../../../electron/legacy-names.mjs";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StoredSubscription } from "../../dashboard/server/billing/store.ts";
import { createBackupStore, homeBackupKey, makeTar, MARKER_FILE, skippedPath, tarEntries, tarWithout } from "./backups.ts";
import { STREAM_SKIPPED } from "./home.ts";
import { DAY_MS, prunableBackups } from "./retention.ts";
import { homeFixture } from "./test-fixture.ts";

const ID = `c${"a".repeat(24)}`, KEY = homeBackupKey(Buffer.alloc(32, 7), ID), D = CLOUD_HOME.dataName;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const store = () => { const dir = mkdtempSync(join(tmpdir(), "dusk-backups-")); dirs.push(dir); return { dir, backups: createBackupStore({ dir }) }; };
async function* pieces(buf: Buffer, size: number) { for (let at = 0; at < buf.length; at += size) yield buf.subarray(at, at + size); }
async function collect(source: AsyncIterable<Uint8Array>) { const out: Buffer[] = []; for await (const p of source) out.push(Buffer.from(p)); return Buffer.concat(out); }

/** a GNU tar entry of `type` (a long name "L", a hard link "1") as makeTar writes a plain one */
function typed(name: string, data: string, type: string, link = "") {
  const block = makeTar([{ name, data }]).subarray(0, -1024);
  const h = block.subarray(0, 512);
  h.write(type, 156); if (link) h.write(link, 157, 100); h.write("        ", 148);
  let sum = 0; for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return Buffer.from(block);
}
const longEntry = (name: string, data: string) => Buffer.concat([typed("././@LongLink", `${name}\0`, "L"), makeTar([{ name: name.slice(0, 99), data }]).subarray(0, -1024)]);

describe("what this service leaves out of a home's tar", () => {
  const skip = skippedPath(STREAM_SKIPPED);

  it("names regenerable downloads and caches, never a person's data or logins", () => {
    for (const p of ["data/.npm/_cacache/x", "data/.agent-browser/browsers/chrome-157/chrome", `data/${D}/tools/chrome/131/linux64/chrome`, "data/.cache/duskbot/voice/m.bin",
      `data/${D}/agent-browser-profiles/p1/Default/Cache/Cache_Data/f`, `data/${D}/cache/x`, "./data/.cache/pip/x", "data/.npm"]) expect(skip(p), p).toBe(true);
    for (const p of ["data/.npmrc", "data/.agent-browser/sessions/s.json", `data/${D}/tools/npm/bin/claude`, `data/${D}/tools/agent-browser/bin`, `data/${D}/bots/b/SOUL.md`,
      `data/${D}/agent-browser-profiles/p1/Default/Cookies`, `data/${D}/messages.db`, `data/${D}/workspaces/w/notes.md`, "data/.claude/.credentials.json",
      "data/.local/share/pnpm/store/v3/x", "data/.cache/ms-playwright/x"]) expect(skip(p), p).toBe(false);
  });

  it("drops skipped entries, their long names and hard links into them, and keeps the rest byte for byte in pieces of any size", async () => {
    const longKept = `data/${D}/workspaces/${"w".repeat(120)}/notes.md`, longDropped = `data/.agent-browser/browsers/${"v".repeat(120)}/chrome`;
    const kept = [{ name: `data/${MARKER_FILE}`, data: JSON.stringify({ machine: ID }) }, { name: `data/${D}/bots.json`, data: "[]" }];
    const tar = Buffer.concat([
      makeTar(kept).subarray(0, -1024),
      makeTar([{ name: "data/.npm/_cacache/big", data: "z".repeat(5000) }]).subarray(0, -1024),
      longEntry(longKept, "keep me"),
      longEntry(longDropped, "y".repeat(3000)),
      typed(`data/${D}/workspaces/w/link`, "", "1", "data/.npm/_cacache/big"),
      typed(`data/${D}/workspaces/w/same`, "", "1", `data/${D}/bots.json`),
      makeTar([{ name: `data/${D}/agent-browser-profiles/p/Default/Cookies`, data: "c" }]),
    ]);
    const expected = tarEntries(tar).filter(e => !e.name.startsWith("data/.npm") && !e.name.startsWith("data/.agent-browser") && !e.name.endsWith("/link")).map(e => [e.name, e.size, e.type, e.data.toString()]);
    for (const size of [1, 100, 511, 512, 513, 4096, tar.length]) {
      const { stream, stats } = tarWithout(pieces(tar, size), skip), out = await collect(stream);
      expect(tarEntries(out).map(e => [e.name, e.size, e.type, e.data.toString()])).toEqual(expected);
      expect(stats.skippedEntries).toBe(3);
      expect(stats.skippedBytes).toBeGreaterThan(8000);
    }
  });

  it("passes a stream it cannot read through whole", async () => {
    const junk = Buffer.from("not a tar at all, just some bytes".repeat(40));
    expect((await collect(tarWithout(pieces(junk, 100), skip).stream)).equals(junk)).toBe(true);
  });
});

describe("compressed generations", () => {
  const tar = makeTar([{ name: `home/${MARKER_FILE}`, data: JSON.stringify({ machine: ID }) }, { name: `home/${D}/state.json`, data: "{}" }, { name: `home/${D}/log.txt`, data: "same line\n".repeat(200_000) }]);

  it("are gzipped before sealing, open whole and a piece at a time, and stay bound to their format", async () => {
    const { dir, backups } = store();
    const record = await backups.writeStream(ID, KEY, pieces(tar, 65_536));
    const sealed = readFileSync(join(dir, ID, record.file));
    expect(sealed.subarray(0, 6).toString()).toBe("OMBB3\n");
    expect(record.bytes).toBeLessThan(tar.length / 20);
    expect(record.plainBytes).toBe(tar.length);
    expect(backups.read(ID, KEY, record.file).equals(tar)).toBe(true);
    expect(await backups.check(ID, KEY, record.file)).toEqual({ problem: null, sha256: record.sha256 });
    // the header names the format inside the sealed data's authentication: relabelled as a plain tar, it no longer opens
    const relabelled = Buffer.from(sealed); relabelled.write("OMBB2\n", 0);
    const path = join(dir, ID, record.file); rmSync(path); writeFileSync(path, relabelled);
    expect((await backups.check(ID, KEY, record.file)).problem).toBe("unreadable");
    expect(() => backups.read(ID, KEY, record.file)).toThrow();
  });

  it("the sync write (a key rotation's reseal) is gzipped too", () => {
    const { backups } = store(), record = backups.write(ID, KEY, tar);
    expect(record.bytes).toBeLessThan(tar.length / 20);
    expect(backups.read(ID, KEY, record.file).equals(tar)).toBe(true);
  });

  it("an older plain generation still opens and checks", async () => {
    const { dir, backups } = store(), iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", KEY, iv);
    cipher.setAAD(Buffer.from(ID));
    const body = Buffer.concat([cipher.update(tar), cipher.final()]), file = "1700000000000-0badf00d.ombb";
    mkdirSync(join(dir, ID), { recursive: true });
    writeFileSync(join(dir, ID, file), Buffer.concat([Buffer.from("OMBB2\n"), iv, body, cipher.getAuthTag()]));
    expect(backups.read(ID, KEY, file).equals(tar)).toBe(true);
    expect((await backups.check(ID, KEY, file)).problem).toBeNull();
  });
});

it("an archived home keeps only its newest generation: its provider snapshot is the other copy", () => {
  const gen = (day: number) => ({ file: `${day}`, snapshotAt: day * DAY_MS, verifiedAt: day * DAY_MS });
  const kept = (gens: ReturnType<typeof gen>[], longHold: boolean) => gens.filter(g => !prunableBackups(gens, { keep: 1, longHold }).includes(g)).map(g => g.snapshotAt / DAY_MS);
  expect(kept([gen(0), gen(3), gen(6)], true)).toEqual([0, 6]);
  expect(kept([gen(0), gen(3), gen(6)], false)).toEqual([6]);
});

it("skips a backup rather than fill the disk, tells the operator once, and resumes when there is room", async () => {
  const f = await homeFixture();
  const { c } = await f.paid();
  f.disk.free = 5 * 1024 ** 3;
  const pass = async (ms: number) => { f.advance(ms); c.nextAttemptAt = 0; await f.service.reconcile(); };
  await pass(2 * DAY_MS + 60_000);
  for (let n = 0; n < 3; n++) await pass(6 * 3_600_000 + 60_000);
  expect(c.status).toBe("running");
  expect(c.managed!.backups).toEqual([]);
  expect(c.managed!.backupProblem).toBe("disk_low");
  expect(f.audit.entries(c.id).filter(e => e.action === "backup_skipped" && e.reason === "disk_low").length).toBeGreaterThan(1);
  expect(f.audit.entries().filter(e => e.action === "backup_disk_low")).toHaveLength(1);
  f.disk.free = 500 * 1024 ** 3;
  await pass(6 * 3_600_000 + 60_000);
  expect(c.managed!.backups).toHaveLength(1);
  expect(c.managed!.backupProblem).toBeNull();
  expect(f.audit.entries().filter(e => e.action === "backup_disk_ok")).toHaveLength(1);
  expect(f.audit.entries().filter(e => e.action === "backup_disk_low")).toHaveLength(1);
});

it("an unpaid trial's backups go with its cloud after its 7 days, not 30 days later", async () => {
  const f = await homeFixture();
  const { c, sub } = await f.paid();
  f.advance(DAY_MS); await f.asleep(c);
  expect(f.backups.list(c.id).length).toBeGreaterThan(0);
  Object.assign(sub, { status: "payment_problem", paymentProblem: { since: f.now(), fixBy: f.now() + 7 * DAY_MS, trial: true } } as Partial<StoredSubscription>);
  for (let day = 0; day < 10 && c.status !== "destroyed"; day++) { f.advance(DAY_MS); c.nextAttemptAt = 0; await f.service.reconcile(); await f.service.reconcile(); }
  expect(c.status).toBe("destroyed");
  c.nextAttemptAt = 0; await f.service.reconcile();
  expect(f.backups.list(c.id)).toEqual([]);
  expect(f.audit.entries(c.id).find(e => e.action === "backups_deleted")?.reason).toBe("trial_unpaid");
});
