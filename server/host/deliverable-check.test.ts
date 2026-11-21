import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../contracts.ts";
import { checkGaps, createDeliverableCheck, deliverableCheckNote, deliverableCheckPrompt, DELIVERABLE_TOOL } from "./deliverable-check.ts";
import { createFinishGuard } from "./finish-guard.ts";

type Body = RuntimeEvent extends infer E ? E extends RuntimeEvent ? Omit<E, "eventId" | "provider" | "threadId" | "createdAt"> : never : never;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function guarded(gaps: string[] | null) {
  const carried: string[] = [];
  const lines: unknown[] = [];
  const reviews: string[] = [];
  const guard = createFinishGuard({
    botOf: () => "bot-1", held: () => false, later: (run) => run(),
    carryOn: async (_botId, _threadId, note) => { carried.push(note); },
    line: (_threadId, reason) => lines.push(reason),
    review: async (_botId, threadId) => { reviews.push(threadId); return gaps; },
  });
  const send = (body: Body) => guard.onEvent({ eventId: "e", provider: "fake", threadId: "t1", createdAt: "", ...body } as RuntimeEvent);
  const turn = async (tool: string | null, text = "Your plan is ready.") => {
    send({ type: "turn.started" });
    if (tool) send({ type: "item.started", itemType: "tool", title: tool });
    send({ type: "item.completed", itemType: "assistant_text", text });
    send({ type: "turn.completed", ok: true });
    await flush();
  };
  return { carried, lines, reviews, turn };
}

describe("deliverable check", () => {
  it("reads a FAIL's gaps, at most three, and treats anything else as a pass", () => {
    expect(checkGaps("FAIL\n- The table has 5 rows, they asked for 7.\n2) No total.")).toEqual(["The table has 5 rows, they asked for 7.", "No total."]);
    expect(checkGaps("FAIL: a\nb\nc\nd")).toEqual(["a", "b", "c"]);
    expect(checkGaps("PASS")).toBeNull();
    expect(checkGaps("Looks fine overall.")).toBeNull();
    expect(checkGaps("FAIL")).toBeNull();
  });

  it("knows the tools that hand the person a thing", () => {
    for (const tool of ["create_document", "mcp__dusk-agents__update_document", "publish_page", "data_export", "agents_attach_file"]) expect(DELIVERABLE_TOOL.test(tool)).toBe(true);
    for (const tool of ["web_search", "read_document", "memory_update"]) expect(DELIVERABLE_TOOL.test(tool)).toBe(false);
  });

  it("fences the ask and the work as data, and its note never surfaces", () => {
    const prompt = deliverableCheckPrompt("7 Goa bookings in a table", "Here it is.", [{ title: "Goa", content: "| a |" }]);
    expect(prompt).toContain("<ask>\n7 Goa bookings in a table\n</ask>");
    expect(prompt).toContain('<document title="Goa">');
    const note = deliverableCheckNote(["Only 5 of 7 bookings."]);
    expect(note).toContain("1) Only 5 of 7 bookings.");
    expect(note).toContain("Never mention this check");
    expect(note).toContain("reply with just (pass)");
  });

  it("skips quietly when the call fails or there is no ask", async () => {
    const failing = createDeliverableCheck({ ask: () => "make a plan", documents: () => [], text: () => ({ via: "engine", generateText: async () => { throw new Error("busy"); } }) });
    expect(await failing("b", "t", { said: ["Done."], startedAt: 0 })).toBeNull();
    const noAsk = createDeliverableCheck({ ask: () => null, documents: () => [], text: () => ({ via: "engine", generateText: async () => "FAIL\nx" }) });
    expect(await noAsk("b", "t", { said: ["Done."], startedAt: 0 })).toBeNull();
  });

  it("sends a deliverable with gaps back once per message of the person's, with no visible line, and leaves plain chat alone", async () => {
    const failing = guarded(["Only 5 of 7 bookings."]);
    await failing.turn("create_document");
    expect(failing.reviews).toEqual(["t1"]);
    expect(failing.carried).toHaveLength(1);
    expect(failing.carried[0]).toContain("Only 5 of 7 bookings.");
    expect(failing.lines).toEqual([]);
    await failing.turn("update_document", "Added the last two.");
    expect(failing.reviews).toHaveLength(1);

    const passing = guarded(null);
    await passing.turn("create_document");
    expect(passing.carried).toEqual([]);

    const chat = guarded(["anything"]);
    await chat.turn(null, "Hey! Quiet morning.");
    expect(chat.reviews).toEqual([]);
  });
});
