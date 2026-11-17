import { describe, expect, it } from "vitest";

import { endTurn, isAcpToolFinished, trackRunningTool, type AcpTurn } from "./turn-state.ts";

const ERROR_BODY = '403 {"type":"error","error":{"type":"permission_error","message":"OAuth authentication is currently not allowed for this organization."}}';

/** A turn whose buffered text is `text`, flushed as core.ts does: a non-blank text becomes a reply. */
function turnWith(text: string, state: { stopped?: boolean; replied?: string } = {}) {
  const replies: string[] = [];
  const current = {
    state: { text: state.replied ?? "", stopped: false, producedItem: false, repliedText: false },
    flushAssistantText() {
      const said = current.state.text;
      current.state.text = "";
      if (!said.trim()) return;
      current.state.producedItem = true;
      current.state.repliedText = true;
      replies.push(said);
    },
  };
  if (state.replied) current.flushAssistantText();
  current.state.text = text;
  current.state.stopped = state.stopped ?? false;
  return { current: current as unknown as AcpTurn, replies };
}

describe("endTurn on a reply that is a provider's error body", () => {
  it("after the person's Stop, ends the turn as stopped and keeps what was said", () => {
    const { current, replies } = turnWith(ERROR_BODY, { stopped: true });
    expect(endTurn(current, true, null, "omp")).toEqual({ ok: true, stopReason: "cancelled" });
    expect(replies).toEqual([ERROR_BODY]);
  });

  it("keeps the body a reply when the turn already replied in words before it", () => {
    const { current, replies } = turnWith(ERROR_BODY, { replied: "Let me check the deploy." });
    expect(endTurn(current, true, null, "omp")).toEqual({ ok: true, stopReason: null });
    expect(replies).toEqual(["Let me check the deploy.", ERROR_BODY]);
  });
});

describe("isAcpToolFinished", () => {
  it("treats terminal status as finished", () => {
    expect(isAcpToolFinished({ status: "completed" })).toBe(true);
    expect(isAcpToolFinished({ status: "failed" })).toBe(true);
  });

  it("treats in_progress and pending status as not finished", () => {
    expect(isAcpToolFinished({ status: "in_progress" })).toBe(false);
    expect(isAcpToolFinished({ status: "pending" })).toBe(false);
    expect(isAcpToolFinished({ status: "in_progress", rawOutput: "output" })).toBe(false);
  });

  it("treats updates with rawOutput as finished even when status is omitted", () => {
    expect(isAcpToolFinished({ rawOutput: { output: "ok" } })).toBe(true);
    expect(isAcpToolFinished({ rawOutput: "done" })).toBe(true);
  });

  it("treats updates with non-diff content as finished", () => {
    expect(isAcpToolFinished({ content: [{ type: "image", data: "..." }] })).toBe(true);
  });

  it("treats updates with streaming diff content as not finished", () => {
    expect(isAcpToolFinished({ content: [{ type: "diff", path: "a.ts" }] })).toBe(false);
  });
});

describe("trackRunningTool", () => {
  it("clears tool from runningTools when update delivers rawOutput without status", () => {
    const turn = { runningTools: new Set(["call-1"]) } as unknown as AcpTurn;
    trackRunningTool(turn, { toolCallId: "call-1", rawOutput: { result: "ok" } });
    expect(turn.runningTools.has("call-1")).toBe(false);
  });

  it("adds pending tool to runningTools when tool_call has no status or output", () => {
    const turn = { runningTools: new Set<string>() } as unknown as AcpTurn;
    trackRunningTool(turn, { toolCallId: "call-2" }, "pending");
    expect(turn.runningTools.has("call-2")).toBe(true);
  });
});
