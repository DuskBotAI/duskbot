// Link previews for chat: what a page says about itself, kept in memory and in the data folder's cache, with its image
// fetched and served by this server so the app's CSP stays 'self' and no site sees the reader's address.
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { LINK_PREVIEW_IMAGE_PATH, type LinkPreview } from "../../shared/link-preview.ts";
import { writeFileAtomic } from "../atomic.ts";
import { MAX_IMAGE_BYTES, sniffImage } from "./image.ts";
import { cleanText, declaredCharset, EMPTY_META, isThin, LIMITS, mergeMeta, parseOembed, parsePageMeta, tidyTitle, type PageMeta } from "./meta.ts";
import { fetchableUrl, guardedGet, type GuardedGetDeps } from "./net.ts";
import { sitePlan, UNFURL_USER_AGENT } from "./sites.ts";

export const PREVIEW_TTL_MS = 12 * 3600e3;
/** A page that answered with nothing, or did not answer, is asked again sooner. */
export const EMPTY_TTL_MS = 15 * 60e3;
export const IMAGE_TTL_MS = 7 * 864e5;
const PRUNE_EVERY_MS = 6 * 3600e3;
const MEMORY_ENTRIES = 500;
const PAGE_BYTES = 1024 * 1024, JSON_BYTES = 512 * 1024;
const DEADLINE_MS = 10_000;
const URL_MAX = 2048;
const IMAGE_ID = /^[a-f0-9]{32}$/;

export interface LinkPreviews {
  /** Null only for something that is not an http(s) address; anything else gets a preview, at worst an empty one. */
  get(raw: unknown): Promise<LinkPreview | null>;
  image(id: string): Promise<{ type: string; body: Buffer } | null>;
}

interface Entry { at: number; ok: boolean; preview: LinkPreview }

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);

/** The address a preview is kept under: http(s), no fragment, no credentials. */
export function normalizeLinkUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || !raw.trim() || raw.length > URL_MAX) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  return url;
}

export function emptyPreview(url: URL): LinkPreview {
  return { url: url.href, title: null, description: null, siteName: null, image: null, video: false };
}

const isHtml = (type: string) => /^(?:text\/html|application\/xhtml\+xml)\b/.test(type);
const isImage = (type: string) => /^image\/(?:png|jpe?g|gif|webp)\b/.test(type);
const isJson = (type: string) => /^(?:application\/(?:[\w.+-]+\+)?json|text\/json|text\/javascript)\b/.test(type);

function decodeHtml(body: Buffer, type: string): string {
  const label = /charset\s*=\s*["']?([\w:.-]+)/i.exec(type)?.[1] ?? declaredCharset(body.subarray(0, 4096).toString("latin1")) ?? "utf-8";
  try {
    return new TextDecoder(label).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

function fileTitle(url: URL): string | null {
  const name = url.pathname.split("/").filter(Boolean).pop() ?? "";
  try {
    return cleanText(decodeURIComponent(name), LIMITS.TITLE_MAX);
  } catch {
    return cleanText(name, LIMITS.TITLE_MAX);
  }
}

export function createLinkPreviews({ dir, net = {}, now = Date.now }: { dir: string; net?: GuardedGetDeps; now?: () => number }): LinkPreviews {
  const memory = new Map<string, Entry>();
  const running = new Map<string, Promise<LinkPreview>>();
  const imageSources = new Map<string, string>();
  const imagesRunning = new Map<string, Promise<{ type: string; body: Buffer } | null>>();
  const pagesDir = join(dir, "pages"), imagesDir = join(dir, "images");
  let lastPrune = 0;
  const MAX_BUILDING = 6;
  let building = 0;
  const waiting: Array<() => void> = [];
  const gated = async <T>(run: () => Promise<T>): Promise<T> => {
    if (building >= MAX_BUILDING) await new Promise<void>((admit) => waiting.push(admit));
    building += 1;
    try { return await run(); }
    finally {
      building -= 1;
      waiting.shift()?.();
    }
  };

  const remember = (key: string, entry: Entry) => {
    memory.delete(key);
    memory.set(key, entry);
    if (memory.size > MEMORY_ENTRIES) memory.delete(memory.keys().next().value!);
  };
  const fresh = (entry: Entry) => now() - entry.at < (entry.ok ? PREVIEW_TTL_MS : EMPTY_TTL_MS);
  const write = (path: string, data: string | Buffer) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileAtomic(path, data, { durable: false });
    } catch {
      // an unwritable cache only costs a refetch
    }
  };

  async function fetchJson(url: string, userAgent: string, signal: AbortSignal): Promise<{ json: unknown; base: URL } | null> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return null;
    }
    const got = await guardedGet(target, { limit: JSON_BYTES, partial: false, accept: isJson, headers: { accept: "application/json", "user-agent": userAgent }, signal }, net);
    if (!got.ok) return null;
    try {
      return { json: JSON.parse(got.body.toString("utf8")), base: got.url };
    } catch {
      return null;
    }
  }

  function registerImage(url: string): string {
    const id = hash(`image:${url}`);
    if (!imageSources.has(id)) {
      imageSources.set(id, url);
      if (imageSources.size > MEMORY_ENTRIES * 2) imageSources.delete(imageSources.keys().next().value!);
      write(join(imagesDir, `${id}.src`), url);
    }
    return id;
  }

  async function build(url: URL): Promise<Entry> {
    const signal = AbortSignal.timeout(DEADLINE_MS);
    const plan = sitePlan(url);
    const userAgent = plan.userAgent ?? UNFURL_USER_AGENT;
    const fromSources = Promise.all(plan.sources.map(async (source) => {
      const got = await fetchJson(source.url, UNFURL_USER_AGENT, signal).catch(() => null);
      return got ? source.read(got.json, got.base) : EMPTY_META;
    }));
    const fromPage = plan.page
      ? guardedGet(url, {
        limit: PAGE_BYTES, partial: true,
        accept: (type) => isHtml(type) || isImage(type),
        headers: { accept: "text/html,application/xhtml+xml;q=0.9,image/*;q=0.5", "accept-language": "en;q=0.9,*;q=0.5", "user-agent": userAgent },
        signal,
      }, net).catch(() => null)
      : Promise.resolve(null);
    const [sourceMetas, page] = await Promise.all([fromSources, fromPage]);
    let finalUrl = url;
    let meta = sourceMetas.reduce(mergeMeta, EMPTY_META);
    if (page?.ok) {
      finalUrl = page.url;
      // a link straight to a picture is its own preview
      const pageMeta: PageMeta = isImage(page.type)
        ? { ...EMPTY_META, title: fileTitle(page.url), image: { url: page.url.href, width: null, height: null } }
        : parsePageMeta(decodeHtml(page.body, page.type), page.url);
      meta = mergeMeta(meta, pageMeta);
    }
    if (isThin(meta) && meta.oembed) {
      const got = await fetchJson(meta.oembed, userAgent, signal).catch(() => null);
      if (got) meta = mergeMeta(meta, parseOembed(got.json, got.base));
    }
    meta = plan.finish(meta);
    const host = finalUrl.hostname.replace(/^www\./, "");
    const title = tidyTitle(meta.title, host);
    const image = meta.image && fetchableUrl(new URL(meta.image.url)) ? meta.image : null;
    const preview: LinkPreview = {
      url: finalUrl.href,
      title,
      description: meta.description && meta.description !== title ? meta.description : null,
      siteName: meta.siteName,
      image: image ? { src: `${LINK_PREVIEW_IMAGE_PATH}${registerImage(image.url)}`, width: image.width, height: image.height } : null,
      video: meta.video,
    };
    return { at: now(), ok: Boolean(preview.title || preview.image || preview.description), preview };
  }

  async function prune() {
    if (now() - lastPrune < PRUNE_EVERY_MS) return;
    lastPrune = now();
    for (const [folder, age] of [[pagesDir, PREVIEW_TTL_MS * 2], [imagesDir, IMAGE_TTL_MS]] as const) {
      const names = await readdir(folder).catch(() => [] as string[]);
      for (const name of names) {
        const path = join(folder, name);
        const info = await stat(path).catch(() => null);
        if (info && now() - info.mtimeMs > age) await rm(path, { force: true }).catch(() => undefined);
      }
    }
  }

  async function load(url: URL): Promise<LinkPreview> {
    const key = hash(url.href);
    const kept = memory.get(key);
    if (kept && fresh(kept)) return kept.preview;
    const file = join(pagesDir, `${key}.json`);
    const disk = await readFile(file, "utf8").then((text) => JSON.parse(text) as Entry).catch(() => null);
    if (disk && typeof disk.at === "number" && disk.preview && fresh(disk)) {
      remember(key, disk);
      return disk.preview;
    }
    const entry = await build(url).catch(() => ({ at: now(), ok: false, preview: emptyPreview(url) }));
    remember(key, entry);
    write(file, JSON.stringify(entry));
    void prune().catch(() => undefined);
    // warm the image so the card's picture is ready when it asks
    const imageId = entry.preview.image?.src.slice(LINK_PREVIEW_IMAGE_PATH.length);
    if (imageId) void image(imageId).catch(() => null);
    return entry.preview;
  }

  async function loadImage(id: string): Promise<{ type: string; body: Buffer } | null> {
    const bodyFile = join(imagesDir, `${id}.img`);
    const kept = await stat(bodyFile).catch(() => null);
    if (kept && now() - kept.mtimeMs < IMAGE_TTL_MS) {
      const body = await readFile(bodyFile).catch(() => null);
      const sniffed = body ? sniffImage(body) : null;
      if (body && sniffed) return { type: sniffed.type, body };
    }
    const source = imageSources.get(id) ?? await readFile(join(imagesDir, `${id}.src`), "utf8").catch(() => null);
    if (!source || hash(`image:${source}`) !== id) return null;
    const got = await guardedGet(new URL(source), {
      limit: MAX_IMAGE_BYTES, partial: false, accept: isImage,
      headers: { accept: "image/webp,image/png,image/jpeg,image/gif;q=0.9", "user-agent": UNFURL_USER_AGENT },
      signal: AbortSignal.timeout(DEADLINE_MS),
    }, net).catch(() => null);
    const sniffed = got?.ok ? sniffImage(got.body) : null;
    if (!got?.ok || !sniffed) return null;
    write(bodyFile, got.body);
    return { type: sniffed.type, body: got.body };
  }

  function image(id: string) {
    if (!IMAGE_ID.test(id)) return Promise.resolve(null);
    let pending = imagesRunning.get(id);
    if (!pending) {
      pending = gated(() => loadImage(id)).finally(() => imagesRunning.delete(id));
      imagesRunning.set(id, pending);
    }
    return pending;
  }

  return {
    get(raw) {
      const url = normalizeLinkUrl(raw);
      if (!url) return Promise.resolve(null);
      if (!fetchableUrl(url)) return Promise.resolve(emptyPreview(url));
      let pending = running.get(url.href);
      if (!pending) {
        pending = gated(() => load(url)).finally(() => running.delete(url.href));
        running.set(url.href, pending);
      }
      return pending;
    },
    image,
  };
}
