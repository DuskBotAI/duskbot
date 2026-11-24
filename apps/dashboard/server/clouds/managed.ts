// The seam between the account service and a managed cloud backend (apps/cloud-service): one machine per cloud, run,
// slept, woken, backed up and retired by the backend. The service stores the backend's per-cloud record opaquely in
// `StoredCloud.managed` and knows nothing of the provider behind it.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CloudDesktopView } from "../../../../shared/billing-api.ts";
import type { DesktopPlan, HomeClient, ManagedCloudState, StoredCloud } from "./types.ts";

/** What the clouds service lends its managed backend. */
export interface ManagedCloudContext {
  dataDir: string;
  home: HomeClient;
  now(): number;
  save(cloud: StoredCloud): void;
  /** every cloud in the store, for decisions that compare clouds (the edge's route lookup, the claim) */
  clouds(): StoredCloud[];
  /** writes the store as it is now */
  commit(): void;
  /** the cloud's record as stored on disk now, re-read right before anything irreversible */
  stored(cloudId: string): StoredCloud | null;
  unseal(value: string): string;
  seal(value: string): string;
  dashboardUrl: string;
  adminOrigin: string;
  removeWorkspace(workspaceId: string): void;
  /** a fresh signed entitlement for this cloud's home, or null when this service signs none */
  entitlement(cloud: StoredCloud): string | null;
  /** a link grant for the cloud's account, for its home's phone relay, or null when this service signs none */
  linkGrant?(cloud: StoredCloud): string | null;
  /** runs a reconcile pass now; with a cloud id, keeps running them every second until that cloud's wake is through */
  kick?(cloudId?: string): void;
}

export interface ManagedCloudRoutesContext {
  publicUrl: string;
  readJson(req: IncomingMessage): Promise<Record<string, unknown>>;
  json(res: ServerResponse, status: number, data: unknown): void;
  /** the client's address as the edge reports it, for rate limits */
  clientIp(req: IncomingMessage): string;
}

/** A managed backend, bound to one clouds service. */
export interface ManagedCloud {
  /** a cloud of these kinds runs on the backend from activation on */
  readonly kinds: ReadonlyArray<DesktopPlan["kind"]>;
  /** the backend's record for a newly activated cloud */
  fresh(): ManagedCloudState;
  /** one lifecycle step; throws to be retried later (`retryAt` decides when) */
  reconcile(cloud: StoredCloud): Promise<void>;
  /** when a failed step runs again; null leaves it to the service's own backoff */
  retryAt(cloud: StoredCloud, error: unknown): number | null;
  /** fields the backend adds to the cloud's view (retention, backups, deletion) */
  view(cloud: StoredCloud): Partial<CloudDesktopView>;
  /** after each pass over every cloud (a stray machine sweep, say) */
  afterPass(clouds: StoredCloud[]): Promise<void>;
  /** an ended cloud still within retention, with no deletion under way: a new plan brings it back with its data */
  revivable(cloud: StoredCloud): boolean;
  /** the owner's own deletion of a managed cloud's data: never at once, after an emailed confirmation and an undo window */
  requestDelete(cloud: StoredCloud, link: (token: string) => string): void;
  confirmDelete(cloud: StoredCloud, token: string): number;
  cancelDelete(cloud: StoredCloud): void;
  /** the operator's deletion of a cloud whose plan ended (test accounts, abuse): skips the retention wait and the owner's
   *  undo window, nothing else. The home is saved as a provider snapshot, read back ready, before its machine is deleted;
   *  that snapshot and its backups are kept for the retention window (7 days for an unpaid trial, else the retention days) */
  operatorDelete(cloud: StoredCloud, reason: string): void;
  /** its account was deleted: deleted at once (no 7-day undo, nobody is left to undo it), past any paid period, unless held */
  accountDeleted?(cloud: StoredCloud): void;
  /** a backup of a running cloud now (its owner's move into it was checked); false when it did not run or was asked too soon */
  backupNow?(cloud: StoredCloud): Promise<boolean>;
  /** apply a pending plan change now instead of at the next idle sleep */
  resizeNow(cloud: StoredCloud): void;
  resizing(cloud: StoredCloud): boolean;
  /** its owner has the dashboard open on it: a hint that keeps an awake home up a while, never a wake */
  noteView?(cloud: StoredCloud): void;
  /** an operator hold: nothing is deleted while it is set */
  setHold(cloud: StoredCloud, hold: boolean): void;
  /** the operator ends a home package's trial early, once its self-test passed (preview's test clouds) */
  endTrial?(cloud: StoredCloud, reason: string): { ended: string } | { refused: "no_trial" | "self_test_pending" };
  /** what the provider measured for the cloud's current machine, this month or from `from` until now */
  usage?(cloud: StoredCloud, from?: number): Promise<{ runningSeconds: number; vcpuSeconds: number; memGiBSeconds: number; diskGiBSeconds: number; egressBytes: number } | null>;
  /** the backend's own routes (machine claims, the edge's route lookup); true when answered */
  handle?(req: IncomingMessage, res: ServerResponse, url: URL, context: ManagedCloudRoutesContext): Promise<boolean>;
  close(): void;
}

/** How a backend is attached: built once the clouds service can lend it a context. */
export interface ManagedCloudFactory {
  readonly kinds: ReadonlyArray<DesktopPlan["kind"]>;
  create(context: ManagedCloudContext): ManagedCloud;
}

export class ManagedCloudError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) { super(code); this.name = "ManagedCloudError"; this.status = status; this.code = code; }
}
