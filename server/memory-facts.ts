// The structured side of memory. The text of every fact stays where the person can read and edit it (MEMORY.md, the
// topic files, the archive, About me); each line also has a row here with what code knows about it: where it came
// from, how far it is trusted, when it held, what replaced it, and its embedding for recall. Rows follow the files:
// a changed file is re-read and its rows reconciled, so an edit in the panel, in Obsidian or by a bot's file tools
// is never lost or contradicted here.
import { createHash, randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { parseGeneral, type HistoryEntry } from "./general-memory.ts";
import { factIdentity, isExpired, parseMemoryEntries } from "./memory-entries.ts";
import { blobVector, EMBED_MODEL, embedderReady, embedPassages, vectorBlob } from "./memory-embed.ts";
import { factDates } from "./memory-time.ts";
import { parseTopicHeader } from "./memory-topics.ts";
import { memoryStoreDb } from "./message-db.ts";
import { isArchiveTopic, isMemorySeed, listMemoryTopics, memoryDate, readMemoryText, workspaceDir } from "./workspace.ts";

export type FactStatus = "active" | "superseded" | "merged" | "expired" | "suppressed";
/** Where a fact came from. Only `typed` and `person-said` may describe the person in always-loaded memory. */
export type FactSource = "typed" | "person-said" | "bot-verified" | "other-person" | "tool" | "web" | "other-bot" | "import" | "legacy";
export type FactTrust = "high" | "medium" | "low";
export const ABOUT_FILE = "about-me";
/** Lines that left About me: replaced or merged ones are history, ones trimmed for size still hold. */
export const ABOUT_HISTORY_FILE = "about-me-history";

export interface FactRow {
  id: string;
  owner: string;
  file: string;
  ident: string;
  text: string;
  keys: string;
  subject: string | null;
  facet: string | null;
  kind: "state" | "event";
  happenedStart: string | null;
  happenedEnd: string | null;
  validFrom: string | null;
  validUntil: string | null;
  learnedAt: number;
  retiredAt: number | null;
  status: FactStatus;
  replacedBy: string | null;
  source: FactSource;
  quote: string | null;
  refs: { threadId?: string; messageIds?: string[] } | null;
  trust: FactTrust;
  typed: boolean;
}

export function trustOf(source: FactSource): FactTrust {
  if (source === "typed" || source === "person-said") return "high";
  if (source === "bot-verified" || source === "other-person" || source === "import" || source === "legacy") return "medium";
  return "low";
}

/** A line as it stands in a file, before it is matched to a row. */
export interface ParsedFact {
  ident: string;
  text: string;
  keys: string;
  date: string | null;
  until: string | null;
  supersededOn: string | null;
  status: FactStatus;
  typed: boolean;
  learnedBy: string | null;
}

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;
const SUPERSEDED_ON = / · superseded (\d{4}-\d{2}-\d{2})/;
const MERGED_ON = / · merged \d{4}-\d{2}-\d{2}/;
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const LEAD = /^(?:\s*\r?\n|#{1,6}[ \t]+[^\r\n]*\r?\n)*/;

/** Dated entries and the person's own undated lines of a memory file; headings, frontmatter and blank lines are not facts. */
export function parseFactFile(file: string, raw: string, today: string): ParsedFact[] {
  if (file === "MEMORY.md" && isMemorySeed(raw)) return [];
  const header = file.startsWith("memory/") ? parseTopicHeader(raw) : { aliases: [] as string[] };
  const archived = file.startsWith("memory/") && isArchiveTopic(file.slice("memory/".length));
  const keys = file.startsWith("memory/") && !archived
    ? [file.slice("memory/".length).replace(/\.md$/, "").replace(/[-_]+/g, " "), header.title ?? "", ...header.aliases].join(" ").trim()
    : "";
  const lead = LEAD.exec(raw)?.[0] ?? "";
  const text = lead + raw.slice(lead.length).replace(FRONTMATTER, (block) => "\n".repeat(block.split("\n").length - 1));
  const lines = text.split("\n");
  const entries = parseMemoryEntries(text);
  const covered = new Set<number>();
  const out: ParsedFact[] = [];
  for (const entry of entries) {
    for (let line = entry.line; line < entry.end; line++) covered.add(line);
    const body = entry.body.replace(/ · (?:updated|confirmed|merged|moved) \d{4}-\d{2}-\d{2}/g, "").trim();
    const ident = factIdentity(body);
    if (!ident) continue;
    const supersededOn = SUPERSEDED_ON.exec(entry.raw)?.[1] ?? null;
    const expired = isExpired(entry, today) || (archived && / · expired \d{4}-\d{2}-\d{2}/.test(entry.raw));
    out.push({
      ident,
      text: body,
      keys,
      date: entry.date,
      until: entry.until,
      supersededOn,
      status: entry.struck ? (MERGED_ON.test(entry.raw) ? "merged" : "superseded") : expired ? "expired" : "active",
      typed: false,
      learnedBy: null,
    });
  }
  let fenced = false;
  lines.forEach((line, index) => {
    if (covered.has(index)) return;
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced || !line.trim() || /^\s*#/.test(line) || /^\s*```/.test(line) || /^\s*(?:---|\*\*\*|___)\s*$/.test(line)) return;
    const struck = /^\s*(?:[-*•]\s+)?~~.*~~/.test(line);
    const body = line.replace(BULLET, "").replace(/~~/g, "").replace(/ · superseded \d{4}-\d{2}-\d{2}.*$/, "").trim();
    const ident = factIdentity(body);
    if (!ident || body.length < 3) return;
    out.push({ ident, text: body, keys, date: null, until: null, supersededOn: SUPERSEDED_ON.exec(line)?.[1] ?? null, status: struck ? "superseded" : "active", typed: true, learnedBy: null });
  });
  return out;
}

export function parseAboutFacts(aboutMe: string): ParsedFact[] {
  return parseGeneral(aboutMe).flatMap((line) => {
    const ident = factIdentity(line.fact);
    if (!ident) return [];
    return [{ ident, text: line.fact, keys: "", date: line.date, until: null, supersededOn: null, status: "active" as const, typed: !line.learned, learnedBy: line.by }];
  });
}

const newId = () => `f${randomBytes(5).toString("hex")}`;

type RawRow = {
  id: string; owner: string; file: string; ident: string; text: string; keys: string; subject: string | null; facet: string | null; kind: string;
  happened_start: string | null; happened_end: string | null; valid_from: string | null; valid_until: string | null; learned_at: number;
  retired_at: number | null; status: string; replaced_by: string | null; source: string; quote: string | null; refs: string | null; trust: string; typed: number;
};

const COLUMNS = "id, owner, file, ident, text, keys, subject, facet, kind, happened_start, happened_end, valid_from, valid_until, learned_at, retired_at, status, replaced_by, source, quote, refs, trust, typed";

function rowOf(raw: RawRow): FactRow {
  let refs: FactRow["refs"] = null;
  try {
    refs = raw.refs ? JSON.parse(raw.refs) as FactRow["refs"] : null;
  } catch {
    refs = null;
  }
  return {
    id: raw.id, owner: raw.owner, file: raw.file, ident: raw.ident, text: raw.text, keys: raw.keys, subject: raw.subject, facet: raw.facet,
    kind: raw.kind === "event" ? "event" : "state", happenedStart: raw.happened_start, happenedEnd: raw.happened_end,
    validFrom: raw.valid_from, validUntil: raw.valid_until, learnedAt: raw.learned_at, retiredAt: raw.retired_at,
    status: raw.status as FactStatus, replacedBy: raw.replaced_by, source: raw.source as FactSource, quote: raw.quote, refs,
    trust: raw.trust as FactTrust, typed: raw.typed === 1,
  };
}

function db(): DatabaseSync {
  return memoryStoreDb();
}

function inTransaction<T>(work: (database: DatabaseSync) => T): T {
  const database = db();
  if (database.isTransaction) return work(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    const out = work(database);
    database.exec("COMMIT");
    return out;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

/** Reconciles one owner's rows with the files just read. Lines that moved between files keep their row (and so their
 * provenance); lines that left every file become `suppressed`, so a fact deleted by hand is never recalled again. */
function reconcile(database: DatabaseSync, owner: string, files: ReadonlyMap<string, ParsedFact[]>, now: number): void {
  const existing = (database.prepare(`SELECT ${COLUMNS} FROM memory_facts WHERE owner = ?`).all(owner) as RawRow[]).map(rowOf);
  const byKey = new Map(existing.map((row) => [`${row.file}\n${row.ident}`, row]));
  const vanished = new Map<string, FactRow[]>();
  for (const row of existing) {
    if (!files.has(row.file)) continue;
    const still = files.get(row.file)!.some((fact) => fact.ident === row.ident);
    if (!still && row.status !== "suppressed") vanished.set(row.ident, [...(vanished.get(row.ident) ?? []), row]);
  }
  const insert = database.prepare(
    `INSERT INTO memory_facts (id, owner, file, ident, text, keys, kind, happened_start, happened_end, valid_from, valid_until, learned_at, status, source, trust, typed)
     VALUES (?, ?, ?, ?, ?, ?, 'state', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = database.prepare(
    "UPDATE memory_facts SET file = ?, text = ?, keys = ?, status = ?, valid_until = ?, retired_at = ?, typed = ? WHERE id = ?",
  );
  const seenIdents = new Set<string>();
  for (const [file, facts] of files) {
    for (const fact of facts) {
      const key = `${file}\n${fact.ident}`;
      if (seenIdents.has(key)) continue;
      seenIdents.add(key);
      const until = fact.supersededOn ?? fact.until;
      const retired = fact.status === "active" ? null : now;
      const known = byKey.get(key) ?? vanished.get(fact.ident)?.shift();
      if (known) {
        const status: FactStatus = fact.status === "active" && known.status === "merged" ? "merged" : fact.status;
        if (known.file !== file || known.text !== fact.text || known.keys !== fact.keys || known.status !== status || known.validUntil !== until || known.typed !== fact.typed) {
          update.run(file, fact.text, fact.keys, status, until, status === "active" ? null : known.retiredAt ?? retired, fact.typed ? 1 : 0, known.id);
        }
        continue;
      }
      const dates = factDates(fact.text);
      const source: FactSource = fact.typed ? "typed" : "legacy";
      const learnedAt = fact.date ? Date.parse(`${fact.date}T12:00:00Z`) : now;
      insert.run(
        newId(), owner, file, fact.ident, fact.text, fact.keys, dates?.start ?? null, dates?.end ?? null,
        fact.date, until, Number.isFinite(learnedAt) ? learnedAt : now, fact.status, source, trustOf(source), fact.typed ? 1 : 0,
      );
    }
  }
  const suppress = database.prepare("UPDATE memory_facts SET status = 'suppressed', retired_at = ? WHERE id = ?");
  const drop = database.prepare("DELETE FROM memory_facts WHERE id = ?");
  for (const rows of vanished.values()) {
    for (const row of rows) {
      // still elsewhere for this owner: this row was only a copy
      const elsewhere = existing.some((other) => other.id !== row.id && other.ident === row.ident && other.status !== "suppressed" && !vanished.get(row.ident)?.includes(other));
      if (elsewhere) drop.run(row.id);
      else suppress.run(now, row.id);
    }
  }
}

function stampOf(path: string): string | null {
  try {
    const stat = statSync(path);
    return `${Math.trunc(stat.mtimeMs)}:${stat.size}`;
  } catch {
    return null;
  }
}

const syncedDay = new Map<string, string>();

/** Brings one workspace's rows up to date with its MEMORY.md, topic files and archive; cheap when nothing changed. */
export function syncWorkspaceFacts(memoryId: string, now = new Date()): void {
  const database = db();
  const today = memoryDate(now);
  const dayChanged = syncedDay.get(memoryId) !== today;
  const dir = workspaceDir(memoryId);
  const files = ["MEMORY.md", ...listMemoryTopics(memoryId).map((topic) => `memory/${topic.name}`)];
  const stamps = new Map((database.prepare("SELECT file, stamp FROM memory_fact_files WHERE owner = ?").all(memoryId) as Array<{ file: string; stamp: string }>).map((row) => [row.file, row.stamp]));
  const changed = new Map<string, ParsedFact[]>();
  const fresh = new Map<string, string>();
  for (const file of files) {
    const stamp = stampOf(join(dir, file));
    if (stamp === null) continue;
    fresh.set(file, stamp);
    if (!dayChanged && stamps.get(file) === stamp) continue;
    try {
      changed.set(file, parseFactFile(file, readMemoryText(join(dir, file)), today));
    } catch {
      fresh.delete(file);
    }
  }
  for (const file of stamps.keys()) if (!fresh.has(file)) changed.set(file, []);
  syncedDay.set(memoryId, today);
  if (!changed.size) return;
  inTransaction((tx) => {
    reconcile(tx, memoryId, changed, now.getTime());
    const save = tx.prepare("INSERT INTO memory_fact_files (owner, file, stamp) VALUES (?, ?, ?) ON CONFLICT(owner, file) DO UPDATE SET stamp = excluded.stamp");
    const forget = tx.prepare("DELETE FROM memory_fact_files WHERE owner = ? AND file = ?");
    for (const file of changed.keys()) {
      const stamp = fresh.get(file);
      if (stamp) save.run(memoryId, file, stamp);
      else forget.run(memoryId, file);
    }
  });
}

/** The About me owner: one per server, or one per person on a Team Cloud. */
export function aboutOwner(person?: string): string {
  return person ? `about:${createHash("sha256").update(person).digest("hex").slice(0, 16)}` : "about";
}

export function parseAboutHistory(history: readonly HistoryEntry[]): ParsedFact[] {
  return history.flatMap((entry) => {
    const ident = factIdentity(entry.fact);
    if (!ident) return [];
    const date = /^\s*-\s*(\d{4}-\d{2}-\d{2}) · /.exec(entry.line)?.[1] ?? null;
    const left = new Date(entry.at).toISOString().slice(0, 10);
    const status: FactStatus = entry.reason === "trimmed" ? "active" : entry.reason === "duplicate" ? "merged" : "superseded";
    return [{ ident, text: entry.fact, keys: "", date, until: null, supersededOn: status === "active" ? null : left, status, typed: date === null, learnedBy: null }];
  });
}

export function syncAboutFacts(owner: string, aboutMe: string, now = new Date(), history: readonly HistoryEntry[] = []): void {
  const database = db();
  const stamp = createHash("sha256").update(aboutMe).update("\n\0").update(JSON.stringify(history.map((entry) => entry.id))).digest("hex");
  const known = database.prepare("SELECT stamp FROM memory_fact_files WHERE owner = ? AND file = ?").get(owner, ABOUT_FILE) as { stamp: string } | undefined;
  if (known?.stamp === stamp) return;
  inTransaction((tx) => {
    reconcile(tx, owner, new Map([[ABOUT_FILE, parseAboutFacts(aboutMe)], [ABOUT_HISTORY_FILE, parseAboutHistory(history)]]), now.getTime());
    tx.prepare("INSERT INTO memory_fact_files (owner, file, stamp) VALUES (?, ?, ?) ON CONFLICT(owner, file) DO UPDATE SET stamp = excluded.stamp").run(owner, ABOUT_FILE, stamp);
  });
}

export interface FactMeta {
  source?: FactSource;
  quote?: string;
  refs?: FactRow["refs"];
  subject?: string;
  facet?: string;
  kind?: "state" | "event";
  happened?: { start: string; end: string } | null;
  replaces?: readonly string[];
}

/** Records what the writer knows about a line it just wrote to `file`. The line's text decides which row it is. */
export function annotateFact(owner: string, file: string, text: string, meta: FactMeta, now = Date.now()): string | null {
  const ident = factIdentity(text.replace(BULLET, ""));
  if (!ident) return null;
  return inTransaction((tx) => {
    let row = tx.prepare("SELECT id FROM memory_facts WHERE owner = ? AND file = ? AND ident = ?").get(owner, file, ident) as { id: string } | undefined;
    if (!row) {
      const id = newId();
      const dates = meta.happened ?? factDates(text);
      tx.prepare(
        `INSERT INTO memory_facts (id, owner, file, ident, text, keys, kind, happened_start, happened_end, valid_from, learned_at, status, source, trust, typed)
         VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, 'active', ?, ?, 0)`,
      ).run(id, owner, file, ident, text, meta.kind ?? "state", dates?.start ?? null, dates?.end ?? null, memoryDate(new Date(now)), now, meta.source ?? "legacy", trustOf(meta.source ?? "legacy"));
      row = { id };
    }
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    const set = (column: string, value: string | number | null | undefined) => {
      if (value === undefined) return;
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (meta.source) {
      set("source", meta.source);
      set("trust", trustOf(meta.source));
    }
    set("quote", meta.quote?.slice(0, 300));
    set("refs", meta.refs ? JSON.stringify(meta.refs) : undefined);
    set("subject", meta.subject?.slice(0, 80));
    set("facet", meta.facet?.slice(0, 80));
    set("kind", meta.kind);
    if (meta.happened) {
      set("happened_start", meta.happened.start);
      set("happened_end", meta.happened.end);
    }
    if (sets.length) tx.prepare(`UPDATE memory_facts SET ${sets.join(", ")} WHERE id = ?`).run(...values, row.id);
    if (meta.replaces?.length) {
      const mark = tx.prepare("UPDATE memory_facts SET replaced_by = ? WHERE id = ? AND owner = ?");
      for (const old of meta.replaces) mark.run(row.id, old, owner);
    }
    return row.id;
  });
}

export function factsOf(owners: readonly string[], statuses: readonly FactStatus[] = ["active"]): FactRow[] {
  if (!owners.length) return [];
  const rows = db()
    .prepare(`SELECT ${COLUMNS} FROM memory_facts WHERE owner IN (${owners.map(() => "?").join(", ")}) AND status IN (${statuses.map(() => "?").join(", ")})`)
    .all(...owners, ...statuses) as RawRow[];
  return rows.map(rowOf);
}

export function factById(id: string): FactRow | null {
  const raw = db().prepare(`SELECT ${COLUMNS} FROM memory_facts WHERE id = ?`).get(id) as RawRow | undefined;
  return raw ? rowOf(raw) : null;
}

/** FTS5 BM25 over fact text and its topic's words, best first. */
export function searchFactText(owners: readonly string[], match: string, statuses: readonly FactStatus[], limit: number): string[] {
  if (!owners.length) return [];
  const rows = db()
    .prepare(
      `SELECT f.id FROM memory_facts_fts JOIN memory_facts f ON f.rowid = memory_facts_fts.rowid
       WHERE memory_facts_fts MATCH ? AND f.owner IN (${owners.map(() => "?").join(", ")}) AND f.status IN (${statuses.map(() => "?").join(", ")})
       ORDER BY bm25(memory_facts_fts, 1.0, 0.4) LIMIT ?`,
    )
    .all(match, ...owners, ...statuses, limit) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

export function factVectors(owners: readonly string[], statuses: readonly FactStatus[]): Map<string, Float32Array> {
  if (!owners.length) return new Map();
  const rows = db()
    .prepare(`SELECT id, embedding FROM memory_facts WHERE owner IN (${owners.map(() => "?").join(", ")}) AND status IN (${statuses.map(() => "?").join(", ")}) AND embedding IS NOT NULL AND embed_model = ?`)
    .all(...owners, ...statuses, EMBED_MODEL) as Array<{ id: string; embedding: Uint8Array }>;
  return new Map(rows.map((row) => [row.id, blobVector(row.embedding)]));
}

const EMBED_BATCH = 16;
let embedding: Promise<number> | null = null;

export function hasPendingFactsToEmbed(): boolean {
  try {
    return db()
      .prepare("SELECT 1 FROM memory_facts WHERE (embedding IS NULL OR embed_model != ?) AND status != 'suppressed' LIMIT 1")
      .get(EMBED_MODEL) !== undefined;
  } catch {
    return false;
  }
}

/** Embeds rows that have no vector yet, a batch at a time, never on a turn's path. Returns how many it embedded. */
export function embedPendingFacts(owners?: readonly string[], max = 400): Promise<number> {
  if (!embedderReady()) return Promise.resolve(0);
  if (embedding) return embedding;
  embedding = (async () => {
    let done = 0;
    try {
      while (done < max) {
        const where = owners?.length ? `AND owner IN (${owners.map(() => "?").join(", ")})` : "";
        const rows = db()
          .prepare(`SELECT id, text, keys FROM memory_facts WHERE (embedding IS NULL OR embed_model != ?) AND status != 'suppressed' ${where} LIMIT ?`)
          .all(EMBED_MODEL, ...(owners ?? []), EMBED_BATCH) as Array<{ id: string; text: string; keys: string }>;
        if (!rows.length) break;
        const vectors = await embedPassages(rows.map((row) => (row.keys ? `${row.keys}: ${row.text}` : row.text)));
        if (!vectors) break;
        const save = db().prepare("UPDATE memory_facts SET embedding = ?, embed_model = ? WHERE id = ?");
        rows.forEach((row, i) => save.run(vectorBlob(vectors[i]!), EMBED_MODEL, row.id));
        done += rows.length;
        await new Promise((resolve) => setImmediate(resolve));
      }
    } catch {
      // a closed or replaced database mid-batch: the next call picks up where this stopped
    }
    return done;
  })().finally(() => {
    embedding = null;
  });
  return embedding;
}

export function setFactStatus(ids: readonly string[], status: FactStatus, extra: { replacedBy?: string; now?: number } = {}): void {
  if (!ids.length) return;
  const statement = db().prepare("UPDATE memory_facts SET status = ?, retired_at = ?, replaced_by = COALESCE(?, replaced_by) WHERE id = ?");
  for (const id of ids) statement.run(status, status === "active" ? null : extra.now ?? Date.now(), extra.replacedBy ?? null, id);
}

export function deleteOwnerFacts(owner: string): void {
  inTransaction((tx) => {
    tx.prepare("DELETE FROM memory_facts WHERE owner = ?").run(owner);
    tx.prepare("DELETE FROM memory_fact_files WHERE owner = ?").run(owner);
  });
}

/** Tombstones of facts deleted by hand stop mattering after a while; this keeps the table from growing without end. */
export function pruneRetiredFacts(olderThanMs: number, now = Date.now()): number {
  const result = db().prepare("DELETE FROM memory_facts WHERE status = 'suppressed' AND retired_at IS NOT NULL AND retired_at < ?").run(now - olderThanMs);
  return Number(result.changes);
}

export function factStats(owners: readonly string[]): Record<FactStatus, number> & { embedded: number } {
  const out = { active: 0, superseded: 0, merged: 0, expired: 0, suppressed: 0, embedded: 0 };
  if (!owners.length) return out;
  const rows = db()
    .prepare(`SELECT status, COUNT(*) AS n, SUM(embedding IS NOT NULL) AS e FROM memory_facts WHERE owner IN (${owners.map(() => "?").join(", ")}) GROUP BY status`)
    .all(...owners) as Array<{ status: FactStatus; n: number; e: number }>;
  for (const row of rows) {
    out[row.status] = row.n;
    out.embedded += row.e ?? 0;
  }
  return out;
}
