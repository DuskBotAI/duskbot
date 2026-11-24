// A managed cloud's own record, kept on the cloud as `StoredCloud.managed` (the dashboard stores it opaquely).
import type {} from "../../dashboard/server/clouds/types.ts";
import type { PowerMemory } from "./power/rails.ts";
import type { PlannedRun } from "./power/schedule.ts";
import type { HomeUpdateState } from "./home-update.ts";
import type { EgressState } from "./egress.ts";
import type { ComputerState } from "./computer-health.ts";

/** one managed home's lifecycle record (lifecycle.ts) */
export interface HomeLifecycleState {
  /** bumped for each deliberate new machine (a recovery); part of the provider's idempotency key */
  attempt: number;
  installed: string | null;
  /** a backup generation to restore into the next fresh machine */
  restoreFrom: string | null;
  /** the generation the running machine came back from, for the notice */
  restoredFrom?: { file: string; at: number } | null;
  sleptAt: number | null;
  sleepReason: "idle" | "plan" | "owner" | "operator" | "egress" | null;
  /** when the home was told of the owner's pause (its open apps show it asleep); the machine stops a grace later */
  sleepNoticeAt?: number | null;
  nextDueAt: number | null;
  lastPowerAt: number | null;
  busy: string[];
  leaseAt: number | null;
  lastStopAt: number | null;
  /** wakes the public edge asked for in the last hour (a webhook, the app): capped by edgeWakesPerHour */
  edgeWakes?: number[];
  /** when an open, focused app began keeping the home up (the sleep policy caps it at 30 minutes) */
  focusSince?: number | null;
  /** the owner's dashboard last showed this home (lifecycle `noteView`) */
  viewedAt?: number | null;
  /** the stuck holds the operator was last alerted about (one alert per incident), "" for none */
  stuckAlert?: string | null;
  /** this UTC day's awake time and the part of it a bot worked (a turn or a run), from the power reads; `flagged`: a
   *  finished day awake over half of it without work, until the daily check alerts about it */
  awakeDay?: { day: string; at: number; awakeMs: number; workMs: number } | null;
  flaggedDay?: { day: string; awakeMs: number; workMs: number } | null;
  /** what the current awake stretch began with: the person's routines (scheduled runs and checks), or anything else */
  wokeFor?: "routine" | "person" | null;
  /** the power policy's memory of this home: its starts, stops, failed starts, breaker and learned activity */
  power?: PowerMemory;
  /** the runs ahead as the home last reported them */
  upcoming?: PlannedRun[] | null;
  /** what asked for the pending wake: a webhook (a connector) or the app */
  wakeBy?: "webhook" | "client" | null;
  /** the current wake's failure was counted already */
  wakeFailureNoted?: boolean;
  /** the entitlement refresh failing: its cause as one token (home-client `homeFailure`), since when, how many tries,
   *  when it goes again and whether the operator was alerted (one alert per incident) */
  entitleProblem?: { cause: string; since: number; tries: number; retryAt: number; alerted: boolean } | null;
  /** why the power policy or the rails last kept a home up (or a sleeping one asleep), for the operator */
  stayReason?: string | null;
  wakeStartedAt: number | null;
  backups: Array<{ file: string; at: number; bytes: number; sha256: string; verifiedAt: number | null; snapshotAt: number }>;
  lastBackupTryAt: number | null;
  backupProblem: string | null;
  /** the billing record's end of the plan, as first seen: the retention clock */
  endedAt: number | null;
  notices: Array<{ kind: string; at: number }>;
  /** when this service first read the plan as ended, on any step: the retention clock never starts before it */
  endSeenAt?: number | null;
  /** `by: "operator"`: archived first, its snapshot and backups kept for the retention window */
  deleteRequest: { requestedAt: number; tokenHash: string | null; tokenExpiresAt: number | null; confirmedAt: number | null; executeAfter: number | null; cancelledAt: number | null; by?: "operator" } | null;
  /** the provider's receipt for an accepted delete: never sent twice */
  deletion: { serverId: string; operationId: string | null; at: number; reason: string; sent?: boolean } | null;
  deletedAt: number | null;
  backupsDeleteAfter: number | null;
  /** machinees this cloud had before a recovery, stopped, deleted once the new one has its own verified backup */
  retired: Array<{ serverId: string; at: number; deletion: { operationId: string | null; at: number } | null; backedUp?: number;
    /** its provider snapshot, taken before its machine was deleted; dropped with the cloud */
    snapshotId?: string | null; archivedAt?: number | null; archiveTryAt?: number | null }>;
  /** the home saved as a provider snapshot after its plan ended, its machine (and the disk we paid for) deleted; a new
   *  plan within retention boots a machine from it. `serverId`: the machine it came from, until that one is deleted */
  archive?: { snapshotId: string; at: number; serverId: string | null; from?: string } | null;
  /** the snapshot the next machine boots from (a revived archive) */
  restoreSnapshot?: string | null;
  /** this month's internet upload and what the egress guard did about it (egress.ts) */
  egress?: EgressState | null;
  recoveries: number;
  hold: boolean;
  /** first setups that failed on their machine */
  setupFailures?: number;
  /** failed restores of the generation in `restoreFrom` */
  restoreTries?: number;
  /** generations whose restore kept failing: never tried again */
  badRestores?: string[];
  /** retryable failures in a row during a first setup */
  setupRetries?: number;
  /** when a first setup was first seen in its error state */
  setupErrorAt?: number | null;
  /** wakes for a final backup since the plan ended that brought none */
  finalWakes?: number;
  /** when the current machine's setup began */
  setupSince?: number;
  /** the provider answered 404 for the current machine since this time, this many times; reset by any answer */
  missingSince?: number | null;
  missingChecks?: number;
  /** the owner asked to apply a plan change now (resize-now) */
  resizeAskedAt?: number | null;
  /** the machine's one-time claim for its secrets (only its hash), cleared once it runs */
  claim?: { hash: string; expiresAt: number; redeemedAt: number | null } | null;
  /** the opaque public label of its user-facing origin, and the machine's own hosted URL behind it */
  label?: string | null;
  upstream?: string | null;
  /** the provider has answered "too many requests" this many times in a row */
  limitStreak?: number;
  /** a size the provider refused (shrinking below the data, say), not tried again */
  resizeBlocked?: string | null;
  /** the home's updates: the version it runs, the one before, the trial of a new one, the signed policy held (home-update.ts) */
  update?: HomeUpdateState;
  /** the bot computers' docker and docker gate as the reconciler last checked them (computer-health.ts) */
  computer?: ComputerState;
}

declare module "../../dashboard/server/clouds/types.ts" {
  interface ManagedCloudState extends HomeLifecycleState {}
}
