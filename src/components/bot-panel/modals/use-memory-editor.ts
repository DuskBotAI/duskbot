import { useState } from "react";

import { t } from "@/lib/i18n";
import { deleteMemoryDoc, fetchMemoryDoc, MEMORY_INDEX, saveMemoryDoc, type MemoryDoc } from "@/lib/memory";
import type { Bot } from "@/state/store";
import { panelMemoryNotes, withMemoryNote, withoutMemoryNote, type PanelMemoryNote } from "../memory-notes";
import { useMemoryDoc } from "../use-memory-doc";
import { friendlyError } from "@/lib/plain-error";

function errorText(error: unknown, fallback: string): string {
  return friendlyError(error, fallback);
}

/** MEMORY.md's bullets, and on a Team Cloud the person's own notes. Every write goes through the memory file route with
 * the hash it was read at, so a note the bot added meanwhile is never lost: a conflict re-reads and asks again. */
export function useMemoryEditor(bot: Bot) {
  const memory = useMemoryDoc(bot);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const memoryOn = bot.memoryEnabled !== false;
  const notes = memory.docs ? panelMemoryNotes(memory.docs) : null;
  const index = memory.docs?.find((doc) => doc.path === MEMORY_INDEX) ?? null;

  const change = async (save: () => Promise<string | null>): Promise<string | null> => {
    if (saving) return t("botPanel.library.memoryError");
    setSaving(true);
    setError(null);
    try {
      return await save();
    } catch (cause) {
      const message = errorText(cause, t("botPanel.library.memoryError"));
      setError(message);
      return message;
    } finally {
      setSaving(false);
    }
  };
  const [forgotten, setForgotten] = useState<{ id: number; restore: () => Promise<void> } | null>(null);
  const write = (doc: MemoryDoc, text: string, onSaved?: (saved: MemoryDoc) => void) => change(async () => {
    const result = await saveMemoryDoc(bot.id, doc.path, text, doc.exists ? doc.hash : undefined, memory.mine);
    if (result.ok) {
      memory.setDoc(result.doc);
      onSaved?.(result.doc);
      return null;
    }
    await memory.reload();
    const message = t("memory.conflict.title", { name: bot.name });
    setError(message);
    return message;
  });
  // undo writes the old text back only over the exact version the forget left, so a note saved since is never lost
  const restoreOver = async (doc: MemoryDoc, expectedHash: string) => {
    const result = await saveMemoryDoc(bot.id, doc.path, doc.text, expectedHash, memory.mine);
    await memory.reload();
    if (!result.ok) throw new Error("memory changed since");
  };
  const forget = (note: PanelMemoryNote) => {
    const doc = memory.docs?.find((candidate) => candidate.path === note.path);
    if (!doc) return;
    const forgot = (restore: () => Promise<void>) => setForgotten((last) => ({ id: (last?.id ?? 0) + 1, restore }));
    if (note.line !== null) void write(doc, withoutMemoryNote(doc.text, note.line), (saved) => forgot(() => restoreOver(doc, saved.hash)));
    else void change(async () => {
      await deleteMemoryDoc(bot.id, doc.path, memory.mine);
      await memory.reload();
      forgot(async () => {
        const now = await fetchMemoryDoc(bot.id, doc.path, memory.mine);
        if (now.exists) throw new Error("memory changed since");
        await restoreOver(doc, now.hash);
      });
      return null;
    });
  };
  const add = async (text?: string): Promise<string | null> => {
    const value = text ?? draft;
    if (!index || !value.trim()) return null;
    const problem = await write(index, withMemoryNote(index.text, value));
    if (!problem) setDraft("");
    return problem;
  };

  const settleForgotten = () => setForgotten(null);
  return { memoryOn, readError: memory.error, notes, index, draft, setDraft, saving, error, forget, add, forgotten, settleForgotten };
}
