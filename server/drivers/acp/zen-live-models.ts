// OpenCode Zen's own list of the models it serves now (https://opencode.ai/zen/v1/models, public, checked 2026-11-21:
// `data[].id`, `type`, `cost.text.{input,output}.price`). OpenCode's bundled catalog keeps models Zen has retired, so a
// free fallback ladder built from it alone steps through models that only answer "no longer available".
const ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
/** How long a read list is trusted before it is read again. */
export const ZEN_LIST_TTL_MS = 30 * 60_000;
const READ_TIMEOUT_MS = 8_000;

interface ZenList { at: number; chat: Set<string>; free: Set<string> }

let list: ZenList | null = null;
let reading: Promise<void> | null = null;

/** The bare Zen id of an OpenCode model id ("opencode/big-pickle" → "big-pickle"); null for another provider's. */
export function zenId(model: string): string | null {
  return model.startsWith("opencode/") ? model.slice("opencode/".length) : null;
}

export function parseZenModels(body: unknown, at: number): ZenList | null {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const chat = new Set<string>(), free = new Set<string>();
  for (const entry of data as Array<Record<string, any>>) {
    if (typeof entry?.id !== "string" || (entry.type !== undefined && entry.type !== "chat")) continue;
    chat.add(entry.id);
    const text = entry.cost?.text;
    if (text?.input?.price === 0 && text?.output?.price === 0) free.add(entry.id);
  }
  return chat.size ? { at, chat, free } : null;
}

/** Reads the list again when it is older than ZEN_LIST_TTL_MS; never throws, and a failed read keeps the last list. */
export function refreshZenModels(fetchImpl: typeof fetch = fetch, now = Date.now(), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // DUSK_ZEN_LIVE_MODELS=0: tests and offline fixtures never reach the network
  if (env.DUSK_ZEN_LIVE_MODELS === "0" || (list && now - list.at < ZEN_LIST_TTL_MS)) return Promise.resolve();
  reading ??= (async () => {
    try {
      const response = await fetchImpl(ZEN_MODELS_URL, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
      if (!response.ok) return;
      list = parseZenModels(await response.json(), now) ?? list;
    } catch {
      // offline or Zen down: the ladder goes by the catalog until a read works
    } finally {
      reading = null;
    }
  })();
  return reading;
}

/** Whether Zen still serves this OpenCode model: true when no list was read yet or the model is another provider's. */
export function zenServes(model: string): boolean {
  const id = zenId(model);
  return !list || id === null || list.chat.has(id);
}

/** Zen's free chat models now, as OpenCode ids, or null before a list was read. */
export function zenFreeModels(): string[] | null {
  return list ? [...list.free].map((id) => `opencode/${id}`) : null;
}

export function resetZenModelsForTests(value: ZenList | null = null): void {
  list = value;
  reading = null;
}
