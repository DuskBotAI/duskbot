import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTO_APPROVAL_REASONS, autoApprovalChip, isAutoApprovalChip } from "../shared/auto-approval.ts";
import { threadPreviewRows } from "./message-db-rows.ts";
import type { Message } from "./store.ts";

const databases: DatabaseSync[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const database of databases.splice(0)) database.close(); });

function fixture(messages: Array<Partial<Message> & { id: string }>, activeLeafId = messages.at(-1)?.id ?? null) {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("CREATE TABLE messages(thread_id TEXT, id TEXT, role TEXT, kind TEXT, json TEXT, PRIMARY KEY(thread_id, id)); CREATE TABLE thread_state(thread_id TEXT PRIMARY KEY, active_leaf_id TEXT)");
  const insert = database.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?)");
  for (const [index, fields] of messages.entries()) {
    const message = { role: "bot", kind: "text", at: index, parentId: index ? messages[index - 1]!.id : null, ...fields };
    insert.run("thread", message.id, message.role, message.kind, JSON.stringify(message));
  }
  database.prepare("INSERT INTO thread_state VALUES (?, ?)").run("thread", activeLeafId);
  return (limit = 200) => threadPreviewRows(database, "thread", limit);
}

describe("bounded sidebar database rows", () => {
  it("skips trailing screen frames and receipts without parsing their large payloads", () => {
    const preview = fixture([
      { id: "person", role: "user", text: "Draw a map" }, { id: "reply", text: "The map is ready." },
      ...Array.from({ length: 80 }, (_, index) => ({ id: `frame-${index}`, kind: "screen" as const, png: "x".repeat(20_000) })),
      { id: "receipt", kind: "digest", text: "receipt" },
    ]);
    const parse = vi.spyOn(JSON, "parse");
    expect(preview().map((message) => message.id)).toEqual(["person", "reply"]);
    expect(parse).toHaveBeenCalledTimes(3);
  });

  it("skips a trailing auto-approval chip of every reason, the same chips the sidebar skips", () => {
    for (const reason of AUTO_APPROVAL_REASONS) {
      const chip = `${autoApprovalChip("Bash", reason)}: ls -la`;
      expect(isAutoApprovalChip(chip), reason).toBe(true);
      const preview = fixture([
        { id: "person", role: "user", text: "List the files" }, { id: "reply", text: "Here they are." },
        { id: "chip", kind: "activity", tool: { name: chip, ok: true } },
      ]);
      expect(preview().map((message) => message.id), reason).toEqual(["person", "reply"]);
    }
    const step = fixture([
      { id: "person", role: "user", text: "List the files" }, { id: "reply", text: "Here they are." },
      { id: "step", kind: "activity", tool: { name: "Read", ok: true } },
    ]);
    expect(step().map((message) => message.id)).toContain("step");
    expect(isAutoApprovalChip("Read")).toBe(false);
  });

  it("keeps the newest open question, bot quote and user barrier in at most four rows", () => {
    const preview = fixture([
      { id: "person", role: "user", text: "Plan my trip" },
      { id: "question", kind: "options", card: { title: "Question", subtitle: "Which folder?", options: [], requestId: "request" } as Message["card"] },
      { id: "reply", text: "The plan is ready." },
      { id: "closed", kind: "options", card: { title: "Old question", subtitle: "Already answered", options: [], requestId: "closed", answered: "yes" } as Message["card"] },
      { id: "step", kind: "activity", tool: { name: "Read", ok: true } },
    ]);
    expect(preview().map((message) => message.id)).toEqual(["person", "question", "closed", "step"]);
    expect(preview()).toHaveLength(4);
  });

  it("does not quote an older reply or another branch after a newer user message", () => {
    const preview = fixture([
      { id: "old", text: "Older reply" }, { id: "person", role: "user", text: "Do another thing" },
      { id: "step", kind: "activity", tool: { name: "Read", ok: true } },
      { id: "other", text: "An unrelated branch", parentId: "old" },
    ], "step");
    expect(preview().map((message) => message.id)).toEqual(["person", "step"]);
  });

  it("infers legacy parent links and never reads beyond the requested page", () => {
    const preview = fixture([
      { id: "old", text: "Older text", parentId: undefined },
      { id: "reply", text: "Newest text", parentId: undefined },
      { id: "screen", kind: "screen", parentId: undefined },
      { id: "receipt", kind: "digest", parentId: undefined },
    ]);
    expect(preview().map((message) => message.id)).toEqual(["reply"]);
    expect(preview(2)).toEqual([]);
    expect(preview(0)).toEqual([]);
  });
});
