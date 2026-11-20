import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { MESSENGER_PLATFORMS, type MessengerPlatform } from "../../shared/messengers.ts";
import { writeFileAtomic } from "../atomic.ts";
import { decryptBrowserState, encryptBrowserState } from "../browser-sites.ts";
import type { SavedSecretsKey } from "../saved-secrets.ts";

export const MESSENGER_SECRETS_FILE = "messenger-secrets.json.enc";

const id = z.string().min(1).max(64);
const allowedSchema = z.strictObject({ id, kind: z.enum(["person", "chat"]), name: z.string().max(200).optional() });
const linkSchema = z.strictObject({
  botId: z.string().min(1).max(128),
  platform: z.enum(MESSENGER_PLATFORMS),
  token: z.string().min(10).max(400),
  account: z.strictObject({ id, username: z.string().max(100), name: z.string().max(200), appId: id.optional() }),
  pairCode: z.string().max(32).optional(),
  pairMisses: z.number().int().min(0).optional(),
  owner: allowedSchema.optional(),
  allowed: z.array(allowedSchema).max(200),
  /** Telegram's secret_token for this bot's webhook. */
  webhookSecret: z.string().max(256).optional(),
  connectedAt: z.number(),
});
const fileSchema = z.strictObject({ version: z.literal(1), links: z.array(linkSchema).max(400) });
export type MessengerLink = z.infer<typeof linkSchema>;
export type MessengerAllowedEntry = z.infer<typeof allowedSchema>;
type StoreFile = z.infer<typeof fileSchema>;
const empty = (): StoreFile => ({ version: 1, links: [] });

export class MessengerSecretsUnavailable extends Error {
  constructor() {
    super("Chat app settings are not ready on this computer yet. Try again in a moment.");
    this.name = "MessengerSecretsUnavailable";
  }
}

export class MessengerSecretStore {
  private readonly file: string;
  private readonly key: SavedSecretsKey;
  private cache: StoreFile | null = null;

  constructor(options: { dataDir: string; key: SavedSecretsKey }) {
    this.file = join(options.dataDir, MESSENGER_SECRETS_FILE);
    this.key = options.key;
  }

  private keyValue(): string | null {
    try { return this.key.get(); } catch { return null; }
  }

  ready(): boolean {
    return this.keyValue() !== null;
  }

  private read(): StoreFile {
    if (this.cache) return this.cache;
    const key = this.keyValue();
    if (key === null) return empty();
    let data = empty();
    if (existsSync(this.file)) {
      try {
        data = fileSchema.parse(JSON.parse(decryptBrowserState(readFileSync(this.file), key)));
      } catch {
        try { renameSync(this.file, `${this.file}.unreadable-${Date.now()}`); } catch {}
        console.warn("Chat apps: the saved tokens file could not be opened; it was set aside and a new one started.");
      }
    }
    this.cache = data;
    return data;
  }

  private write(data: StoreFile): void {
    const key = this.keyValue();
    if (key === null) throw new MessengerSecretsUnavailable();
    const parsed = fileSchema.parse(data);
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, encryptBrowserState(JSON.stringify(parsed), key), { mode: 0o600 });
    this.cache = parsed;
  }

  link(botId: string, platform: MessengerPlatform): MessengerLink | null {
    return structuredClone(this.read().links.find((one) => one.botId === botId && one.platform === platform) ?? null);
  }

  links(): MessengerLink[] {
    return structuredClone(this.read().links);
  }

  put(link: MessengerLink): void {
    const data = this.read();
    this.write({ ...data, links: [...data.links.filter((one) => one.botId !== link.botId || one.platform !== link.platform), link] });
  }

  patch(botId: string, platform: MessengerPlatform, patch: Partial<MessengerLink>): MessengerLink | null {
    const current = this.link(botId, platform);
    if (!current) return null;
    const next = { ...current, ...patch } as MessengerLink;
    for (const key of Object.keys(next) as (keyof MessengerLink)[]) if (next[key] === undefined) delete next[key];
    this.put(next);
    return structuredClone(next);
  }

  remove(botId: string, platform?: MessengerPlatform): MessengerLink[] {
    const data = this.read();
    const gone = data.links.filter((one) => one.botId === botId && (!platform || one.platform === platform));
    if (gone.length) this.write({ ...data, links: data.links.filter((one) => !gone.includes(one)) });
    return gone;
  }

  secretValues(): string[] {
    return this.read().links.flatMap((one) => [one.token, one.webhookSecret]).filter((value): value is string => typeof value === "string");
  }
}
