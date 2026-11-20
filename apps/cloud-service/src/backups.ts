// Backups of each home's volume, kept off the provider in storage only this service writes: a home never holds a credential
// that reaches it. Each generation is one file, written once (O_EXCL) and never changed: AES-256-GCM over the volume's tar,
// keyed per cloud from a secret only this service holds (homeBackupKey): nothing on the home can open one. Only the
// retention reconciler removes one (lifecycle.ts).
import { CLOUD_HOME } from "../../../electron/legacy-names.mjs";
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fstatSync, linkSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, writeSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

const MAGIC = Buffer.from("OMBB2\n");

/** a cloud's backup key: HKDF over this service's backup secret, bound to the cloud id */
export function homeBackupKey(secret: Buffer, cloudId: string): Buffer {
  if (secret.length < 32) throw new Error("Invalid backup secret.");
  return Buffer.from(hkdfSync("sha256", secret, Buffer.from(cloudId), Buffer.from("omb-home-backup-v2"), 32));
}
const IV_BYTES = 12, TAG_BYTES = 16;
const CLOUD_ID = /^c[0-9a-f]{24}$/;
const FILE = /^(\d{13})-([a-f0-9]{8})\.ombb$/;
export const MARKER_FILE = ".omb-cloud-home.json";

export interface BackupRecord { file: string; at: number; bytes: number; sha256: string; verifiedAt: number | null }

/** the names and sizes of a tar's entries (ustar, GNU long names and pax paths), enough to tell a home's volume from anything else */
export function tarEntries(tar: Buffer): Array<{ name: string; size: number; type: string; data: Buffer }> {
  const entries: Array<{ name: string; size: number; type: string; data: Buffer }> = [];
  let offset = 0, longName: string | null = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start: number, length: number) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const sum = parseInt(field(148, 8).trim() || "0", 8);
    let check = 0;
    for (let i = 0; i < 512; i++) check += i >= 148 && i < 156 ? 32 : header[i]!;
    if (sum !== check) throw new Error("Invalid tar header.");
    const size = parseInt(field(124, 12).trim() || "0", 8), type = field(156, 1) || "0";
    const prefix = field(345, 155), data = tar.subarray(offset + 512, offset + 512 + size);
    if (data.length !== size) throw new Error("Truncated tar.");
    let name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = null;
    if (type === "L") longName = data.toString("utf8").replace(/\0.*$/s, "");
    else if (type === "x") { const path = /\d+ path=([^\n]*)\n/.exec(data.toString("utf8")); if (path) longName = path[1]!; }
    else entries.push({ name: name.replace(/^\.\//, ""), size, type, data });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/** a ustar archive of plain files (tests and the fake provider) */
export function makeTar(files: Array<{ name: string; data: Buffer | string; mode?: number }>): Buffer {
  const parts: Buffer[] = [];
  for (const file of files) {
    const data = Buffer.from(file.data), header = Buffer.alloc(512);
    header.write(file.name, 0, 100, "utf8");
    header.write(`${(file.mode ?? 0o600).toString(8).padStart(7, "0")}\0`, 100);
    header.write("0000000\0", 108); header.write("0000000\0", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")}\0`, 136);
    header.write("        ", 148); header.write("0", 156); header.write("ustar\0", 257); header.write("00", 263);
    let sum = 0; for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    parts.push(header, data, Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** whether a tar is this cloud's home volume: its marker names the cloud */
export function homeVolumeProblem(tar: Buffer, cloudId: string): string | null {
  const scan = homeVolumeScan(cloudId);
  scan.push(tar);
  return scan.end();
}

/** the most of an entry's data a scan keeps: a marker, a long name or a pax header, never file contents */
const KEEP_BYTES = 64 * 1024;

/** homeVolumeProblem over a tar that arrives in pieces: the same rules as tarEntries, holding one header and at most
 *  KEEP_BYTES of an entry at a time, so a volume of any size is checked in a few kilobytes */
export function homeVolumeScan(cloudId: string, onEntry?: (name: string, size: number) => void) {
  const header = Buffer.alloc(512);
  let have = 0, left = 0, pad = 0, done = false, broken = false, longName: string | null = null;
  let entry: { name: string; type: string; keep: Buffer[] | null; kept: number; marker: boolean } | null = null;
  let marker: Buffer | null | "too_large" = null, data = false;
  function finish() {
    const e = entry!; entry = null;
    const body = e.keep ? Buffer.concat(e.keep) : null;
    if (e.type === "L") longName = body!.toString("utf8").replace(/\0.*$/s, "");
    else if (e.type === "x") { const path = /\d+ path=([^\n]*)\n/.exec(body!.toString("utf8")); if (path) longName = path[1]!; }
    else if (e.marker && marker === null) marker = e.kept > KEEP_BYTES ? "too_large" : body!;
  }
  function begin(block: Buffer) {
    if (block.every(byte => byte === 0)) { done = true; return; }
    const field = (start: number, length: number) => block.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const sum = parseInt(field(148, 8).trim() || "0", 8);
    let check = 0;
    for (let i = 0; i < 512; i++) check += i >= 148 && i < 156 ? 32 : block[i]!;
    if (sum !== check) { broken = true; return; }
    const size = parseInt(field(124, 12).trim() || "0", 8), type = field(156, 1) || "0", prefix = field(345, 155);
    let name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = null;
    name = name.replace(/^\.\//, "");
    const parts = name.split("/"), isMarker = type !== "L" && type !== "x" && parts.at(-1) === MARKER_FILE && parts.length <= 3;
    // a cloud home's data folder keeps its name from before the rename (CLOUD_HOME), so its backups do too
    if (type !== "L" && type !== "x" && parts.slice(0, -1).includes(CLOUD_HOME.dataName)) data = true;
    if (type !== "L" && type !== "x") onEntry?.(name, size);
    entry = { name, type, keep: type === "L" || type === "x" || isMarker ? [] : null, kept: 0, marker: isMarker };
    left = size; pad = Math.ceil(size / 512) * 512 - size;
    if (left === 0) finish();
  }
  return {
    push(chunk: Uint8Array) {
      let at = 0;
      while (at < chunk.length && !done && !broken) {
        if (left > 0) {
          const n = Math.min(left, chunk.length - at), e = entry!;
          if (e.keep && e.kept + n <= KEEP_BYTES) e.keep.push(Buffer.from(chunk.subarray(at, at + n)));
          else if (e.keep) e.keep = e.type === "L" || e.type === "x" ? (broken = true, null) : [];
          e.kept += n; left -= n; at += n;
          if (left === 0) finish();
        } else if (pad > 0) {
          const n = Math.min(pad, chunk.length - at); pad -= n; at += n;
        } else {
          const n = Math.min(512 - have, chunk.length - at);
          header.set(chunk.subarray(at, at + n), have); have += n; at += n;
          if (have === 512) { have = 0; begin(header); }
        }
      }
    },
    /** the verdict once every piece is in: null for this cloud's volume */
    end(): string | null {
      if (broken || left > 0) return "unreadable";
      if (marker === null) return "no_marker";
      if (marker === "too_large") return "bad_marker";
      try { if ((JSON.parse((marker as Buffer).toString("utf8")) as { machine?: unknown }).machine !== cloudId) return "other_cloud"; } catch { return "bad_marker"; }
      return data ? null : "no_data";
    },
  };
}

const CHUNK = 1 << 20;

export function createBackupStore(options: { dir: string; now?: () => number }) {
  const now = options.now ?? Date.now;
  mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  const dirOf = (cloudId: string) => { if (!CLOUD_ID.test(cloudId)) throw new Error("Invalid cloud id."); return join(options.dir, cloudId); };
  function pathOf(cloudId: string, file: string) { if (!FILE.test(file)) throw new Error("Invalid backup name."); return join(dirOf(cloudId), file); }
  // a generation half written when the service stopped is never finished: only this service writes here
  for (const cloud of readdirSync(options.dir)) {
    if (!CLOUD_ID.test(cloud) || !statSync(join(options.dir, cloud)).isDirectory()) continue;
    for (const name of readdirSync(join(options.dir, cloud))) if (name.endsWith(".part")) rmSync(join(options.dir, cloud, name), { force: true });
  }
  return {
    /** seals one generation as it arrives, a piece at a time (the volume is never held whole); `inspect` sees each plain
     *  piece first and may throw to stop. written beside its name and linked into place once whole, so a generation
     *  either exists complete or not at all, and never overwrites */
    async writeStream(cloudId: string, key: Buffer, source: AsyncIterable<Uint8Array>, inspect: (chunk: Uint8Array) => void = () => {}): Promise<BackupRecord & { plainBytes: number }> {
      const dir = dirOf(cloudId), at = now();
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = `${String(at).padStart(13, "0")}-${randomBytes(4).toString("hex")}.ombb`, path = join(dir, file), part = join(dir, `.${file}.part`);
      const iv = randomBytes(IV_BYTES), cipher = createCipheriv("aes-256-gcm", key, iv), hash = createHash("sha256");
      cipher.setAAD(Buffer.from(cloudId));
      const fh = await open(part, "wx", 0o600);
      let bytes = 0, plainBytes = 0;
      const put = async (piece: Buffer) => { if (!piece.length) return; hash.update(piece); bytes += piece.length; for (let off = 0; off < piece.length;) off += (await fh.write(piece, off, piece.length - off)).bytesWritten; };
      try {
        await put(Buffer.concat([MAGIC, iv]));
        for await (const chunk of source) { inspect(chunk); plainBytes += chunk.length; await put(cipher.update(chunk)); }
        await put(cipher.final()); await put(cipher.getAuthTag());
        await fh.sync(); await fh.close();
        chmodSync(part, 0o400); linkSync(part, path);
      } finally {
        await fh.close().catch(() => {});
        rmSync(part, { force: true });
      }
      return { file, at, bytes, sha256: hash.digest("hex"), verifiedAt: null, plainBytes };
    },
    /** opens one generation a piece at a time and checks it end to end: authenticated, bound to its cloud, this cloud's
     *  volume (homeVolumeScan), and the sha256 of the file as stored. memory stays at one read buffer */
    async check(cloudId: string, key: Buffer, file: string): Promise<{ problem: string | null; sha256: string | null }> {
      const path = pathOf(cloudId, file);
      let fh;
      try { fh = await open(path, "r"); } catch { return { problem: "unreadable", sha256: null }; }
      try {
        const size = (await fh.stat()).size, hash = createHash("sha256"), buf = Buffer.alloc(CHUNK);
        if (size < MAGIC.length + IV_BYTES + TAG_BYTES) return { problem: "unreadable", sha256: null };
        const head = Buffer.alloc(MAGIC.length + IV_BYTES), tag = Buffer.alloc(TAG_BYTES);
        await fh.read(head, 0, head.length, 0); await fh.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
        if (!head.subarray(0, MAGIC.length).equals(MAGIC)) return { problem: "unreadable", sha256: null };
        const decipher = createDecipheriv("aes-256-gcm", key, head.subarray(MAGIC.length));
        decipher.setAAD(Buffer.from(cloudId)); decipher.setAuthTag(tag);
        const scan = homeVolumeScan(cloudId), bodyEnd = size - TAG_BYTES;
        hash.update(head);
        for (let pos = head.length; pos < bodyEnd;) {
          const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, bodyEnd - pos), pos);
          if (bytesRead === 0) return { problem: "unreadable", sha256: null };
          const sealed = buf.subarray(0, bytesRead);
          hash.update(sealed); scan.push(decipher.update(sealed)); pos += bytesRead;
        }
        hash.update(tag);
        try { scan.push(decipher.final()); } catch { return { problem: "unreadable", sha256: hash.digest("hex") }; }
        return { problem: scan.end(), sha256: hash.digest("hex") };
      } finally { await fh.close(); }
    },
    /** seals one generation; never overwrites */
    write(cloudId: string, key: Buffer, tar: Buffer): BackupRecord {
      const dir = dirOf(cloudId), at = now();
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = `${String(at).padStart(13, "0")}-${randomBytes(4).toString("hex")}.ombb`, path = join(dir, file);
      const iv = randomBytes(IV_BYTES), cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(cloudId));
      const body = Buffer.concat([cipher.update(tar), cipher.final()]), sealed = Buffer.concat([MAGIC, iv, body, cipher.getAuthTag()]);
      const fd = openSync(path, "wx", 0o600);
      try { writeSync(fd, sealed); } finally { closeSync(fd); }
      chmodSync(path, 0o400);
      return { file, at, bytes: sealed.length, sha256: createHash("sha256").update(sealed).digest("hex"), verifiedAt: null };
    },
    /** opens one generation: authenticated, and bound to its cloud */
    read(cloudId: string, key: Buffer, file: string): Buffer {
      const path = pathOf(cloudId, file), fd = openSync(path, "r");
      let sealed: Buffer;
      try { const size = fstatSync(fd).size; sealed = Buffer.alloc(size); let read = 0; while (read < size) read += readSync(fd, sealed, read, size - read, read); } finally { closeSync(fd); }
      if (sealed.length < MAGIC.length + IV_BYTES + TAG_BYTES || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Invalid backup.");
      const iv = sealed.subarray(MAGIC.length, MAGIC.length + IV_BYTES), tag = sealed.subarray(sealed.length - TAG_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(Buffer.from(cloudId)); decipher.setAuthTag(tag);
      try { return Buffer.concat([decipher.update(sealed.subarray(MAGIC.length + IV_BYTES, sealed.length - TAG_BYTES)), decipher.final()]); }
      catch { throw new Error("Backup failed its integrity check."); }
    },
    sha256(cloudId: string, file: string): string | null {
      const path = pathOf(cloudId, file);
      if (!existsSync(path)) return null;
      const fd = openSync(path, "r"), hash = createHash("sha256"), chunk = Buffer.alloc(1 << 20);
      try { for (let n; (n = readSync(fd, chunk, 0, chunk.length, null)) > 0;) hash.update(chunk.subarray(0, n)); } finally { closeSync(fd); }
      return hash.digest("hex");
    },
    list(cloudId: string): string[] { const dir = dirOf(cloudId); return existsSync(dir) ? readdirSync(dir).filter(f => FILE.test(f)).sort() : []; },
    clouds(): string[] { return readdirSync(options.dir).filter(name => CLOUD_ID.test(name) && statSync(join(options.dir, name)).isDirectory()); },
    /** called only by the retention reconciler after its gate */
    remove(cloudId: string, file: string) { rmSync(pathOf(cloudId, file), { force: true }); },
  };
}
export type BackupStore = ReturnType<typeof createBackupStore>;
