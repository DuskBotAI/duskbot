import type { ModelCatalog } from "../../contracts.ts";
import { clearStartupModelCache, readStartupModelCacheEntry, unconfirmedModelCatalog, writeStartupModelCache } from "../../startup-model-catalog.ts";

export interface AcpModelCatalog {
  models: ModelCatalog;
  /** The models the signed-in account offers, once the engine has listed them. */
  accountModels: ReadonlySet<string> | null;
  /** True while the list is the driver's fixed one or a failed read's leftover, not one the engine gave. */
  readonly unconfirmed: boolean;
  /** A read already under way is shared; a fresh one waits for a cached one under way, then reads again. */
  refresh(fresh?: boolean): Promise<void>;
  /** Clears any account-specific catalog back to the fixed fallback (e.g. after sign-out). */
  reset(): void;
}

export function acpModelCatalog(input: {
  instanceId: string;
  fixed: ModelCatalog;
  startFromSaved: boolean;
  resolve?: (fresh: boolean) => ModelCatalog | Promise<ModelCatalog>;
}): AcpModelCatalog {
  const { instanceId, resolve } = input;
  const saved = resolve ? readStartupModelCacheEntry(instanceId) : null;
  let models = input.startFromSaved ? saved?.catalog ?? input.fixed : input.fixed;
  let readFromEngine = Boolean(saved?.checkedAt);
  let accountModels: ReadonlySet<string> | null = saved?.checkedAt ? idsOf(saved.catalog) : null;
  let current: { fresh: boolean; done: Promise<void> } | null = null;
  let generation = 0;

  const read = async (fresh: boolean) => {
    if (!resolve) return;
    const started = generation;
    try {
      const resolved = await resolve(fresh);
      if (generation !== started) return;
      if (resolved.options.length) {
        models = resolved;
        readFromEngine = true;
        accountModels = idsOf(resolved);
      } else unconfirmedModelCatalog(models);
    } catch {
      if (generation !== started) return;
      unconfirmedModelCatalog(models);
    }
    try { writeStartupModelCache(instanceId, models); } catch {}
  };

  return {
    get models() { return models; },
    set models(catalog) { models = catalog; },
    get accountModels() { return accountModels; },
    set accountModels(ids) { accountModels = ids; },
    get unconfirmed() { return Boolean(resolve) && !readFromEngine; },
    refresh(fresh = false) {
      if (current && (current.fresh || !fresh)) return current.done;
      const next = { fresh, done: (current?.done ?? Promise.resolve()).then(() => read(fresh)) };
      current = next;
      void next.done.finally(() => { if (current === next) current = null; });
      return next.done;
    },
    reset() {
      generation += 1;
      models = input.fixed;
      readFromEngine = false;
      accountModels = null;
      clearStartupModelCache(instanceId);
    },
  };
}

function idsOf(catalog: ModelCatalog): ReadonlySet<string> {
  return new Set(catalog.options.map((option) => option.id));
}
