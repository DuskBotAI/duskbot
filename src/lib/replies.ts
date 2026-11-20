import type { Message } from "@/state/store";
import { t } from "./i18n";
import { peerLine } from "./peer-message";
import { withoutCitationMarkers } from "./citations";
import { attachmentImageUrl, splitTranscriptAttachments } from "./composer-attachments";

export function replySnippet(text: string, limit = 160): string {
  const clean = withoutCitationMarkers(text)
    .replace(
      /<attached-(image|file)\s+path="[^"]*"(?:\s+name="[^"]*")?\s*\/>/g,
      (_tag, kind: "image" | "file") => (kind === "image" ? t("chat.reply.image") : t("chat.reply.file")),
    )
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, "$1")
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, "$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}
/** The first picture a quoted message shows, as a same-origin URL: its own image attachment or a person's attached image. */
export function replyThumbnail(message: Pick<Message, "role" | "text" | "attachments">): string | null {
  const path = message.attachments?.find((attachment) => attachment.kind === "image")?.path
    ?? (message.role === "user" && message.text?.includes("<attached-image") ? splitTranscriptAttachments(message.text).images[0]?.path : undefined);
  return path ? attachmentImageUrl(path) : null;
}

export function replyAuthor(message: Message, fallback?: string): string {
  if (message.role === "user") return peerLine(message)?.name ?? t("chat.you");
  return message.from?.name ?? fallback ?? t("chat.assistant");
}

export function escapeCancelsReply(
  event: { key: string; isComposing?: boolean },
  { replying, recording }: { replying: boolean; recording: boolean },
): boolean {
  return event.key === "Escape" && replying && !recording && !event.isComposing;
}
