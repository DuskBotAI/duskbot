// xAI API driver over the OpenAI chat-completions contract, with the shared retry policy.
import type { ModelCatalog, ProviderDriver } from "../contracts.ts";
import { requireHttpsOrLoopback } from "../provider-key-check.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";
import { xaiEffortLevels } from "./api-effort.ts";

const DRIVER_KIND = "grok";
const DEFAULT_URL = "https://api.x.ai/v1";
const MODELS = {
  default: "grok-4.7",
  options: [
    { id: "grok-4.7", label: "Grok 4.7", contextWindow: 500_000 },
    { id: "grok-4", label: "Grok 4" },
    { id: "grok-4-fast", label: "Grok 4 Fast" },
    { id: "grok-3-mini", label: "Grok 3 Mini" },
  ],
};

const NOT_CHAT = /image|imagine|video|embed|tts|voice|audio/;

/** xAI's GET /models for this key, chat models only, in xAI's order; null when it lists none. */
export function grokModelsFrom(body: unknown): ModelCatalog | null {
  const rows = Array.isArray((body as { data?: unknown })?.data) ? (body as { data: unknown[] }).data : [];
  const options: ModelCatalog["options"] = [];
  for (const row of rows) {
    const id = (row as { id?: unknown })?.id;
    if (typeof id !== "string" || !/^grok-[\w.-]{1,80}$/.test(id) || NOT_CHAT.test(id) || options.some((option) => option.id === id)) continue;
    const known = MODELS.options.find((option) => option.id === id);
    options.push(known ? { ...known } : { id, label: id });
  }
  if (!options.length) return null;
  return { default: options.some((option) => option.id === MODELS.default) ? MODELS.default : options[0]!.id, options };
}

export interface GrokConfig {
  tools?: boolean;
  url: string;
  apiKeyEnv: string;
}

function decodeConfig(raw: unknown): GrokConfig {
  const config = (raw ?? {}) as Record<string, unknown>;
  if (config.tools !== undefined && typeof config.tools !== "boolean") throw new Error("tools must be a boolean");
  const url = typeof config.url === "string" ? config.url : DEFAULT_URL;
  requireHttpsOrLoopback(url, "Grok");
  return {
    ...(config.tools !== undefined ? { tools: config.tools as boolean } : {}),
    url,
    apiKeyEnv: typeof config.apiKeyEnv === "string" ? config.apiKeyEnv : "XAI_API_KEY",
  };
}

export const GrokDriver: ProviderDriver<GrokConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Grok (API)", supportsMultipleInstances: true },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input) {
    const { config } = input;
    const apiKey = input.environment[config.apiKeyEnv] ?? process.env[config.apiKeyEnv] ?? "";
    let catalog: ModelCatalog = MODELS;
    const refreshModels = async () => {
      if (!apiKey) return;
      try {
        const response = await fetch(`${config.url.replace(/\/+$/, "")}/models`, {
          headers: { authorization: `Bearer ${apiKey}` }, redirect: "error", signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) { void response.body?.cancel().catch(() => {}); return; }
        catalog = grokModelsFrom(await response.json()) ?? catalog;
      } catch {}
    };
    void refreshModels();
    const runtime = createOpenAIChatRuntime({
      input,
      driverKind: DRIVER_KIND,
      apiKey,
      apiUrl: config.url,
      tools: config.tools,
      computerUse: true, imageInput: (model) => /^grok-(?:4|2-vision)/i.test(model) && !/code/i.test(model),
      models: () => catalog,
      refreshModels,
      effort: { levels: ["low", "medium", "high", "xhigh"], forModel: xaiEffortLevels },
      requestBody: (model, messages, stream) => ({ model, messages, stream }),
      httpErrorLabel: "xAI",
      missingKeyError: `Save an xAI API key in Settings → API keys, or set ${config.apiKeyEnv}.`,
      unavailableReason: "No xAI API key: open Settings → API keys.",
      timeoutMs: 120_000,
      retryScale: Number(process.env.FAKE_GROK_RETRY_SCALE ?? "1"),
      generateModel: () => "grok-3-mini",
      nativeLog: {
        source: "xai.chat.completions",
        outgoing: (_turn, messages, model) => ({ model, messageCount: messages.length }),
        incoming: ({ text, usage }) => ({ text, usage }),
      },
    });
    return Object.assign(runtime, { modelCatalogKey: DRIVER_KIND });
  },
};
