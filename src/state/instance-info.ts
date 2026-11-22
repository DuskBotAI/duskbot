import type { EffortLevel } from "../../shared/wire";
import type { ModelVariantOption } from "../../shared/runtime-events";
import type { EngineInstall } from "./engine-install";

export interface InstanceInfo {
  instanceId: string;
  driverKind: string;
  displayName: string;
  icon?: import("../../shared/provider-icon").ProviderIcon;
  readOnly?: boolean;
  managed?: { organizationId: string; organizationName: string };
  policy?: { organizationName: string; reason: string; team?: boolean };
  snapshot: {
    state: "available" | "unavailable";
    reason?: string;
    authenticated?: boolean;
    chatgptPlan?: boolean;
    /** Ready only through OpenCode's free no-login models: a backup, never "an AI already works". */
    freeFallback?: boolean;
    authenticationUnavailableReason?: string;
    account?: { email?: string; organization?: string; method?: "login" | "api-key" };
    version?: string | null;
    update?: { title: string; message: string; command: string };
    billing?: "metered" | "subscription";
    warning?: { title: string; message: string };
  };
  /** What one tiny test message through this AI showed, for its current sign-in; absent until one is sent. */
  aiTest?: import("../../shared/ai-ranking").AiTestState;
  /** Why it didn't answer, in plain words, when it said (signed out, a used-up limit…). */
  aiTestError?: string;
  models: { default: string; options: Array<{ id: string; label: string; custom?: boolean; loaded?: boolean; provider?: string; variants?: ModelVariantOption[]; effortLevels?: readonly EffortLevel[]; orgBlocked?: true }> };
  capabilities?: {
    computerMcp?: boolean;
    agentsMcp?: boolean;
    composioMcp?: boolean;
    /** the engine can mount the native Email tools (a connected app without Composio), the paired phone's app tools and the Data tools */
    emailMcp?: boolean; deviceMcp?: boolean; dataMcp?: boolean;
    browserMcp?: boolean;
    images?: boolean;
    effortLevels?: readonly EffortLevel[];
    /** only a model listing its own `effortLevels` takes a level */
    effortByModel?: boolean;
    modelVariants?: boolean;
    queueing?: boolean;
    localComputerMcp?: boolean;
    approvalReview?: boolean;
    backgroundText?: boolean;
  };
  access?: "subscription" | "custom" | "api";
  authentication?: { method: "device-code" | "paste-code" | "browser" | "browser-pkce"; signOut?: boolean };
  install?: EngineInstall;
  cli?: string;
  cliDefault?: string;
  cliCandidates?: string[];
  claudeAccount?: { configDir: string; signInCommand: string; signInShell: "powershell" | "sh"; isDefault: boolean };
  freeUpSpace?: boolean; replyWaitMinutes?: number; modelsUnconfirmed?: true;
  /** Found on this computer, never chosen: listed, never used on its own until the person says so. */
  found?: true;
  /** Its saved driver is one this build doesn't have (a typo, or a config from another version): kept, never usable here. */
  unknownDriver?: true;
}
