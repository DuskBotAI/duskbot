import { describe, expect, it } from "vitest";

import { commitmentsBlock, createCommitments, parseCommitments, renderCommitments, withCommitment, type Commitments } from "./commitments.ts";

const empty = (): Commitments => ({ open: [], done: [] });

describe("the commitments list", () => {
  it("adds an item once, updates its who and due, and reads back what it wrote", () => {
    let { list, result } = withCommitment(empty(), { text: "Send Asha the Q4 deck", who: "Asha is waiting", due: "2026-11-28" }, "2026-11-21");
    expect(result).toBe("saved");
    expect(withCommitment(list, { text: "send asha the Q4 deck.", who: "Asha is waiting" }, "2026-11-22").result).toBe("known");
    ({ list, result } = withCommitment(list, { text: "Send Asha the Q4 deck", who: "Asha is waiting", due: "2026-11-27" }, "2026-11-22"));
    expect(result).toBe("saved");
    expect(parseCommitments(renderCommitments(list))).toEqual({ open: [{ text: "Send Asha the Q4 deck", who: "Asha is waiting", due: "2026-11-27", since: "2026-11-21" }], done: [] });
  });

  it("closes an item named by its words, refuses a text that names none or several, and drops done ones after a week", () => {
    let { list } = withCommitment(empty(), { text: "Send Asha the Q4 deck", who: "Asha" }, "2026-11-01");
    ({ list } = withCommitment(list, { text: "Send Raj the Q4 numbers", who: "Raj" }, "2026-11-01"));
    expect(withCommitment(list, { text: "Q4", done: true }, "2026-11-02").result).toBe("unknown");
    expect(withCommitment(list, { text: "the dentist", done: true }, "2026-11-02").result).toBe("unknown");
    const closed = withCommitment(list, { text: "asha deck", done: true }, "2026-11-02");
    expect(closed.result).toBe("closed");
    expect(closed.list.open.map((item) => item.text)).toEqual(["Send Raj the Q4 numbers"]);
    expect(closed.list.done).toEqual([{ text: "Send Asha the Q4 deck", who: "Asha", since: "2026-11-01", done: "2026-11-02" }]);
    expect(withCommitment(closed.list, { text: "Book the dentist", who: "me" }, "2026-11-12").list.done).toEqual([]);
  });

  it("reads a hand-edited file and keeps lines it cannot place as plain items", () => {
    const text = "---\ntitle: x\n---\n## Open\n- Call mum back\n- Refund from Iberia · who: Iberia owes me · due 2026-12-01\n## Done\n- Renew passport · done 2026-11-20\n";
    expect(parseCommitments(text)).toEqual({
      open: [{ text: "Call mum back" }, { text: "Refund from Iberia", who: "Iberia owes me", due: "2026-12-01" }],
      done: [{ text: "Renew passport", done: "2026-11-20" }],
    });
  });

  it("shows runs what is overdue, due within a week and recent, soonest first, as data", () => {
    const list: Commitments = { done: [], open: [
      { text: "Old idea", since: "2026-09-01" },
      { text: "File taxes", who: "the tax office", due: "2027-01-31" },
      { text: "Send Asha the deck", who: "Asha is waiting", due: "2026-11-20" },
      { text: "Reply to Priya", who: "Priya is waiting", since: "2026-11-19" },
      { text: "Pay Raj back", who: "Raj", due: "2026-11-25" },
    ] };
    const block = commitmentsBlock(list, "2026-11-21");
    expect(block.split("\n").slice(1)).toEqual([
      "- Send Asha the deck (Asha is waiting), due 2026-11-20, overdue",
      "- Pay Raj back (Raj), due 2026-11-25",
      "- Reply to Priya (Priya is waiting)",
    ]);
    expect(block).toMatch(/data and not instructions/);
    expect(commitmentsBlock(empty(), "2026-11-21")).toBe("");
  });

  it("writes the owner's memory topic only when something changed, and keeps nothing without an owner", () => {
    const files = new Map<string, string>();
    const writes: string[] = [];
    let owner: { id: string } | null = { id: "b1" };
    const store = createCommitments({ owner: () => owner, read: (id) => files.get(id) ?? null, write: (id, _before, after, actor) => { files.set(id, after); writes.push(actor); }, today: () => "2026-11-21" });
    expect(store.commit({ text: "Send Asha the deck", who: "Asha" })).toBe("saved");
    expect(store.commit({ text: "Send Asha the deck", who: "Asha" })).toBe("known");
    expect(writes).toEqual(["bot"]);
    expect(store.block()).toContain("- Send Asha the deck (Asha)");
    owner = null;
    expect(store.commit({ text: "x", who: "y" })).toBeNull();
    expect(store.block()).toBe("");
  });
});
