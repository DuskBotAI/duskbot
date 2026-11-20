// @vitest-environment happy-dom
import { act, createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { LIFE_MASCOT_MS, LIFE_MASCOT_STATE } from "@/lib/reply-life";
import type { MarkState } from "./mascot-engine";

import { loadLocale } from "@/lib/i18n";
import type { Bot, Message } from "@/state/store";
import { handoffWorkIds, RoomWorkingLines, roomStatusPhrase, roomWorkingIds } from "./RoomWorkingLines";

await loadLocale("en");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bot = (id: string, name: string) => ({
  id, name, color: "green", threadId: id, title: "", description: "", notifications: true, unread: false, messages: [],
  modelSelection: { instanceId: "test", model: "m" },
}) as Bot;
const members = [bot("echo", "Echo"), bot("nova", "Nova"), bot("moss", "Moss")];

describe("who works in a room", () => {
  it("names the speaker, every parallel turn and a member whose tool call is out, once each", () => {
    const toolCall = { id: "a", role: "bot", kind: "activity", at: 1, from: { botId: "moss", name: "Moss", color: "green" }, tool: { name: "Bash", input: "{}" } } as Message;
    expect(roomWorkingIds({ threadId: "t", busyBotId: "echo", busyBotIds: ["echo", "nova"] }, toolCall)).toEqual(["echo", "nova", "moss"]);
    expect(roomWorkingIds({ threadId: "t", busyBotId: null }, undefined)).toEqual([]);
  });
});

describe("members at work on a hand-off", () => {
  const who = (botId: string, name: string) => ({ botId, name, color: "green" });
  const line = (id: string, phase: "sent" | "result", from: string, to: string): Message => ({
    id, role: "bot", kind: "activity", at: 2, tool: { name: id, ok: true },
    handoff: { phase, from: who(from, from), to: who(to, to) },
  });
  const ask: Message = { id: "ask", role: "user", kind: "text", at: 1, text: "Get the launch ready" };

  it("counts each member a hand-off since the person's last line still waits on", () => {
    expect(handoffWorkIds([ask, line("a", "sent", "nova", "quill"), line("b", "sent", "nova", "moss")])).toEqual(["quill", "moss"]);
    expect(handoffWorkIds([ask, line("a", "sent", "nova", "quill"), line("b", "sent", "nova", "moss"), line("c", "result", "quill", "nova")])).toEqual(["moss"]);
  });

  it("forgets hand-offs from before the person last wrote", () => {
    expect(handoffWorkIds([line("a", "sent", "nova", "quill"), ask])).toEqual([]);
  });
});

describe("the room's working phrase", () => {
  it("names two or three bots as a list and calls more of them several", () => {
    expect(roomStatusPhrase(["Nova", "Quill"], "typing")).toBe("Nova and Quill are typing…");
    expect(roomStatusPhrase(["Nova", "Quill", "Rivet"], "working")).toBe("Nova, Quill, and Rivet are working…");
    expect(roomStatusPhrase(["Nova", "Quill", "Rivet", "Echo"], "working")).toBe("Several bots are working…");
  });
});

describe("the room's working line", () => {
  const draw = (workingIds: string[], speakerVisible = true, markState: MarkState = "streaming", phase = "friendly:chat.typing") => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    flushSync(() => root.render(createElement(RoomWorkingLines, {
      group: { id: "room", turnStartedAt: 1 },
      members,
      workingIds,
      speaker: { bot: members[0], visible: speakerVisible, markState, phrases: ["typing…"], phase, since: null },
      slot: true,
    })));
    return { host, done: () => { flushSync(() => root.unmount()); host.remove(); } };
  };

  it("is one line for several bots: their faces in a stack and one phrase that names them, with nothing to unfold", () => {
    const { host, done } = draw(["echo", "nova", "moss"]);
    expect(host.querySelectorAll(".turn-presence")).toHaveLength(1);
    expect([...host.querySelectorAll("[data-bot-faces] [role=img]")].map((face) => face.getAttribute("aria-label"))).toEqual(["Echo", "Nova", "Moss"]);
    expect(host.querySelector(".turn-presence > div")?.getAttribute("title"), "no timer, step or tool name").toBe("Echo, Nova, and Moss are typing…");
    expect(host.querySelector("button[aria-expanded]")).toBeNull();
    done();
  });

  it("says Waiting for connection, with no bot at work, while the person's message waits for the network", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    flushSync(() => root.render(createElement(RoomWorkingLines, {
      group: { id: "room", turnStartedAt: 1 }, members, workingIds: ["echo"],
      speaker: { bot: members[0], visible: true, markState: "thinking", phrases: ["Thinking"], phase: "friendly:thinking", since: null },
      slot: true, networkWait: true,
    })));
    expect(host.textContent).toContain("Waiting for connection");
    expect(host.querySelectorAll("[data-bot-faces] [role=img]")).toHaveLength(0);
    flushSync(() => root.unmount());
    host.remove();
  });

  it("keeps one bot at work on the plain 1:1 line", () => {
    const { host, done } = draw(["echo"]);
    expect(host.querySelectorAll("[data-bot-faces] [role=img]")).toHaveLength(1);
    expect(host.innerHTML).toMatch(/width(="|: )28px/);
    done();
  });

  it("gives each answering face its own quiet wait: the mascot, then the dots; a typing one is the bot itself", () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const { host, done } = draw(["echo", "nova"], true, "thinking", "friendly:thinking");
    const states = () => [...host.querySelectorAll("[data-bot-faces] [data-state]")].map((face) => face.getAttribute("data-state"));
    expect(states()).toEqual([LIFE_MASCOT_STATE, LIFE_MASCOT_STATE]);
    act(() => void vi.advanceTimersByTime(LIFE_MASCOT_MS.max + 20));
    expect(states()).toEqual(["thinking", "thinking"]);
    done();
    const typing = draw(["echo"]);
    expect([...typing.host.querySelectorAll("[data-bot-faces] [data-state]")].map((face) => face.getAttribute("data-state"))).toEqual(["streaming"]);
    typing.done();
    vi.useRealTimers();
  });

  it("keeps the slot when nobody works", () => {
    const { host, done } = draw([], false);
    expect(host.querySelector("[data-room-working-line]")).toBeNull();
    expect(host.querySelector(".turn-status-slot")).not.toBeNull();
    done();
  });
});
