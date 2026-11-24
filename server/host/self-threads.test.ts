import { describe, expect, it, vi } from "vitest";
import type { Coordinator, HandoffView } from "../coordinator.ts";
import { openSelfThread, SELF_THREAD_REFUSAL, selfThreadRefusal } from "./self-threads.ts";

describe("selfThreadRefusal", () => {
  it("lets a person's own request, or a routine's, open threads on the bot", () => {
    expect(selfThreadRefusal({ handoff: false, requestLine: {} })).toBeUndefined();
    expect(selfThreadRefusal({ handoff: false, requestLine: undefined })).toBeUndefined();
  });

  it("refuses a teammate's hand-off, and a thread the bot opened on itself", () => {
    expect(selfThreadRefusal({ handoff: true, requestLine: {} })).toBe(SELF_THREAD_REFUSAL);
    expect(selfThreadRefusal({ handoff: false, requestLine: { peerAsk: { botId: "post" } } })).toBe(SELF_THREAD_REFUSAL);
  });
});

function fakeCoordinator(overrides: Partial<Coordinator> = {}): Coordinator {
  return {
    node: vi.fn(() => ({ id: "root-1", botId: "bot-1", threadId: "thread-root" } as HandoffView)),
    enqueue: vi.fn(() => ({ node: { id: "job-1", parentId: "root-1", botId: "bot-1", threadId: "thread-job", selfJob: true } as HandoffView, duplicate: false })),
    ...overrides,
  } as unknown as Coordinator;
}

describe("openSelfThread", () => {
  const base = () => ({
    bot: { id: "bot-1", name: "Books", color: "#000" },
    fromThreadId: "thread-root",
    generation: "root-1",
    title: "Ledger A",
    message: "Check ledger A",
    sourceTitle: "Main",
    inRoom: false,
    external: false,
    reportBack: true,
    handoff: false,
    requestLine: {},
    coordinator: fakeCoordinator(),
    createTask: () => ({ threadId: "thread-job", title: "Ledger A" }),
    deleteTask: vi.fn(),
    recordOpened: vi.fn(),
    onSelfJobEnqueued: vi.fn(),
    startDetached: vi.fn(async () => ({ state: "running" })),
    childLimit: () => 3,
    botLimit: () => 2,
  });

  it("enqueues a reporting selfJob on root direct turns", async () => {
    const input = base();
    const result = await openSelfThread(input);
    expect(result).toEqual({
      status: 201,
      body: {
        threadId: "thread-job",
        title: "Ledger A",
        botId: "bot-1",
        botName: "Books",
        self: true,
        reportBack: true,
        assignmentId: "job-1",
        limit: 3,
      },
    });
    expect(input.coordinator.enqueue).toHaveBeenCalledWith(
      { threadId: "thread-root", botId: "bot-1" },
      "root-1",
      undefined,
      { threadId: "thread-job", botId: "bot-1" },
      "Check ledger A",
      { mode: "work", reply: "resume", thread: "new", selfJob: true },
    );
    expect(input.recordOpened).toHaveBeenCalledTimes(1);
    expect(input.onSelfJobEnqueued).toHaveBeenCalledTimes(1);
    expect(input.startDetached).not.toHaveBeenCalled();
  });

  it("deletes the created thread and returns 409 when enqueue refuses", async () => {
    const input = base();
    input.coordinator = fakeCoordinator({
      enqueue: vi.fn(() => { throw new Error("budget exceeded"); }),
    });
    expect(await openSelfThread(input)).toEqual({ status: 409, body: { error: "budget exceeded" } });
    expect(input.deleteTask).toHaveBeenCalledWith("thread-job");
    expect(input.recordOpened).not.toHaveBeenCalled();
  });

  it("starts a detached thread when reportBack is false, in a room, or on an external runtime", async () => {
    for (const patch of [{ reportBack: false }, { inRoom: true }, { external: true }]) {
      const input = { ...base(), ...patch };
      const result = await openSelfThread(input);
      expect(result.status).toBe(201);
      expect(result.body).toMatchObject({ threadId: "thread-job", self: true, state: "running", limit: 2 });
      expect(result.body.reportBack).toBeUndefined();
      expect(input.coordinator.enqueue).not.toHaveBeenCalled();
      expect(input.startDetached).toHaveBeenCalledTimes(1);
    }
  });

  it("refuses self-opened threads from hand-offs or peer asks", async () => {
    const input = { ...base(), handoff: true };
    expect(await openSelfThread(input)).toEqual({ status: 409, body: { error: SELF_THREAD_REFUSAL } });
  });
});
