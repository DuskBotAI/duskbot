import type { GlassAttachment, GlassReply } from "./native-glass";

export type ThumbCache = { src: string; data: string | null };

export function canNativeAttachments(strip: Element): boolean {
  if (strip.querySelector("[role='status']")) return false;
  const items = [...strip.querySelectorAll("[data-composer-attachment]")];
  return items.length > 0 && items.every((item) => item.getAttribute("data-attachment-kind") === "image");
}

/** A strip inside the pill above its row (selection quote, file/paste attachments, or reply/images without native support): only the page draws those. */
export function hasStrips(shell: Element, allowReply = false, allowAttachments = false): boolean {
  const row = shell.querySelector("[data-composer-row]");
  const content = row?.parentElement;
  return Boolean(content && [...content.children].some((child) =>
    child !== row &&
    !(allowReply && child.matches("[data-composer-reply]")) &&
    !(allowAttachments && child.matches("[data-composer-strip]") && canNativeAttachments(child)) &&
    child.getBoundingClientRect().height > 0,
  ));
}

function rasterSquareThumbnail(img: HTMLImageElement, size: number, cache: ThumbCache): { data: string | null; pending: boolean } {
  const src = img.currentSrc || img.src;
  if (!src) return { data: null, pending: false };
  if (cache.src === src && cache.data !== null) return { data: cache.data, pending: false };
  if (!img.complete || !img.naturalWidth || !img.naturalHeight) return { data: null, pending: true };
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { data: null, pending: false };
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  const sx = (img.naturalWidth - side) / 2;
  const sy = (img.naturalHeight - side) / 2;
  try {
    ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
    const data = canvas.toDataURL("image/png");
    cache.src = src;
    cache.data = data;
    return { data, pending: false };
  } catch {
    cache.src = src;
    cache.data = null;
    return { data: null, pending: false };
  }
}

export function readReply(shell: Element, thumbCache: ThumbCache): { reply: GlassReply; pending: boolean } | null {
  const strip = shell.querySelector<HTMLElement>("[data-composer-reply]");
  if (!strip || strip.getBoundingClientRect().height === 0) return null;
  const excerpt = strip.querySelector<HTMLElement>("[data-reply-excerpt], [dir='auto']")?.textContent?.trim() ?? "";
  const clear = strip.querySelector("button");
  const img = strip.querySelector<HTMLImageElement>("[data-reply-thumbnail]");
  const thumb = img ? rasterSquareThumbnail(img, 72, thumbCache) : { data: null, pending: false };
  return {
    reply: {
      text: excerpt,
      label: strip.getAttribute("aria-label") ?? "",
      clearLabel: clear?.getAttribute("aria-label") ?? "",
      ...(thumb.data ? { thumbnail: thumb.data } : {}),
    },
    pending: thumb.pending,
  };
}

export function readAttachments(shell: Element, cache: Map<string, ThumbCache>): { attachments: GlassAttachment[]; pending: boolean } | null {
  const strip = shell.querySelector<HTMLElement>("[data-composer-strip]");
  if (!strip || strip.getBoundingClientRect().height === 0 || !canNativeAttachments(strip)) {
    if (cache.size > 0) cache.clear();
    return null;
  }
  const items = [...strip.querySelectorAll<HTMLElement>("[data-composer-attachment]")];
  const seen = new Set<string>();
  const attachments: GlassAttachment[] = [];
  let pending = false;
  for (const item of items) {
    const id = item.getAttribute("data-attachment-id") ?? "";
    if (!id) continue;
    seen.add(id);
    let entry = cache.get(id);
    if (!entry) {
      entry = { src: "", data: null };
      cache.set(id, entry);
    }
    const img = item.querySelector<HTMLImageElement>("img");
    const thumb = img ? rasterSquareThumbnail(img, 168, entry) : { data: null, pending: false };
    if (thumb.pending) pending = true;
    const uploading = item.getAttribute("aria-busy") === "true";
    const failed = item.hasAttribute("data-attachment-failed");
    const retry = item.querySelector<HTMLElement>("[data-attachment-action='retry']");
    const remove = item.querySelector<HTMLElement>("[data-attachment-action='remove']");
    attachments.push({
      id,
      label: item.getAttribute("aria-label") ?? "",
      removeLabel: remove?.getAttribute("aria-label") ?? "",
      ...(thumb.data ? { thumbnail: thumb.data } : {}),
      ...(uploading ? { uploading: true } : {}),
      ...(failed ? { failed: true, retryLabel: retry?.getAttribute("aria-label") ?? "" } : {}),
    });
  }
  for (const key of cache.keys()) {
    if (!seen.has(key)) cache.delete(key);
  }
  return attachments.length > 0 ? { attachments, pending } : null;
}
