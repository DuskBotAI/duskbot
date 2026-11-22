// The first bot's note after a bring-in (shared/import-note.ts), in the words of the conversation's language.
import { importNoteSchema, type ImportNoteFacts } from "../shared/import-note.ts";
import { serverLine, type ServerLineKey } from "./server-lines.ts";

const MAX_NAMED = 8;

/** A few short lines; null when nothing came in and nothing needs saying. */
export function importNoteText(input: ImportNoteFacts, language?: string): string | null {
  const facts = importNoteSchema.parse(input);
  const say = (key: ServerLineKey, params?: Record<string, string | number>) => serverLine(language, key, params);
  if (facts.start) return say("server.importNote.start");
  const cut = facts.partial ? [say("server.importNote.partial")] : [];
  const counted = (n: number, one: ServerLineKey, many: ServerLineKey) => (n === 1 ? say(one) : say(many, { count: n }));
  let and: (items: string[]) => string;
  try {
    const format = new Intl.ListFormat(language ?? "en", { style: "long", type: "conjunction" });
    and = (items) => format.format(items);
  } catch {
    and = (items) => items.join(", ");
  }
  const lines: string[] = [];
  if (facts.bots.length) {
    const named = facts.bots.slice(0, MAX_NAMED);
    const more = facts.bots.length - named.length;
    const names = and(more > 0 ? [...named, say("server.importNote.more", { count: more })] : named);
    lines.push(facts.bots.length === 1 ? say("server.importNote.botOne", { names }) : say("server.importNote.bots", { count: facts.bots.length, names }));
  }
  if (facts.joined) lines.push(counted(facts.joined, "server.importNote.joinedOne", "server.importNote.joined"));
  if (facts.facts) lines.push(counted(facts.facts, "server.importNote.factsOne", "server.importNote.facts"));
  if (facts.aboutInMemory) lines.push(counted(facts.aboutInMemory, "server.importNote.aboutInMemoryOne", "server.importNote.aboutInMemory"));
  if (facts.memories) lines.push(counted(facts.memories, "server.importNote.memoriesOne", "server.importNote.memories"));
  if (facts.threads) lines.push(counted(facts.threads, "server.importNote.threadsOne", "server.importNote.threads"));
  if (facts.instructions.length) lines.push(say("server.importNote.instructions", { apps: and(facts.instructions) }));
  if (facts.skills) lines.push(counted(facts.skills, "server.importNote.skillsOne", "server.importNote.skills"));
  if (facts.tools) lines.push(counted(facts.tools, "server.importNote.toolsOne", "server.importNote.tools"));
  if (!lines.length) {
    if (!facts.nothingNew) return null;
    return [facts.failed ? say("server.importNote.failed") : say("server.importNote.nothingNew", { apps: and(facts.from) }), ...cut].join(" ");
  }
  const after = [
    ...(facts.routines ? [counted(facts.routines, "server.importNote.routinesOne", "server.importNote.routines")] : []),
    ...(facts.reconnect ? [counted(facts.reconnect, "server.importNote.reconnectOne", "server.importNote.reconnect")] : []),
    ...(facts.failed ? [say("server.importNote.failed")] : []),
    ...cut,
    say("server.importNote.ask"),
  ];
  return [say(facts.via === "downloads" ? "server.importNote.leadDownloads" : "server.importNote.lead", { apps: and(facts.from) }), ...lines.map((line) => `- ${line}`), "", after.join(" ")].join("\n");
}
