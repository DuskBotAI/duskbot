// Settings > Models and the bot model picker: every provider, a search over every model, a live model list for a key,
// and connecting a provider on this server, the machine its bots run on. A key arrives sealed for this server unless it
// comes from this computer's own app (server/sealed-fields.ts).
import { z } from "zod";

import {
  MODEL_PROVIDERS, connectedProviders, instanceReady, providerBaseUrl, providerOffer, providerOfInstance,
  type ConnectableInstance, type ModelProviderDef, type Place,
} from "../../shared/model-providers.ts";
import { searchModels, type SearchGroup } from "../../shared/model-search.ts";
import type { CardSealer } from "../card-seal.ts";
import type { InstanceConfigMap } from "../contracts.ts";
import type { ModelCatalogStore } from "../model-catalog/catalog.ts";
import { catalogStats } from "../model-catalog/trim.ts";
import {
  CatalogIndex, addressProblem, buildConnection, catalogGroups, listProviderModels, moreProviders, probeLocalProviders, resolveProvider,
} from "../model-providers.ts";
import { keyResult } from "../key-check.ts";
import { unsealFields } from "../sealed-fields.ts";
import { PASS, type RouteHandler } from "./table.ts";

type DescribedInstance = ConnectableInstance & { displayName?: string; models?: { options?: Array<{ id: string; label?: string }> } };

export interface ModelProviderRouteDeps {
  catalog: Pick<ModelCatalogStore, "get" | "refresh">;
  place: Place;
  describeInstances(): Promise<unknown>;
  /** The saved instance configs, to add a connection to. */
  instances(): InstanceConfigMap;
  persistProviderInstance(instanceId: string, instances: InstanceConfigMap): Promise<void>;
  busy: { get(): boolean; set(busy: boolean): void };
  sealer: CardSealer;
  fetch?: typeof fetch;
  /** How long the local-server probe is reused. */
  probeTtlMs?: number;
  now?: () => number;
}

const fieldsSchema = z.object({
  baseUrl: z.string().max(512).optional(), resource: z.string().max(64).optional(), region: z.string().max(64).optional(),
  project: z.string().max(64).optional(), location: z.string().max(64).optional(), model: z.string().max(200).optional(),
}).strict();

const keyedSchema = z.object({
  provider: z.string().min(1).max(96),
  fields: fieldsSchema.optional(),
  key: z.string().max(4096).optional(),
}).strict();

const connectSchema = keyedSchema.extend({
  models: z.array(z.string().trim().min(1).max(200)).max(64).optional(),
  displayName: z.string().max(80).optional(),
}).strict();

const asInstances = (value: unknown): DescribedInstance[] =>
  Array.isArray(value) ? value.filter((entry): entry is DescribedInstance =>
    Boolean(entry) && typeof (entry as DescribedInstance).instanceId === "string" && typeof (entry as DescribedInstance).driverKind === "string") : [];

function publicProvider(def: ModelProviderDef) {
  const { hosts: _hosts, instances: _instances, driverKinds: _driverKinds, words: _words, ...shown } = def;
  return shown;
}

export function createModelProviderRoutes(deps: ModelProviderRouteDeps): RouteHandler {
  /** a pasted key and the model it is for, checked with one 1-token reply before they are saved: a key the provider
   *  refuses or a model it does not have is not saved; no credit, a busy or unreachable provider still saves */
  async function checkBeforeSave(def: ModelProviderDef, body: { key?: string; fields?: { model?: string }; models?: string[] }) {
    const key = body.key?.trim();
    if (!key || def.local || def.keyless) return null;
    const baseUrl = providerBaseUrl(def, body.fields);
    if (!baseUrl) return null;
    const model = body.fields?.model?.trim() || body.models?.[0]?.trim() || undefined;
    const listed = await listProviderModels({ def, baseUrl, key, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
    const catalog = deps.catalog.get();
    const fromCatalog = def.catalogId ? Object.keys(catalog.providers[def.catalogId]?.models ?? {}) : [];
    const found = await keyResult({ listed, wire: def.wire, baseUrl, key, ...(model ? { model } : {}), fallbackModels: fromCatalog, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
    if (found.result === "wrong_key") return { result: found.result, refusal: { error: `${def.label} did not accept this key. Copy it again from your ${def.label} account and paste it here.`, check: found.result } };
    if (found.result === "wrong_model") {
      const instead = found.suggestedModel ? ` Try ${found.suggestedModel}.` : "";
      return { result: found.result, refusal: { error: `${def.label} does not offer the model ${found.model}.${instead}`, check: found.result, ...(found.suggestedModel ? { suggestedModel: found.suggestedModel } : {}) } };
    }
    return { result: found.result, refusal: null };
  }
  const now = deps.now ?? Date.now;
  let probe: { at: number; running: Promise<Set<string>> } | undefined;
  const running = () => {
    if (!probe || now() - probe.at > (deps.probeTtlMs ?? 30_000)) {
      probe = { at: now(), running: probeLocalProviders(deps.place, deps.fetch) };
    }
    return probe.running;
  };

  const readBodyAs = async <T>(schema: z.ZodType<T>, ctx: Parameters<RouteHandler>[0], purpose: "list" | "connect") => {
    const { req, res, auth, json, readBody } = ctx;
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      json(res, 415, { error: "content-type must be application/json" });
      return null;
    }
    const raw = await readBody(req, 16 * 1024);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      json(res, 400, { error: "Send the provider and its details." });
      return null;
    }
    const provider = typeof (raw as { provider?: unknown }).provider === "string" ? (raw as { provider: string }).provider : "";
    const opened = await unsealFields(raw as Record<string, unknown>, { auth, sealer: deps.sealer, purpose: "model-provider", target: [provider], fields: ["key"] });
    if (!opened.ok) {
      json(res, opened.status, opened.body);
      return null;
    }
    const parsed = schema.safeParse(opened.body);
    if (!parsed.success) {
      json(res, 400, { error: purpose === "connect" ? "Check the provider, its details and the key." : "Check the provider and its details." });
      return null;
    }
    return parsed.data;
  };

  return async (ctx) => {
    const { res, url, path, method, json } = ctx;
    if (!path.startsWith("/api/model-providers")) return PASS;

    if (method === "GET" && path === "/api/model-providers") {
      const catalog = deps.catalog.get();
      void deps.catalog.refresh();
      const [found, described] = await Promise.all([running(), deps.describeInstances()]);
      const connected = connectedProviders(asInstances(described));
      const providers = MODEL_PROVIDERS.map((def) => ({
        ...publicProvider(def),
        ...providerOffer(def, deps.place, found),
        modelCount: def.catalogId ? Object.keys(catalog.providers[def.catalogId]?.models ?? {}).length : 0,
        connected: (connected.get(def.id) ?? []).map((instance) => instance.instanceId),
      }));
      const more = moreProviders(catalog).map((def) => ({ id: def.id, label: def.label,
        modelCount: Object.keys(catalog.providers[def.catalogId!]?.models ?? {}).length }));
      return json(res, 200, { place: deps.place, catalog: { origin: catalog.origin, updatedAt: catalog.updatedAt, ...catalogStats(catalog.providers) }, providers, more });
    }

    if (method === "GET" && path === "/api/model-providers/search") {
      const query = (url.searchParams.get("q") ?? "").slice(0, 120);
      const catalog = deps.catalog.get();
      void deps.catalog.refresh();
      const instances = asInstances(await deps.describeInstances());
      const index = new CatalogIndex(catalog);
      const own: SearchGroup[] = instances.filter((instance) => instanceReady(instance) && instance.models?.options?.length).map((instance) => {
        const def = providerOfInstance(instance);
        return {
          providerId: def?.id ?? instance.instanceId, label: instance.displayName ?? def?.label ?? instance.instanceId, connected: true,
          instanceId: instance.instanceId, words: def?.words ?? [],
          models: (instance.models!.options ?? []).map((option) => ({
            ...index.find(option.id, def?.catalogId), id: option.id, name: option.label || option.id,
          })),
        };
      });
      const connected = new Set(connectedProviders(instances).keys());
      const offered = await running();
      const rest = catalogGroups(catalog).filter((group) => {
        const def = resolveProvider(group.providerId, catalog);
        return !connected.has(group.providerId) && def !== undefined && providerOffer(def, deps.place, offered).offered;
      });
      return json(res, 200, { query, hits: searchModels([...own, ...rest], query, { perGroup: 8, maxGroups: 16 }) });
    }

    if (method === "POST" && path === "/api/model-providers/models") {
      const body = await readBodyAs(keyedSchema, ctx, "list");
      if (!body) return;
      const catalog = deps.catalog.get();
      const def = resolveProvider(body.provider, catalog);
      if (!def) return json(res, 404, { error: "Unknown provider." });
      const baseUrl = providerBaseUrl(def, body.fields);
      if (!baseUrl) return json(res, 400, { error: "Fill in the provider's details first." });
      const problem = addressProblem(baseUrl, deps.place);
      if (problem) return json(res, 400, { error: problem });
      const key = body.key?.trim() || undefined;
      const listed = await listProviderModels({ def, baseUrl, key, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
      const fromCatalog = def.catalogId ? Object.keys(catalog.providers[def.catalogId]?.models ?? {}) : [];
      const checked = key
        ? await keyResult({ listed, wire: def.wire, baseUrl, key, model: body.fields?.model, fallbackModels: fromCatalog, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
        : { result: listed.ok ? "works" as const : listed.reason === "rejected" ? "wrong_key" as const : "unreachable" as const };
      const { status: _probeStatus, ...found } = checked as typeof checked & { status?: number };
      res.setHeader("cache-control", "no-store");
      return json(res, 200, listed.ok
        ? { ok: true, models: listed.models.length ? listed.models : fromCatalog, source: listed.models.length ? "provider" : "catalog", ...found }
        : { ok: false, reason: listed.reason, ...(listed.status ? { status: listed.status } : {}), ...found });
    }

    if (method === "POST" && path === "/api/model-providers/connect") {
      const body = await readBodyAs(connectSchema, ctx, "connect");
      if (!body) return;
      const def = resolveProvider(body.provider, deps.catalog.get());
      if (!def) return json(res, 404, { error: "Unknown provider." });
      const built = buildConnection(def, body, deps.place);
      if ("error" in built) return json(res, 400, { error: built.error });
      const checked = await checkBeforeSave(def, body);
      if (checked?.refusal) return json(res, 400, checked.refusal);
      if (deps.busy.get()) return json(res, 409, { error: "provider settings are already being updated" });
      deps.busy.set(true);
      try {
        const instances = deps.instances();
        instances[built.instanceId] = built.entry;
        await deps.persistProviderInstance(built.instanceId, instances);
        return json(res, 201, { instanceId: built.instanceId, place: deps.place, instances: await deps.describeInstances(), ...(checked ? { check: checked.result } : {}) });
      } finally {
        deps.busy.set(false);
      }
    }
    return PASS;
  };
}
