// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo, Message } from "@/state/store";

vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true, useReactor: () => "user" }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

const { ChatView } = await import("./ChatView");
const { EMOJI_ONLY_TEXT } = await import("./chat-bubble");
const { BotEditorStore, initialState } = await import("@/state/store");

const here = dirname(fileURLToPath(import.meta.url));
const stylesCss = readFileSync(join(here, "../styles.css"), "utf8");
const chatCss = readFileSync(join(here, "chat.css"), "utf8");

type Rule = { selector: string; decls: Map<string, string>; weight: number };
function splitTop(list: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < list.length; i++) {
    if ("([".includes(list[i]!)) depth++;
    else if (")]".includes(list[i]!)) depth--;
    else if (list[i] === "," && depth === 0) { parts.push(list.slice(start, i)); start = i + 1; }
  }
  return [...parts, list.slice(start)].map((part) => part.trim()).filter(Boolean);
}
function unlayeredRules(source: string): Rule[] {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...clean.matchAll(/([^{};]+)\{([^{}]*)\}/g)].flatMap(([, selectors, body]) => {
    const decls = new Map(body!.split(";").map((decl) => decl.split(":").map((side) => side.trim())).filter(([prop, value]) => prop && value).map(([prop, value]) => [prop!, value!]));
    return splitTop(selectors!).filter((selector) => !selector.startsWith("@") && !/^(from|to|\d+%)$/.test(selector)).map((selector) => ({
      selector,
      decls,
      weight: (selector.match(/\[|(?<![:\w-])\.[\w\\]|:(?!:)(?!is\(|where\()/g) ?? []).length,
    }));
  });
}
const rules = [...unlayeredRules(stylesCss), ...unlayeredRules(chatCss)];

function unlayered(el: Element, prop: string): string | undefined {
  let best: Rule | undefined;
  for (const rule of rules) {
    if (!rule.decls.has(prop)) continue;
    let hit = false;
    try { hit = el.matches(rule.selector); } catch {}
    if (hit && (!best || rule.weight >= best.weight)) best = rule;
  }
  return best?.decls.get(prop);
}

const at = (min: number) => Date.UTC(2026, 9, 21, 9, min);
const messages: Message[] = [
  { id: "m1", role: "user", kind: "text", text: "I deleted the check.", at: at(1) },
  { id: "m2", parentId: "m1", role: "bot", kind: "text", text: "o7. Took it off my list.", reactions: [{ emoji: "👍", by: "user", at: at(2) }], at: at(2) },
  { id: "m3", parentId: "m2", role: "bot", kind: "text", text: "👍", at: at(3) },
  { id: "m4", parentId: "m3", role: "user", kind: "text", text: "👍", at: at(4) },
  { id: "m5", parentId: "m4", role: "bot", kind: "text", text: "🎉", reactions: [{ emoji: "❤️", by: "user", at: at(5) }], at: at(5) },
];
const bot: Bot = {
  id: "pepper", threadId: "pepper-thread", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages, activeLeafId: "m5", modelSelection: { instanceId: "test", model: "m" },
  tasks: [{ threadId: "pepper-thread", title: "Thread", createdAt: 1, busy: false, activity: "idle", modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask" }],
};

let root: Root;
beforeAll(async () => {
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const state: AppState = {
    ...initialState, connected: true, selectedId: "pepper", bots: [bot],
    instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" } } as InstanceInfo],
    config: { features: {} } as AppState["config"],
  };
  const value = { state, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(ChatView, { bot }) })));
  await new Promise((resolve) => setTimeout(resolve, 0));
});
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
});

const bubble = (id: string) => document.querySelector<HTMLElement>(`[data-mid="${id}"] [data-chat-bubble="simple"]`)!;

describe("emoji-only message line height", () => {
  it("inherits the 48px line box on both bot markdown and user text instead of collapsing to 22px", () => {
    const botEmoji = bubble("m3");
    const userEmoji = bubble("m4");
    expect(botEmoji.hasAttribute("data-emoji-only")).toBe(true);
    expect(userEmoji.hasAttribute("data-emoji-only")).toBe(true);
    expect(botEmoji.className).toContain("text-[40px]");
    expect(botEmoji.className).toContain("leading-[48px]");

    const botMd = botEmoji.querySelector(".chat-md")!;
    const userText = userEmoji.querySelector(".chat-text")!;
    expect(botMd).toBeTruthy();
    expect(userText).toBeTruthy();
    expect(unlayered(botMd, "line-height")).toBe("inherit");
    expect(unlayered(userText, "line-height")).toBe("inherit");
  });

  it("keeps plain text bubbles on their 22px bot and 20px user lines", () => {
    expect(unlayered(bubble("m2").querySelector(".chat-md")!, "line-height")).toBe("22px");
    expect(unlayered(bubble("m1").querySelector(".chat-text")!, "line-height")).toBe("20px");
  });

  it("does not apply descendant overrides that blow up floating reaction chips on an emoji-only message", () => {
    expect(EMOJI_ONLY_TEXT).not.toMatch(/\[&_\*\]/);
    const reacted = bubble("m5");
    expect(reacted.hasAttribute("data-emoji-only")).toBe(true);
    const chipEmoji = reacted.querySelector('[role="group"] button span')!;
    expect(chipEmoji.className).toContain("text-[16px]");
    expect(chipEmoji.className).toContain("leading-4");
  });
});
