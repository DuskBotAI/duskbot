import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Bot, Group, Message } from "@/state/store";

vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, bots: [] as Bot[] }, dispatch: vi.fn() }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false, reasonCode: "x", message: "" } }, ready: true }),
  useCaptionChrome: () => ({}),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { Transcript } = await import("./GroupView");
const { NewMessagesDivider } = await import("./NewMessagesDivider");
const { grokAccentText } = await import("@/lib/user-bubble-tone");

beforeAll(() => vi.stubGlobal("window", {}));
afterAll(() => vi.unstubAllGlobals());

const lead = { id: "lead", name: "Lead", color: "blue" } as Bot;
const room = {
  id: "room", threadId: "room-thread", name: "Launch", memberIds: ["lead"],
  defaultResponder: { kind: "member", botId: "lead" }, bulletin: "", unread: false, createdAt: 1, messages: [] as Message[],
} as Group;
const said = (id: string, role: Message["role"], fields: Partial<Message> = {}): Message => ({
  id, role, kind: "text", at: 1, text: `${id} text`,
  ...(role === "bot" ? { from: { botId: "lead", name: "Lead", color: "blue" as const } } : {}),
  ...fields,
});
const markup = (messages: Message[], unreadDividerId: string | null) => renderToStaticMarkup(createElement(Transcript, {
  group: { ...room, messages }, members: [lead], locale: "en", messages, transcript: messages, unreadDividerId, onReply: () => {},
}));

describe("the New divider in a room", () => {
  it("sits above the member's name on the first new reply", () => {
    const html = markup([said("u1", "user"), said("b2", "bot")], "b2");
    const separator = html.indexOf('role="separator"');
    expect(separator).toBeGreaterThan(html.indexOf("u1 text"));
    expect(separator).toBeLessThan(html.indexOf(">Lead<"));
    expect(html.match(/data-unread-divider/g)).toHaveLength(1);
  });

  it("moves down to the first drawn row when its own line is hidden", () => {
    const step = said("b2", "bot", { kind: "activity", tool: { name: "Read", ok: true } });
    const html = markup([said("u1", "user"), step, said("b3", "bot")], "b2");
    expect(html.match(/data-unread-divider/g)).toHaveLength(1);
    expect(html.indexOf('role="separator"')).toBeLessThan(html.indexOf("b3 text"));
  });

  it("is not drawn without a divider, or when its message is not mounted", () => {
    expect(markup([said("u1", "user"), said("b2", "bot")], null)).not.toContain("data-unread-divider");
    expect(markup([said("u1", "user"), said("b2", "bot")], "older")).not.toContain("data-unread-divider");
  });
});

describe("NewMessagesDivider", () => {
  it("draws two solid accent hairlines at 20% around a small label, named for screen readers", () => {
    const html = renderToStaticMarkup(createElement(NewMessagesDivider, { fading: false }));
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-label="New messages"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain(">New<");
    expect(html).toContain("text-[11px]");
    expect(html).toContain("text-(--new-ink)");
    expect(html).toContain("--new-ink:var(--grok-new, var(--color-accent-text))");
    expect(html.match(/h-px min-w-0 flex-1/g)).toHaveLength(2);
    expect(html).toContain("bg-(--new-ink)/20");
    expect(html).toContain("motion-reduce:transition-none");
    expect(html).toContain("grid-rows-[1fr]");
  });

  it("wears grok's text colour for the bot's hue on the grok skins, over the chat's own tint", () => {
    const html = renderToStaticMarkup(createElement(NewMessagesDivider, { fading: false, tint: "var(--identity-purple)", grokTint: grokAccentText("purple") }));
    expect(html).toContain("--new-ink:var(--grok-new, var(--identity-purple))");
    expect(html).toContain("--grok-new-fill:light-dark(#894ef0, #935df1)");
    expect(grokAccentText("coral")).toBe("light-dark(#e71c0b, #f75e51)");
    expect(grokAccentText("silver")).toBe("var(--color-ink)");
  });

  it("folds its height and the row gap away while fading", () => {
    const html = renderToStaticMarkup(createElement(NewMessagesDivider, { fading: true }));
    expect(html).toContain("opacity-0");
    expect(html).toContain("grid-rows-[0fr]");
    expect(html).toContain("-mb-3");
  });
});
