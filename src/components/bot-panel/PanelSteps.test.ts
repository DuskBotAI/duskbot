import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Bot, Group, Message } from "@/state/store";
import { PanelSteps } from "./PanelSteps";

const NOW = Date.now();
let seq = 0;
const row = (fields: Partial<Message>): Message => ({ id: `m${++seq}`, role: "bot", kind: "activity", at: NOW - 5_000 + seq, ...fields }) as Message;
const command = (detail: string, tool: Partial<NonNullable<Message["tool"]>> = {}, extra: Partial<Message> = {}) =>
  row({ tool: { name: "Bash", ok: true, step: { activity: "command", target: detail.split(" ")[0]!, detail }, ...tool }, ...extra });
const browse = (action: string, tool: Partial<NonNullable<Message["tool"]>> = {}, extra: Partial<Message> = {}) =>
  row({ tool: { name: `mcp__browser__agent_browser_${action}`, ok: true, ...tool }, ...extra });
const opened = (site: string, extra: Partial<Message> = {}) => browse("open", { step: { activity: "fetch", target: site } }, extra);
const said = (text: string, extra: Partial<Message> = {}) => row({ kind: "text", text, ...extra });
const asked = (text: string) => row({ role: "user", kind: "text", text });

const bot = (messages: Message[], fields: Partial<Bot> = {}): Bot =>
  ({ id: "b1", name: "Nova", color: "green", threadId: "t1", messages, ...fields }) as Bot;
const panel = (props: { bot: Bot; room?: Group; pictures?: boolean }) =>
  renderToStaticMarkup(createElement(PanelSteps, { pictures: true, ...props }));
const order = (html: string) => [...html.matchAll(/data-mid="([^"]+)" class="contents"|class="contents" data-mid="([^"]+)"/g)].map((match) => match[1] ?? match[2]);

describe("PanelSteps", () => {
  it("draws nothing for a conversation with no command and no browsing", () => {
    expect(panel({ bot: bot([asked("hi"), said("hello"), row({ tool: { name: "Read", ok: true, step: { activity: "read", target: "a.md" } } })]) })).toBe("");
  });

  it("lists each command and each stretch of browsing of the latest turn, the newest first, under one heading", () => {
    const first = command("pnpm lint"), site = opened("example.com"), click = browse("click"), last = command("pnpm test", { ok: false });
    const html = panel({ bot: bot([asked("ship it"), first, site, click, said("Looks fine."), last]) });
    expect(html).toContain("Commands and browsing");
    expect(html).toContain('data-panel-steps="3"');
    expect(order(html)).toEqual([last.id, site.id, first.id]);
    expect(html).toContain("pnpm test");
    expect(html).toContain("example.com");
    expect(html).toContain("2 steps");
    expect(html.match(/data-live-card-state="failed"/g)).toHaveLength(1);
  });

  it("drops an earlier turn's steps once a newer turn has spoken, and shows nothing when that turn ran none", () => {
    const old = command("pnpm lint", {}, { turnId: "one" }), fresh = command("pnpm test", {}, { turnId: "two" });
    const html = panel({ bot: bot([asked("lint"), old, said("Clean.", { turnId: "one" }), asked("test"), fresh, said("Green.", { turnId: "two" })]) });
    expect(order(html)).toEqual([fresh.id]);
    expect(html).not.toContain("pnpm lint");
    expect(panel({ bot: bot([asked("lint"), old, said("Clean.", { turnId: "one" }), asked("thanks"), said("Any time.", { turnId: "two" })]) })).toBe("");
  });

  it("keeps the last turn's steps while the person's next message waits for its turn", () => {
    const ran = command("pnpm lint", {}, { turnId: "one" });
    expect(order(panel({ bot: bot([asked("lint"), ran, said("Clean.", { turnId: "one" }), asked("and test")]) }))).toEqual([ran.id]);
  });

  it("opens the running command as a card and leaves finished ones folded", () => {
    const done = command("pnpm lint"), running = command("pnpm test", { ok: undefined });
    const html = panel({ bot: bot([asked("go"), done, running], { busy: true, tasks: [{ threadId: "t1", busy: true, turnStartedAt: NOW - 10_000 }] as Bot["tasks"] }) });
    expect(html.match(/data-live-card-state="running"/g)).toHaveLength(1);
    expect(html.match(/data-live-card-open=""/g)).toHaveLength(1);
    expect(html).toContain("data-working-mascot");
  });

  it("leaves the page's picture out where the live browser is already on screen", () => {
    const steps = [asked("price?"), opened("example.com"), browse("click", { ok: undefined })];
    const working = { busy: true, turnStartedAt: NOW - 10_000 };
    expect(panel({ bot: bot(steps, working) })).toContain("data-live-card-snapshot");
    const html = panel({ bot: bot(steps, working), pictures: false });
    expect(html).not.toContain("data-live-card-snapshot");
    expect(html).toContain("Clicking on the page");
  });

  it("in a group chat lists only this member's latest turn, from the group's conversation", () => {
    const mine = { from: { botId: "b1", name: "Nova", color: "green" as const } };
    const theirs = { from: { botId: "b2", name: "Rivet", color: "blue" as const } };
    const earlier = command("pnpm lint", {}, { ...mine, turnId: "mine-1" });
    const a = command("pnpm build", {}, { ...mine, turnId: "mine-2" }), other = command("rm -rf dist", {}, { ...theirs, turnId: "theirs-1" }), b = opened("example.com", { ...mine, turnId: "mine-2" });
    const room = { id: "g1", threadId: "room-thread", name: "Launch", memberIds: ["b1", "b2"], messages: [asked("go"), earlier, asked("again"), a, other, b] } as unknown as Group;
    const html = panel({ bot: bot([command("only in the 1:1 chat")]), room });
    expect(order(html)).toEqual([b.id, a.id]);
    expect(html).not.toContain("rm -rf dist");
    expect(html).not.toContain("pnpm lint");
    expect(html).not.toContain("only in the 1:1 chat");
  });
});
