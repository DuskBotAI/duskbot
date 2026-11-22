// Guards against internal runtime harness notifications leaking into user-facing
// assistant responses. When background tasks or subagents finish, ACP runtimes
// (like Google Antigravity or Anthropic harness) inject notifications into the model
// context using <SYSTEM_MESSAGE> wrappers. Confused or echoing models can sometimes
// regurgitate these blocks into the assistant message stream.

const PREAMBLE_REGEX = /^(?:The following is a|Notice: This is a)\s*<SYSTEM_(?:MESSAGE|NOTIFICATION)>[^\n]*\n?/gim;
const SYSTEM_TAG_BLOCK_REGEX = /(?:(?:The following is a|Notice: This is a)\s*<SYSTEM_(?:MESSAGE|NOTIFICATION)>[^\n]*\n*)?<SYSTEM_(?:MESSAGE|NOTIFICATION)>[\s\S]*?<\/SYSTEM_(?:MESSAGE|NOTIFICATION)>/gi;
const UNCLOSED_SYSTEM_TAG_REGEX = /(?:(?:The following is a|Notice: This is a)\s*<SYSTEM_(?:MESSAGE|NOTIFICATION)>[^\n]*\n*)?<SYSTEM_(?:MESSAGE|NOTIFICATION)>[\s\S]*$/gi;
const ORPHANED_TAG_REGEX = /<\/?SYSTEM_(?:MESSAGE|NOTIFICATION)>/gi;

function stripSystemHarnessBlocks(text: string): string {
  let result = text.replace(SYSTEM_TAG_BLOCK_REGEX, "");
  result = result.replace(PREAMBLE_REGEX, "");
  result = result.replace(UNCLOSED_SYSTEM_TAG_REGEX, "");
  result = result.replace(ORPHANED_TAG_REGEX, "");
  return result;
}

/** Strips leaked harness system messages and prompt injection preambles from text. */
export function stripLeakedSystemHarnessMessages(text: string | null | undefined): string {
  if (!text || typeof text !== "string") return "";
  return stripSystemHarnessBlocks(text).trim();
}

/** Returns true if the message text consists entirely of leaked system harness messages. */
export function isPureLeakedSystemHarnessMessage(text: string | null | undefined): boolean {
  if (!text || typeof text !== "string") return false;
  const hasMarkers = /<SYSTEM_(?:MESSAGE|NOTIFICATION)>/i.test(text)
    || /(?:The following is a|Notice: This is a)\s*<SYSTEM_/i.test(text);
  if (!hasMarkers) return false;
  return stripLeakedSystemHarnessMessages(text).length === 0;
}

const STREAM_TAG_TARGETS = [
  "<system_message>",
  "<system_notification>",
  "</system_message>",
  "</system_notification>",
] as const;

const STREAM_PREAMBLE_TARGETS = [
  "the following is a <system_message>",
  "the following is a <system_notification>",
  "notice: this is a <system_message>",
  "notice: this is a <system_notification>",
] as const;

function partialHarnessLeakTailLength(text: string): number {
  const lineStart = text.lastIndexOf("\n") + 1;
  const line = text.slice(lineStart);
  if (line.length > 0) {
    const normalized = line.toLowerCase().replace(/^(the following is a|notice: this is a)[ \t]+/, "$1 ");
    if (STREAM_PREAMBLE_TARGETS.some((target) => target.startsWith(normalized))) {
      return line.length;
    }
  }
  const tagStart = text.lastIndexOf("<");
  if (tagStart >= 0) {
    const tail = text.slice(tagStart);
    if (tail.length <= 22) {
      const lower = tail.toLowerCase();
      if (STREAM_TAG_TARGETS.some((target) => target.startsWith(lower))) {
        return tail.length;
      }
    }
  }
  return 0;
}

/** Filters streamed assistant chunks so leaked harness markers never flash in live deltas,
 * including case variants, `Notice:` preambles, mid-reply leaks, and chunk-split tags. */
export function createSystemHarnessStreamFilter(): { push(delta: string): string; reset(): void } {
  let raw = "";
  let emitted = "";
  return {
    push(delta: string): string {
      if (!delta) return "";
      raw += delta;
      const cleaned = stripSystemHarnessBlocks(raw);
      const safe = cleaned.slice(0, cleaned.length - partialHarnessLeakTailLength(cleaned));
      const next = safe.startsWith(emitted) ? safe.slice(emitted.length) : "";
      emitted = safe;
      if (cleaned === raw) {
        const cut = safe.lastIndexOf("\n") + 1;
        if (cut > 0) {
          raw = raw.slice(cut);
          emitted = safe.slice(cut);
        }
      }
      return next;
    },
    reset(): void {
      raw = "";
      emitted = "";
    },
  };
}

// the one-line recap server/digest.ts gives a bot of its earlier turns; a model may copy it into its reply
const TURN_RECAP_REGEX = /[ \t]*\[What [^\]\n]{1,80} did in an earlier turn:(?:[^\n]*\](?=\s|$)|[^\n]*$)[ \t]*\n?/gm;

/** A bot's reply as a person sees it: no leaked harness messages and no copied earlier-turn recaps. */
export function botTextForDisplay(text: string | null | undefined): string {
  return stripLeakedSystemHarnessMessages(text).replace(TURN_RECAP_REGEX, "").trim();
}

/** True when nothing of a bot's reply is left to show once leaked harness messages and recaps are taken out. */
export function isPureLeakedBotText(text: string | null | undefined): boolean {
  if (!text || typeof text !== "string") return false;
  return (isPureLeakedSystemHarnessMessage(text) || / did in an earlier turn:/.test(text)) && botTextForDisplay(text).length === 0;
}
