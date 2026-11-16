import { freeFallback, rankAis } from "../shared/ai-ranking.ts";
import type { EffortLevel, EngineAccess, InstanceConfigMap, ModelCatalog, ModelSelection, ProviderSnapshot } from "./contracts.ts";

export interface SelectableInstance {
  instanceId: string;
  driverKind: string;
  snapshot: ProviderSnapshot;
  models: ModelCatalog;
  capabilities?: { effortLevels?: readonly EffortLevel[]; modelVariants?: boolean };
  access?: EngineAccess;
  enabled?: boolean;
}

export interface DefaultSelectionContext {
  company?: (instanceId: string) => boolean;
  refusal?: (instance: SelectableInstance) => string | undefined;
  /** What this AI's test message showed: true it answered, false it didn't, undefined not tested (server/tested-ai.ts). */
  answered?: (instance: SelectableInstance) => boolean | undefined;
}

/** The shared ranking (shared/ai-ranking.ts), with an AI that answered its test ahead of one that didn't or wasn't tested.
 * OpenCode's free backup comes in only once every other AI didn't answer. */
const best = (instances: readonly SelectableInstance[], context: DefaultSelectionContext) => {
  const ranked = rankAis(instances);
  const usable = (list: readonly SelectableInstance[]) => list.find((instance) => context.answered?.(instance) === true)
    ?? list.find((instance) => context.answered?.(instance) !== false);
  return usable(ranked.filter((instance) => !freeFallback(instance))) ?? usable(ranked) ?? ranked[0];
};

/** The saved config's enabled switch and picker group win over what the driver reports. */
/** Every list a person or the server chooses a model from passes here, so a hidden provider drops out of all of them. */
export function withInstanceConfig<T extends SelectableInstance>(instances: readonly T[], configs: InstanceConfigMap): T[] {
  return instances.filter((instance) => configs[instance.instanceId]?.hidden !== true).map((instance) => ({
    ...instance,
    enabled: configs[instance.instanceId]?.enabled ?? instance.enabled,
    ...(configs[instance.instanceId]?.access ? { access: configs[instance.instanceId].access } : {}),
  }));
}

/** A custom endpoint brings its own credential, so its sign-in state does not count. */
export function signedOut(instance: SelectableInstance): boolean {
  return instance.snapshot.state === "available" && instance.access !== "custom" && instance.snapshot.authenticated === false;
}

export function readyToRun(instance: SelectableInstance, context: DefaultSelectionContext = {}): boolean {
  return instance.enabled !== false && instance.snapshot.state === "available" && context.refusal?.(instance) === undefined && !signedOut(instance);
}

const defaultModel = (instance: SelectableInstance) => instance.models.default.trim()
  ? instance.models.default
  : instance.models.options.find((model) => model.id.trim())?.id ?? "";

/** A saved choice is intentional: an unavailable provider sends new bots to setup, never silently to another provider. On
 * an enrolled desktop a working personal engine beats a Company one, so billing stays the person's choice. */
export function selectDefaultModelSelection(
  instances: readonly SelectableInstance[],
  preferred?: ModelSelection,
  context: DefaultSelectionContext = {},
): ModelSelection {
  if (preferred && (preferred.instanceId || preferred.model) && !freeBackupOverConnected(instances, preferred, context)) {
    const instance = instances.find((candidate) => candidate.instanceId === preferred.instanceId);
    if (
      instance?.snapshot.state !== "available" ||
      instance.enabled === false ||
      signedOut(instance) ||
      !preferred.model.trim() ||
      // A disallowed saved engine is unusable like an unavailable one: setup, never another provider.
      context.refusal?.(instance) !== undefined ||
      (preferred.variant !== undefined && !instance.capabilities?.modelVariants)
    ) {
      return { instanceId: "", model: "" };
    }
    if (instance.models.default !== preferred.model && !instance.models.options.some((model) => model.id === preferred.model)) {
      // OpenCode's free models come and go: a pick it no longer lists runs on the free model there is now, not setup.
      const now = freeFallback(instance) ? defaultModel(instance) : "";
      return now ? { instanceId: instance.instanceId, model: now } : { instanceId: "", model: "" };
    }
    const selection = { ...preferred };
    // A saved effort can outlive driver support: keep the model, let the provider use its default effort.
    if (selection.effort && !instance.capabilities?.effortLevels?.includes(selection.effort)) delete selection.effort;
    return selection;
  }
  const available = instances.filter((instance) => instance.enabled !== false && instance.snapshot.state === "available" && context.refusal?.(instance) === undefined && defaultModel(instance));
  const ready = available.filter((instance) => readyToRun(instance, context));
  const company = context.company;
  const personal = company && instances.some((instance) => company(instance.instanceId))
    ? best(ready.filter((instance) => !company(instance.instanceId)), context)
    : undefined;
  const pick = personal ?? best(ready, context) ?? best(available, context);
  return { instanceId: pick?.instanceId ?? "", model: pick ? defaultModel(pick) : "" };
}

/** An AI that is "ready" only because a key and an address are saved (an API key, an OpenAI-compatible server) has shown
 * nothing until it answers: an address this machine can't reach reads exactly as ready as one it can. */
const keyOnly = (instance: SelectableInstance) => instance.access === "api" || instance.access === "custom";

/** A ready AI the person connected, never OpenCode's free backup: one whose test message missed never counts, and one
 * only a saved key makes ready counts once its test message answered. */
export function connectedAiReady(instances: readonly SelectableInstance[], context: DefaultSelectionContext = {}): boolean {
  return instances.some((instance) => {
    if (freeFallback(instance) || !readyToRun(instance, context) || !defaultModel(instance)) return false;
    const answered = context.answered?.(instance);
    return answered === true || (answered === undefined && !keyOnly(instance));
  });
}

/** OpenCode's free backup is a bonus while nothing else works, never a choice that outranks an AI the person connected: a
 * selection on it (a saved default, a bot's or a conversation's model) gives way as soon as a connected AI is ready. */
export function freeBackupOverConnected(
  instances: readonly SelectableInstance[],
  selection: ModelSelection | undefined,
  context: DefaultSelectionContext = {},
): boolean {
  const on = selection ? instances.find((instance) => instance.instanceId === selection.instanceId) : undefined;
  return Boolean(on && freeFallback(on)) && connectedAiReady(instances, context);
}

/** An explicit effort or variant wins; an engine without the level sends none rather than failing turn 1. */
export function withNewBotEffort(
  selection: ModelSelection,
  effort: EffortLevel | undefined,
  offered: readonly EffortLevel[] | undefined,
): ModelSelection {
  if (!effort || selection.effort !== undefined || selection.variant !== undefined || !offered?.includes(effort)) {
    return selection;
  }
  return { ...selection, effort };
}
