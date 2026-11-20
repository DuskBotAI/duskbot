import { existsSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { escapeAttribute } from "../src/lib/composer-attachments.ts";
import { ATTACHMENTS_DIR } from "./attachments.ts";
import type { TurnImageInput } from "./contracts.ts";
import { decodeAttachmentAttribute } from "./message-file.ts";
import type { Message } from "./store.ts";
import { extractTurnImages, TURN_IMAGE_MAX_BYTES, TURN_IMAGE_MAX_COUNT } from "./turn-images.ts";

type Quoted = { kind: "image" | "file"; path: string; name: string };

const TAG_LINE = /^[\t ]*<attached-(image|file)[\t ]+path="([^"\r\n]*)"(?:[\t ]+name="([^"\r\n]*)")?[\t ]*\/>[\t ]*$/gm;
const QUOTED_MAX = 10;

export const QUOTED_ATTACHMENTS_INTRO = "The quoted message's attachments, here again so you can look at them:";
const QUOTED_IMAGE_ATTACHED = "[A picture from the quoted message, attached to this message.]";
export const QUOTED_IMAGE_OVER_BUDGET = "[An image from the quoted message was left out: this message already carries as many images as one turn can.]";

function goneNote(item: Quoted): string {
  return `[The quoted message's ${item.kind === "image" ? "image" : "file"} "${item.name}" is no longer stored, so it can't be shown.]`;
}

/** What a quoted message carried: its own recorded attachments, and the attached-image and attached-file lines of a
 * person's message. Only uploads in the server's attachment store count; a tag naming any other path stays prose. */
export function quotedAttachments(target: Pick<Message, "role" | "text" | "attachments">, dir = ATTACHMENTS_DIR): Quoted[] {
  const store = resolve(dir);
  const found = new Map<string, Quoted>();
  for (const attachment of target.attachments ?? []) {
    if (attachment.kind !== "image" && attachment.kind !== "file") continue;
    found.set(resolve(attachment.path), { kind: attachment.kind, path: attachment.path, name: attachment.name ?? basename(attachment.path) });
  }
  if (target.role === "user" && target.text?.includes("<attached-")) {
    for (const match of target.text.matchAll(TAG_LINE)) {
      const path = decodeAttachmentAttribute(match[2]!);
      if (!path || path.includes("\0") || dirname(resolve(path)) !== store) continue;
      found.set(resolve(path), { kind: match[1] as Quoted["kind"], path, name: match[3] ? decodeAttachmentAttribute(match[3]) : basename(path) });
    }
  }
  return [...found.values()].slice(0, QUOTED_MAX);
}

function stored(path: string): boolean {
  try { return existsSync(path) && statSync(path).isFile(); } catch { return false; }
}

/** The lines a reply's turn carries for the quoted message's attachments: a tag per one still stored, which an engine
 * that reads pictures receives as an image and any other opens by its path, and a plain note per one that is gone. */
export function quotedAttachmentLines(target: Pick<Message, "role" | "text" | "attachments">, dir = ATTACHMENTS_DIR): string[] {
  const items = quotedAttachments(target, dir);
  if (!items.length) return [];
  return [QUOTED_ATTACHMENTS_INTRO, ...items.map((item) => stored(item.path)
    ? `<attached-${item.kind} path="${escapeAttribute(item.path)}" name="${escapeAttribute(item.name)}" />`
    : goneNote(item))];
}

/** The quoted pictures a turn's text names, as native image input within what is left of the turn's image budget
 * after `current`; any past it is replaced by a plain note. An engine that reads no pictures keeps the text as it is. */
export function withQuotedImages(
  text: string,
  current: readonly TurnImageInput[],
  native: boolean,
  options: { attachmentsDir?: string } = {},
): { text: string; images: TurnImageInput[] } {
  const lines = text.split("\n");
  const intro = lines.indexOf(QUOTED_ATTACHMENTS_INTRO);
  if (!native || intro < 0) return { text, images: [] };
  let count = TURN_IMAGE_MAX_COUNT - current.length;
  let bytes = TURN_IMAGE_MAX_BYTES - current.reduce((total, image) => total + image.bytes, 0);
  const images: TurnImageInput[] = [];
  for (let index = intro + 1; index < lines.length && /^(<attached-|\[)/.test(lines[index]!); index += 1) {
    const line = lines[index]!;
    if (!line.startsWith("<attached-image")) continue;
    const item = extractTurnImages(line, { attachmentsDir: options.attachmentsDir, maxCount: Infinity, maxBytes: Infinity });
    const image = item.images[0];
    if (!image) { lines[index] = item.text; continue; }
    if (count < 1 || image.bytes > bytes) { lines[index] = QUOTED_IMAGE_OVER_BUDGET; continue; }
    lines[index] = QUOTED_IMAGE_ATTACHED;
    images.push(image);
    count -= 1;
    bytes -= image.bytes;
  }
  return { text: lines.join("\n"), images };
}

/** The attachment lines for the message `replyToId` names in a conversation, set apart to follow a room's transcript. */
export function quotedAttachmentBlock(messages: readonly Message[], replyToId: string | undefined, dir = ATTACHMENTS_DIR): string {
  const target = replyToId ? messages.find((message) => message.id === replyToId) : undefined;
  const lines = target?.kind === "text" ? quotedAttachmentLines(target, dir) : [];
  return lines.length ? `\n\n${lines.join("\n")}` : "";
}
