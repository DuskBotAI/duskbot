// One post by id through X's documented oEmbed endpoint (publish.x.com/oembed): author and the embed's HTML, from which
// the text and the day it was posted are read. No counts. publish.twitter.com answers with a redirect here.
import { isRow, X_MESSAGES, XResearchError, type XPostWithReplies } from "../x-research.ts";
import { htmlText, httpGet, parseJson, type HttpOptions } from "./http.ts";
import { XSkip, type PostInput, type XProvider } from "./types.ts";

export const OEMBED_URL = "https://publish.x.com/oembed";
const HANDLE_IN_URL = /^https:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?:[/?]|$)/;

/** The embed's text paragraph and its closing date link ("November 20, 2026"). */
export function readEmbed(html: string): { text: string; day?: string } {
  const paragraph = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(html)?.[1] ?? "";
  const links = [...html.matchAll(/<a\b[^>]*>([^<]*)<\/a>/gi)];
  const last = links.at(-1)?.[1]?.trim();
  const when = last ? new Date(`${last} UTC`) : null;
  return { text: htmlText(paragraph), ...(when && !Number.isNaN(when.getTime()) ? { day: when.toISOString() } : {}) };
}

export function createOembedProvider(options: HttpOptions = {}): XProvider {
  return {
    id: "oembed",
    emptyIsAnswer: false,
    async post(input: PostInput): Promise<XPostWithReplies> {
      if (input.replies) throw new XSkip("not_for_this");
      const target = `https://twitter.com/${input.handle ?? "i"}/status/${input.id}`;
      const answer = await httpGet(`${OEMBED_URL}?url=${encodeURIComponent(target)}&omit_script=1&dnt=true`, { ...options, headers: { accept: "application/json" }, follow: true });
      if (answer.status === 404 || answer.status === 403) throw new XResearchError("not_found", X_MESSAGES.postNotFound);
      if (answer.status !== 200) throw new XResearchError("unavailable", X_MESSAGES.unavailable);
      const body = parseJson(answer.text);
      if (!isRow(body) || typeof body.html !== "string") throw new XResearchError("unavailable", X_MESSAGES.unavailable);
      const handle = typeof body.author_url === "string" ? HANDLE_IN_URL.exec(body.author_url)?.[1] : undefined;
      const { text, day } = readEmbed(body.html);
      return {
        post: {
          id: input.id,
          url: `https://x.com/${handle ?? "i"}/status/${input.id}`,
          author: handle ? `@${handle}` : "@unknown",
          ...(typeof body.author_name === "string" && body.author_name ? { authorName: body.author_name } : {}),
          ...(day ? { createdAt: day } : {}),
          text,
        },
      };
    },
  };
}
