import { MAX_GENERATED_IMAGE_CHARS } from "../generated-image.ts";

/** One stream frame may carry a few generated images whole, as base64. */
export const MAX_STREAM_FRAME_CHARS = 4 * MAX_GENERATED_IMAGE_CHARS + 1_000_000;

/** An image-model reply's pictures: OpenRouter's `images` beside the text, or `image_url` parts of the content. */
export function completionImages(part: { content?: unknown; images?: unknown } | undefined): string[] {
  const urls: string[] = [];
  for (const list of [part?.images, Array.isArray(part?.content) ? part.content : undefined]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const url = (item as { image_url?: { url?: unknown } } | null)?.image_url?.url;
      if (typeof url === "string" && url.startsWith("data:image/")) urls.push(url);
    }
  }
  return urls;
}
