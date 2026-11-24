// Every home's monthly cost book (power/ceiling.ts), kept as an append-only log: one JSON line per event in
// `spend/<YYYY-MM>.jsonl`, written and synced before the provider is asked for anything it could bill. On start the books
// are rebuilt by replaying the last two months through the same functions the live path uses. Nothing here names a
// provider: a start is cents, a machine is a rate.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { advanceBook, applySpend, DEFAULT_CEILING, monthOf, openBook, spendView, storageCommitCents, worstStartCents, type CeilingSettings, type SpendBook, type SpendEvent, type SpendView } from "./power/ceiling.ts";
import type { ProviderCostProfile } from "./power/cost.ts";

export interface SpendStore {
  /** the months the log has, as YYYY-MM */
  months(): string[];
  /** the lines of these months, oldest month first, in the order written */
  lines(months: readonly string[]): string[];
  append(month: string, line: string): void;
}
export function fileSpendStore(dataDir: string, name = "spend"): SpendStore {
  const dir = join(dataDir, name);
  return {
    months: () => existsSync(dir) ? readdirSync(dir).filter(f => /^\d{4}-\d{2}\.jsonl$/.test(f)).map(f => f.slice(0, 7)) : [],
    lines: months => months.flatMap(m => { const file = join(dir, `${m}.jsonl`); return existsSync(file) ? readFileSync(file, "utf8").split("\n") : []; }),
    append(month, line) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const fd = openSync(join(dir, `${month}.jsonl`), "a", 0o600);
      try { writeSync(fd, `${line}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    },
  };
}
export function memorySpendStore(): SpendStore & { all: Array<{ month: string; line: string }> } {
  const all: Array<{ month: string; line: string }> = [];
  return { all, months: () => [...new Set(all.map(x => x.month))], lines: months => months.flatMap(m => all.filter(x => x.month === m).map(x => x.line)), append: (month, line) => { all.push({ month, line }); } };
}

/** what a home's book opens with when the log has none for it */
export interface SpendInit { rate: number; up: boolean; bytes: number; prepaid: boolean; before: boolean; disk?: number }
type Line = SpendEvent & { t: number; c: string };

const CLOUD = /^[A-Za-z0-9_-]{1,80}$/;
function parse(raw: string): Line | null {
  try {
    const v = JSON.parse(raw) as Line;
    if (!v || typeof v !== "object" || !Number.isFinite(v.t) || typeof v.c !== "string" || !CLOUD.test(v.c)) return null;
    const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);
    switch (v.e) {
      case "open": return num(v.rate) && num(v.floor) && num(v.bytes) && typeof v.up === "boolean" && typeof v.prepaid === "boolean" && typeof v.before === "boolean" && (v.disk === undefined || num(v.disk) && v.disk >= 0) ? v : null;
      case "start": return num(v.cents) && typeof v.kind === "string" ? v : null;
      case "settle": return num(v.cents) && v.cents >= 0 && (v.void === undefined || typeof v.void === "boolean") ? v : null;
      case "extra": return num(v.cents) ? v : null;
      case "rate": return num(v.rate) && v.rate >= 0 ? v : null;
      case "bytes": return num(v.bytes) ? v : null;
      case "disk": return num(v.rate) && v.rate >= 0 ? v : null;
      case "up": case "down": case "stop": return v;
      default: return null;
    }
  } catch { return null; }
}

export function createSpendLedger(options: {
  /** where the log lives; or a store (the tests, the simulator) */
  dataDir?: string; store?: SpendStore;
  profile: ProviderCostProfile;
  reserveStarts: number;
  ceiling?: CeilingSettings;
  now: () => number;
  /** a monotonic clock: a wall-clock jump inside one process is not taken as time passing */
  mono?: () => number;
  /** `key`: what it is about (reserve, slack, backup, load), for the audit */
  alert?: (cloudId: string, text: string, key: string) => void;
}) {
  const s = options.ceiling ?? DEFAULT_CEILING, profile = options.profile, worst = worstStartCents(profile);
  const store = options.store ?? fileSpendStore(options.dataDir ?? (() => { throw new Error("A spend ledger needs a data directory or a store."); })());
  const books = new Map<string, SpendBook>();
  const closed = new Map<string, SpendBook[]>();
  let last = Number.NEGATIVE_INFINITY, lastMono: number | null = null, bad = 0;

  /** the ledger's time: the wall clock while it agrees with the monotonic one, never behind the last entry */
  function clock(): number {
    let t = options.now();
    if (options.mono) {
      const m = options.mono();
      if (lastMono !== null && Number.isFinite(last)) {
        const expected = last + Math.max(0, m - lastMono);
        if (Math.abs(t - expected) > 2_000) t = expected;
      }
      lastMono = m;
    }
    last = Math.max(last, t);
    return last;
  }
  function roll(c: string, b: SpendBook, to: number) {
    const done = advanceBook(b, to, s);
    if (done.length) closed.set(c, [...(closed.get(c) ?? []), ...done].slice(-13));
    return done.length > 0;
  }
  function write(t: number, c: string, ev: SpendEvent) { store.append(monthOf(t).key, JSON.stringify({ t, c, ...ev })); }

  // replay the log's newest two months (whatever the clock says at boot): the older one carries every book into the newer
  {
    for (const raw of store.lines([...new Set(store.months())].sort().slice(-2))) {
      if (!raw.trim()) continue;
      const line = parse(raw);
      if (!line) { bad++; continue; }
      const { t, c } = line;
      last = Math.max(last, t);
      let b = books.get(c);
      if (line.e === "open") { if (!b) books.set(c, openBook(t, line, s)); continue; }
      if (!b) { bad++; continue; }
      roll(c, b, t);
      applySpend(b, line);
    }
    // a torn last line is a write that never finished, so nothing was asked of the provider after it
    if (bad) options.alert?.("fleet", `spend ledger: ${bad} unreadable line(s) skipped on load`, "load");
  }
  // the monotonic clock is anchored at boot: from here a wall-clock jump is not taken as time passing
  clock();

  /** the book for a home, opened (and logged) when the log has none, accrued to now; a new month is logged as it carries */
  function book(c: string, init: () => SpendInit): { b: SpendBook; t: number } {
    const t = clock();
    let b = books.get(c);
    if (!b) {
      const i = init(), ev: SpendEvent = { e: "open", rate: i.rate, floor: Math.min(profile.floorCentsPerHour, i.rate), up: i.up, bytes: i.bytes, prepaid: i.prepaid, before: i.before, ...(i.disk ? { disk: i.disk } : {}) };
      write(t, c, ev); b = openBook(t, ev, s); books.set(c, b);
      return { b, t };
    }
    const month = b.month;
    if (t >= b.end) {
      roll(c, b, monthOf(t).start);
      // the carried state, as of the month's first moment, so this month's log replays on its own
      if (b.month !== month) write(b.start, c, { e: "open", rate: b.rate, floor: b.floor, up: b.up, bytes: b.bytes, prepaid: b.prepaid, before: false, ...(b.disk ? { disk: b.disk } : {}) });
    }
    roll(c, b, t);
    return { b, t };
  }
  const view = (b: SpendBook): SpendView => spendView(b, worst, options.reserveStarts, s);
  const alerted = new Map<string, string>();
  function alertOnce(c: string, b: SpendBook, key: string, text: string) {
    const tag = `${b.month}:${key}`;
    if (alerted.get(`${c}:${key}`) === tag) return;
    alerted.set(`${c}:${key}`, tag);
    options.alert?.(c, text, key);
  }

  return {
    /** the worst price of one start, what every start is charged until the pool ledger proves less */
    worst,
    view(c: string, init: () => SpendInit): SpendView { return view(book(c, init).b); },
    /** one event, logged (and synced) before it counts */
    record(c: string, init: () => SpendInit, ev: SpendEvent): SpendView {
      const { b, t } = book(c, init);
      write(t, c, ev); applySpend(b, ev);
      if (ev.e === "start" && worst > 0 && b.unplanned === options.reserveStarts) alertOnce(c, b, "reserve", `cloud ${c}: ${b.unplanned} starts this month were not ours to choose (failures, provider stops, rebuilds); it stays up for the rest of ${b.month}`);
      const v = view(b);
      if (v.slackCents < worst) alertOnce(c, b, "slack", `cloud ${c}: under one start of room left below its ${b.month} ceiling`);
      return v;
    },
    /** whether a machine of this home may be billed now; logged only when that changes */
    mark(c: string, init: () => SpendInit, up: boolean) {
      const { b, t } = book(c, init);
      if (b.up === up) return;
      const ev: SpendEvent = up ? { e: "up" } : { e: "down" };
      write(t, c, ev); applySpend(b, ev);
    },
    /** what keeping `bytes` more backup until the month ends adds */
    storageCents(c: string, init: () => SpendInit, bytes: number): number { return storageCommitCents(book(c, init).b, bytes, s); },
    /** the home's book and its last closed months, for the operator and the tests */
    book(c: string): { current: SpendBook | null; closed: SpendBook[] } {
      const b = books.get(c);
      if (b) roll(c, b, clock());
      return { current: b ? { ...b } : null, closed: (closed.get(c) ?? []).map(x => ({ ...x })) };
    },
    alert: (c: string, key: string, text: string) => { const b = books.get(c); if (b) alertOnce(c, b, key, text); else options.alert?.(c, text, key); },
  };
}
export type SpendLedger = ReturnType<typeof createSpendLedger>;
