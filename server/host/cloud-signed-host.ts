// A Cloud home's signed routes and the health report behind them (server/host/README.md): what the Admin reads with the
// bootstrap secret. Null on any server that is not a Cloud home. The bot box's report rides both the health report and
// its own route, `GET /api/cloud/box`.
import type { BoxReport } from "../bot-box/box.ts";
import { createCloudHealth, type CloudHealth, type CloudHealthDeps } from "../cloud-health.ts";
import { createCloudEntitlement } from "../cloud-entitlement.ts";
import type { CloudHomeConfig } from "../cloud-home.ts";
import type { CloudPower } from "../cloud-power.ts";
import { json } from "../harness/http.ts";
import { createCloudSignedRoutes } from "../routes/cloud-signed.ts";
import { createCloudUpdateRoute } from "../routes/updates.ts";
import type { UpdateState } from "../update-state.ts";
import type { TeamAdminSummary } from "../cloud-team-admin.ts";
import type { SessionRegistry } from "../sessions.ts";

export interface CloudSignedHostDeps {
  cloudHome: CloudHomeConfig | null;
  health: Omit<CloudHealthDeps, "box">;
  sessions: Pick<SessionRegistry, "openPairing" | "revokeMember" | "attemptAllowed" | "noteFailure" | "clearFailures">;
  /** The home's power once the server listens (a late-bound singleton of index.ts). */
  power: () => Pick<CloudPower, "report" | "prepareSleep"> | null;
  box: () => BoxReport;
  /** A Team Cloud's shared connections and AI for its admins; used only when the home is a Team Cloud. */
  teamAdmin?: { summary(): Promise<TeamAdminSummary> };
  /** A Team Cloud's member left (the Admin's signed request): delete what was theirs alone. */
  memberLeft?: (email: string) => Promise<Record<string, unknown>>;
  /** A Team Cloud's rules changed on the Admin (its signed nudge): fetch them now. */
  policyChanged?: () => void;
  /** The plan was cancelled, or renews again (the Admin's signed request): routines wait while it is cancelled. */
  plan?: (cancelled: boolean) => void;
  /** Which plan this Cloud is on now (the Admin's signed request). */
  planTier?: (tier: string) => void;
  /** AI sign-ins the Admin held while this Cloud was being made (server/cloud-ai-signins.ts). */
  aiSignIns?: (items: import("../cloud-ai-signins.ts").CloudAiSignIn[]) => Promise<void>;
  /** The link grant the Admin sends beside an entitlement, for this Cloud's phone relay. */
  linkGrant?: (grant: unknown) => void;
  /** The home's own update state (server/update-state.ts), read by the Admin after it installs a release. */
  updates?: () => UpdateState | null;
}

export function createCloudSignedHost(deps: CloudSignedHostDeps): { cloudHealth: CloudHealth | null; cloudSigned: ReturnType<typeof createCloudSignedRoutes> | null } {
  const cloudHealth = deps.cloudHome ? createCloudHealth({ ...deps.health, box: deps.box }) : null;
  const entitlement = deps.cloudHome ? createCloudEntitlement({ dataDir: deps.health.dataDir, machineId: deps.cloudHome.machineId }) : null;
  const routes = deps.cloudHome && cloudHealth
    ? createCloudSignedRoutes({ entitlement, secret: deps.cloudHome.bootstrapSecret, sessions: deps.sessions, team: deps.cloudHome.team, health: cloudHealth, power: deps.power, box: deps.box,
      ...(deps.cloudHome.team && deps.teamAdmin ? { teamAdmin: deps.teamAdmin } : {}),
      ...(deps.cloudHome.team && deps.memberLeft ? { memberLeft: deps.memberLeft } : {}), ...(deps.cloudHome.team && deps.policyChanged ? { policyChanged: deps.policyChanged } : {}), ...(deps.plan ? { plan: deps.plan } : {}), ...(deps.planTier ? { planTier: deps.planTier } : {}), ...(deps.aiSignIns ? { aiSignIns: deps.aiSignIns } : {}), ...(deps.linkGrant ? { linkGrant: deps.linkGrant } : {}) })
    : null;
  const update = deps.cloudHome && deps.updates ? createCloudUpdateRoute({ secret: deps.cloudHome.bootstrapSecret, state: deps.updates }) : null;
  // a hosted home without a valid entitlement answers only its signed routes and its liveness probe
  const cloudSigned: typeof routes = routes && (async (request) => {
    if (update?.(request.req, request.res, request.url, request.path, request.method)) return true;
    if (await routes(request)) return true;
    const refused = entitlement?.gate(request.path);
    if (!refused) return false;
    json(request.res, refused.status, refused.body);
    return true;
  });
  return { cloudHealth, cloudSigned };
}
