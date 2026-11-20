// Whether a pasted key will run turns, from one cheap provider call after its model list: a 1-token reply.
// Security: the key goes only to the address the caller already vetted, never follows a redirect, and neither the key
// nor the provider's error body is logged or returned; the body is only read for its kind.
import { failedReplyReason } from "./failed-reply-reason.ts";
import { checkProviderKey, providerBaseUrl, type ProviderKeyKind, type ProviderKeyVerdict } from "./provider-key-check.ts";

/** The one plain answer the apps show under a key field. `busy`: the key works but the provider is rate limiting it. */
export type KeyCheckResult = "works" | "busy" | "wrong_key" | "no_credit" | "wrong_model" | "unreachable";

export type ChatWire = "openai" | "anthropic";

/** What POST /api/keys/test answers: the catalog check's verdict, then `result`, the probed `model` and, when the
 * person's model is not offered, `suggestedModel` from the provider's own list. Never the key. */
export type KeyVerdict = (
  | Extract<ProviderKeyVerdict, { ok: true }>
  | { ok: false; reason: Extract<ProviderKeyVerdict, { ok: false }>["reason"] | "credits" | "model"; status?: number; models?: string[] }
) & { result: KeyCheckResult; model?: string; suggestedModel?: string };

const PROBE_TIMEOUT_MS = 8_000;
const BODY_CHARS = 2_000;
const SHOWN_MODELS = 5;
const NOT_CHAT = /embed|tts|whisper|transcri|audio|realtime|image|dall-e|moderation|guard|rerank|search|computer-use|codex|deep-research|instruct|babbage|davinci|sora|veo|imagen|lyria|aqa|ocr/i;
const SMALL = /mini|nano|small|haiku|flash|instant|lite|\b8b\b/i;
/** Google's Gemini API answers a wrong key with 400 INVALID_ARGUMENT "API key not valid". */
const KEY_REFUSED = /\bapi key not valid\b|\binvalid api key\b|\bincorrect api key\b/i;

export function chatModels(ids: readonly string[]): string[] {
  return ids.map((id) => id.replace(/^models\//, "")).filter((id) => !NOT_CHAT.test(id));
}

/** A model to spend one token on when the person named none: a small chat model from the provider's own list. */
export function probeModel(listed: readonly string[]): string | undefined {
  const chat = chatModels(listed);
  return chat.find((id) => SMALL.test(id)) ?? chat[0];
}

/** The model to offer instead of one the provider does not have: the closest name in its list, else a chat model. */
export function suggestModel(listed: readonly string[], wanted: string): string | undefined {
  const chat = chatModels(listed);
  const stem = wanted.toLowerCase().replace(/^models\//, "").split("/").at(-1)!.replace(/[-.:@]?(latest|preview|\d{6,8})$/, "");
  const family = stem.split(/[-.:]/)[0] ?? "";
  return chat.find((id) => id.toLowerCase().includes(stem)) ?? (family ? chat.find((id) => id.toLowerCase().includes(family)) : undefined) ?? chat[0];
}

/** What a refused 1-token request says about the key. `chosen`: the person named the model, so its absence is theirs to fix;
 * any other model's absence or a request shape the provider turns down still proves the key. */
export function probeVerdict(status: number, body: string, chosen: boolean): KeyCheckResult {
  const text = body.slice(0, BODY_CHARS);
  if (status === 401 || KEY_REFUSED.test(text)) return "wrong_key";
  if (status === 403 && /\bmodel/i.test(text)) return chosen ? "wrong_model" : "works";
  switch (failedReplyReason(`upstream HTTP ${status}: ${text}`, {})) {
    case "signed_out": return "wrong_key";
    case "credits": case "usage_limit": return "no_credit";
    case "model_not_found": return chosen ? "wrong_model" : "works";
    case "rate_limit": case "overloaded": return "busy";
    case "provider_down": case "timeout": return "unreachable";
    default: return status >= 500 ? "unreachable" : "works";
  }
}

export interface ProbeInput {
  wire: ChatWire;
  baseUrl: string;
  key: string;
  model: string;
  chosen: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

function probeRequest({ wire, baseUrl, key, model }: ProbeInput): { url: string; headers: Record<string, string>; body: unknown } {
  const base = baseUrl.replace(/\/+$/, "");
  const messages = [{ role: "user", content: "Say ok." }];
  if (wire === "anthropic") {
    const official = /^https:\/\/api\.anthropic\.com(?:\/|$)/.test(base);
    return {
      url: `${base.replace(/\/v1$/, "")}/v1/messages`,
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", ...(official ? {} : { authorization: `Bearer ${key}` }) },
      body: { model, max_tokens: 1, messages },
    };
  }
  // OpenAI's own API refuses max_tokens for its reasoning models.
  const openAi = /^https:\/\/api\.openai\.com(?:\/|$)/.test(base);
  return {
    url: `${base}/chat/completions`,
    headers: { authorization: `Bearer ${key}` },
    body: { model, messages, stream: false, ...(openAi ? { max_completion_tokens: 1 } : { max_tokens: 1 }) },
  };
}

/** One 1-token request with `model`. A request that never got an answer is `unreachable`. */
export async function probeChat(input: ProbeInput): Promise<{ result: KeyCheckResult; status?: number }> {
  const { url, headers, body } = probeRequest(input);
  try {
    const response = await (input.fetch ?? fetch)(url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(input.timeoutMs ?? PROBE_TIMEOUT_MS),
    });
    if (response.ok) {
      void response.body?.cancel().catch(() => {});
      return { result: "works" };
    }
    if (response.status >= 300 && response.status < 400) return { result: "unreachable", status: response.status };
    const text = await response.text().catch(() => "");
    return { result: probeVerdict(response.status, text, input.chosen), status: response.status };
  } catch {
    return { result: "unreachable" };
  }
}

export interface ListedKey {
  /** The model list's own answer: `rejected` is a wrong key, `unexpected` a list the provider does not serve. */
  listed: { ok: true; models: string[] } | { ok: false; reason: string; status?: number };
  wire: ChatWire;
  baseUrl: string;
  key: string;
  /** The model the person named. */
  model?: string;
  /** Models to try when the provider lists none, such as the catalog's. */
  fallbackModels?: readonly string[];
  /** The list already proved the key and no model was named (OpenRouter's /key): spend nothing more. */
  proven?: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** The plain answer for a key whose model list was read: the list's refusal, else a 1-token reply. */
export async function keyResult(input: ListedKey): Promise<{ result: KeyCheckResult; model?: string; suggestedModel?: string; status?: number }> {
  const { listed } = input;
  if (!listed.ok) {
    if (listed.reason === "rejected") return { result: "wrong_key", ...(listed.status ? { status: listed.status } : {}) };
    if (listed.status === 402) return { result: "no_credit", status: 402 };
    if (listed.reason !== "unexpected" || (!input.model && !input.fallbackModels?.length)) return { result: "unreachable", ...(listed.status ? { status: listed.status } : {}) };
  }
  const models = listed.ok && listed.models.length ? listed.models : [...(input.fallbackModels ?? [])];
  const chosen = input.model?.trim() || undefined;
  if (!chosen && input.proven) return { result: "works" };
  const model = chosen ?? probeModel(models);
  if (!model) return { result: listed.ok ? "works" : "unreachable" };
  const probed = await probeChat({ wire: input.wire, baseUrl: input.baseUrl, key: input.key, model, chosen: Boolean(chosen), fetch: input.fetch, timeoutMs: input.timeoutMs });
  const suggestedModel = probed.result === "wrong_model" ? suggestModel(models.filter((id) => id !== model), model) : undefined;
  return { ...probed, model, ...(suggestedModel ? { suggestedModel } : {}) };
}

const CATALOG_LIMIT = 2_000;

/** A named provider's key (Settings > API keys, a custom OpenAI-compatible server): its catalog check, then one 1-token reply. */
export async function verifyProviderKey(
  input: { provider: ProviderKeyKind; key: string; url?: string | null; model?: string },
  fetchImpl: typeof fetch = fetch,
  timeoutMs?: number,
): Promise<KeyVerdict> {
  const verdict = await checkProviderKey({ ...input, modelLimit: CATALOG_LIMIT }, fetchImpl, timeoutMs);
  if (!verdict.ok && verdict.reason === "address") return { ...verdict, result: "unreachable" };
  const found = await keyResult({
    listed: verdict.ok ? { ok: true, models: verdict.models } : verdict,
    wire: input.provider === "anthropic" ? "anthropic" : "openai",
    baseUrl: providerBaseUrl(input.provider, input.url),
    key: input.key,
    ...(input.model ? { model: input.model } : {}),
    proven: verdict.ok && verdict.check === "authentication",
    fetch: fetchImpl,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  const shown = (verdict.ok ? verdict.models : []).map((id) => id.replace(/^models\//, "")).slice(0, SHOWN_MODELS);
  const extra = { ...(found.model ? { model: found.model } : {}), ...(found.suggestedModel ? { suggestedModel: found.suggestedModel } : {}) };
  if (found.result === "works" || found.result === "busy") {
    return verdict.ok ? { ...verdict, models: shown, result: found.result, ...extra } : { ok: true, check: "models", models: [], result: found.result, ...extra };
  }
  if (found.result === "unreachable" && !verdict.ok) return { ...verdict, result: "unreachable", ...extra };
  const reason = found.result === "wrong_key" ? "rejected" : found.result === "no_credit" ? "credits" : found.result === "wrong_model" ? "model" : "unexpected";
  const status = found.status ?? (verdict.ok ? undefined : verdict.status);
  return { ok: false, reason, ...(status ? { status } : {}), ...(shown.length ? { models: shown } : {}), result: found.result, ...extra };
}
