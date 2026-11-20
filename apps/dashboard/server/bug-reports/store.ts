import type { Db } from "mongodb";
import { Binary, MongoServerError } from "mongodb";
import { DEV_BUILD, TEST_INSTALL } from "../admin/test-accounts.ts";

/** what the owner sets in admin; the desktop hears "fixed" for fixed and "received" for the rest */
export const BUG_REPORT_STATUSES = ["new", "looking", "fixed", "wont-fix"] as const;
export type BugReportStatus = (typeof BUG_REPORT_STATUSES)[number];

/** one @devs report as admin lists it (no diagnostics); times are epoch ms */
export interface BugReportRow {
  id: string;
  installId: string;
  source: string;
  description: string;
  appVersion: string;
  platform: string;
  contact: string | null;
  status: BugReportStatus;
  fixedIn: string | null;
  receivedAt: number;
  updatedAt: number;
  notifiedAt: number | null;
  /** how many pictures came with it (feedback); each at GET /v1/admin/bug-reports/:id/images/:n, n from 0 */
  images: number;
}
export interface BugReport extends BugReportRow { diagnostics: string }
export interface ReportImage { mime: "image/png" | "image/jpeg" | "image/webp"; bytes: Buffer; width: number; height: number }
export type NewBugReport = Omit<BugReport, "status" | "fixedIn" | "updatedAt" | "notifiedAt" | "images"> & { hash: string; images: ReportImage[] };

export interface BugReportStore {
  /** the report kept; when the same install already sent these exact bytes, that one instead (a retry whose answer was lost) */
  add(report: NewBugReport, dedupeSince: number): Promise<{ report: BugReportRow; fresh: boolean }>;
  /** `real` leaves out harness installs and unreleased builds; `ids` keeps only those reports */
  list(options: { limit: number; before?: number; status?: BugReportStatus; real?: boolean; ids?: readonly string[] }): Promise<BugReportRow[]>;
  /** the newest `max` reports' words and status, for grouping by theme */
  summaries(options: { real?: boolean; max: number }): Promise<Array<{ id: string; description: string; status: BugReportStatus }>>;
  get(id: string): Promise<BugReport | null>;
  counts(options?: { real?: boolean }): Promise<Record<BugReportStatus, number>>;
  /** the newest reports these app installs sent */
  fromInstalls(installIds: readonly string[], limit: number): Promise<BugReportRow[]>;
  setStatus(id: string, status: BugReportStatus, fixedIn: string | null, at: number): Promise<BugReportRow | null>;
  /** only this install's own reports among `ids` */
  statuses(installId: string, ids: string[]): Promise<Array<{ id: string; status: BugReportStatus; fixedIn: string | null }>>;
  /** true once per report: whoever claims it sends its one email */
  claimNotify(id: string, at: number): Promise<boolean>;
  image(id: string, n: number): Promise<{ mime: ReportImage["mime"]; bytes: Buffer } | null>;
}

interface BugReportDoc {
  _id: string; installId: string; source: string; description: string; appVersion: string; platform: string; diagnostics: string;
  contact: string | null; hash: string; status: BugReportStatus; fixedIn: string | null; receivedAt: Date; updatedAt: Date; notifiedAt: Date | null; images?: number;
}
interface BugReportImageDoc { _id: string; reportId: string; n: number; mime: ReportImage["mime"]; width: number; height: number; data: Binary }
const LIST_FIELDS = { diagnostics: 0, hash: 0 } as const;
const row = (doc: Omit<BugReportDoc, "diagnostics" | "hash">): BugReportRow => ({ id: doc._id, installId: doc.installId, source: doc.source, description: doc.description,
  appVersion: doc.appVersion, platform: doc.platform, contact: doc.contact ?? null, status: doc.status, fixedIn: doc.fixedIn ?? null,
  receivedAt: doc.receivedAt.getTime(), updatedAt: doc.updatedAt.getTime(), notifiedAt: doc.notifiedAt?.getTime() ?? null, images: doc.images ?? 0 });
/** a person's report: not a harness install's, not an unreleased build's */
const REAL = { installId: { $not: TEST_INSTALL }, appVersion: { $not: DEV_BUILD } };
const isReal = (report: { installId: string; appVersion: string }) => !TEST_INSTALL.test(report.installId) && !DEV_BUILD.test(report.appVersion);
const zero = (): Record<BugReportStatus, number> => ({ new: 0, looking: 0, fixed: 0, "wont-fix": 0 });

/** one document per report, kept until the owner removes it by hand; `_id` is the id the person sees */
export async function mongoBugReportStore(db: Db): Promise<BugReportStore> {
  const reports = db.collection<BugReportDoc>("bug_reports");
  const images = db.collection<BugReportImageDoc>("bug_report_images");
  await reports.createIndexes([{ key: { receivedAt: -1 } }, { key: { status: 1, receivedAt: -1 } }, { key: { installId: 1, hash: 1, receivedAt: -1 } }]);
  return {
    async add(report, dedupeSince) {
      const same = await reports.findOne({ installId: report.installId, hash: report.hash, receivedAt: { $gte: new Date(dedupeSince) } }, { projection: LIST_FIELDS });
      if (same) return { report: row(same), fresh: false };
      const at = new Date(report.receivedAt);
      const doc: BugReportDoc = { _id: report.id, installId: report.installId, source: report.source, description: report.description, appVersion: report.appVersion,
        platform: report.platform, diagnostics: report.diagnostics, contact: report.contact, hash: report.hash, status: "new", fixedIn: null, receivedAt: at, updatedAt: at, notifiedAt: null,
        ...(report.images.length ? { images: report.images.length } : {}) };
      try { await reports.insertOne(doc); }
      catch (error) { if (error instanceof MongoServerError && error.code === 11000) throw new Error("bug report id taken"); throw error; }
      if (report.images.length) await images.insertMany(report.images.map((image, n) => ({ _id: `${report.id}:${n}`, reportId: report.id, n, mime: image.mime, width: image.width, height: image.height, data: new Binary(image.bytes) })));
      return { report: row(doc), fresh: true };
    },
    async list({ limit, before, status, real, ids }) {
      const filter = { ...(status ? { status } : {}), ...(before !== undefined ? { receivedAt: { $lt: new Date(before) } } : {}), ...(real ? REAL : {}), ...(ids ? { _id: { $in: [...ids] } } : {}) };
      return (await reports.find(filter, { projection: LIST_FIELDS }).sort({ receivedAt: -1 }).limit(limit).toArray()).map(row);
    },
    async get(id) {
      const doc = await reports.findOne({ _id: id }, { projection: { hash: 0 } });
      return doc ? { ...row(doc), diagnostics: doc.diagnostics } : null;
    },
    async counts({ real } = {}) {
      const out = zero();
      for (const item of await reports.aggregate<{ _id: BugReportStatus; n: number }>([...(real ? [{ $match: REAL }] : []), { $group: { _id: "$status", n: { $sum: 1 } } }]).toArray()) if (item._id in out) out[item._id] = item.n;
      return out;
    },
    async fromInstalls(installIds, limit) {
      if (!installIds.length) return [];
      return (await reports.find({ installId: { $in: [...installIds] } }, { projection: LIST_FIELDS }).sort({ receivedAt: -1 }).limit(limit).toArray()).map(row);
    },
    async summaries({ real, max }) {
      return (await reports.find(real ? REAL : {}, { projection: { description: 1, status: 1 } }).sort({ receivedAt: -1 }).limit(max).toArray())
        .map(doc => ({ id: doc._id, description: doc.description, status: doc.status }));
    },
    async setStatus(id, status, fixedIn, at) {
      const doc = await reports.findOneAndUpdate({ _id: id }, { $set: { status, fixedIn, updatedAt: new Date(at) } }, { returnDocument: "after", projection: LIST_FIELDS });
      return doc ? row(doc) : null;
    },
    async statuses(installId, ids) {
      if (!ids.length) return [];
      return (await reports.find({ _id: { $in: ids }, installId }, { projection: { status: 1, fixedIn: 1 } }).toArray()).map(doc => ({ id: doc._id, status: doc.status, fixedIn: doc.fixedIn ?? null }));
    },
    async claimNotify(id, at) {
      return (await reports.updateOne({ _id: id, notifiedAt: null }, { $set: { notifiedAt: new Date(at) } })).modifiedCount === 1;
    },
    async image(id, n) {
      const doc = await images.findOne({ _id: `${id}:${n}` });
      return doc ? { mime: doc.mime, bytes: Buffer.from(doc.data.buffer) } : null;
    },
  };
}

/** development and tests: gone on restart */
type MemoryReport = BugReport & { hash: string; pictures: ReportImage[] };
export function memoryBugReportStore(): BugReportStore & { all: Map<string, MemoryReport> } {
  const all = new Map<string, MemoryReport>();
  const view = ({ diagnostics: _d, hash: _h, pictures: _p, ...rest }: MemoryReport): BugReportRow => ({ ...rest });
  return {
    all,
    async add(report, dedupeSince) {
      const same = [...all.values()].find(item => item.installId === report.installId && item.hash === report.hash && item.receivedAt >= dedupeSince);
      if (same) return { report: view(same), fresh: false };
      if (all.has(report.id)) throw new Error("bug report id taken");
      const { images: pictures, ...rest } = report;
      const kept: MemoryReport = { ...rest, pictures, images: pictures.length, status: "new", fixedIn: null, updatedAt: report.receivedAt, notifiedAt: null };
      all.set(report.id, kept);
      return { report: view(kept), fresh: true };
    },
    async list({ limit, before, status, real, ids }) {
      return [...all.values()].filter(item => (!status || item.status === status) && (before === undefined || item.receivedAt < before) && (!real || isReal(item)) && (!ids || ids.includes(item.id)))
        .sort((a, b) => b.receivedAt - a.receivedAt).slice(0, limit).map(view);
    },
    async get(id) { const item = all.get(id); if (!item) return null; const { hash: _h, pictures: _p, ...rest } = item; return { ...rest }; },
    async counts({ real } = {}) { const out = zero(); for (const item of all.values()) if (!real || isReal(item)) out[item.status]++; return out; },
    async fromInstalls(installIds, limit) {
      return [...all.values()].filter(item => installIds.includes(item.installId)).sort((a, b) => b.receivedAt - a.receivedAt).slice(0, limit).map(view);
    },
    async summaries({ real, max }) {
      return [...all.values()].filter(item => !real || isReal(item)).sort((a, b) => b.receivedAt - a.receivedAt).slice(0, max).map(({ id, description, status }) => ({ id, description, status }));
    },
    async setStatus(id, status, fixedIn, at) { const item = all.get(id); if (!item) return null; Object.assign(item, { status, fixedIn, updatedAt: at }); return view(item); },
    async statuses(installId, ids) { return ids.flatMap(id => { const item = all.get(id); return item && item.installId === installId ? [{ id, status: item.status, fixedIn: item.fixedIn }] : []; }); },
    async claimNotify(id, at) { const item = all.get(id); if (!item || item.notifiedAt !== null) return false; item.notifiedAt = at; return true; },
    async image(id, n) { const picture = all.get(id)?.pictures[n]; return picture ? { mime: picture.mime, bytes: picture.bytes } : null; },
  };
}
