// @vitest-environment happy-dom
// Bot sharing is off for now: a team's bot shows no Share button, the new bot defaults offer no preset to share, and no
// search command shares a bot. Turning BOT_SHARING_ENABLED on brings the button back.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const sharing = vi.hoisted(() => ({ on: false }));
vi.mock("../../../shared/bot-sharing", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../shared/bot-sharing")>(),
  get BOT_SHARING_ENABLED() { return sharing.on; },
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: vi.fn(async () => ({ bot: {} })),
  useStore: () => ({ state: { config: { team: { id: "team-acme", name: "Acme" } } }, dispatch: vi.fn() }),
}));

const { ShareBotButton } = await import("./ShareBotButton");
const { DefaultBotSettings } = await import("../NewBotDialog");
const { settingsCommands } = await import("../palette-commands");

const payroll: Bot = {
  id: "payroll", threadId: "t-main", name: "Payroll", title: "", description: "", notifications: true, color: "teal", unread: false,
  modelSelection: { instanceId: "claude", model: "claude-opus-5-5" }, messages: [], createdBy: "ada@acme.test", yourAccess: "edit",
  access: { everyone: "none", people: {} },
};

let host: HTMLDivElement;
let root: Root;
const draw = (element: ReturnType<typeof createElement>) => flushSync(() => root.render(element));

beforeEach(() => {
  sharing.on = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("with bot sharing off", () => {
  it("shows a team's bot no Share button", () => {
    draw(createElement(ShareBotButton, { bot: payroll, className: "" }));
    expect(host.querySelector("[data-share-bot-button]")).toBeNull();
    expect(host.querySelector("[data-panel-share]")).toBeNull();
  });

  it("brings the button back when sharing is on", () => {
    sharing.on = true;
    draw(createElement(ShareBotButton, { bot: payroll, className: "" }));
    expect(host.querySelector("[data-share-bot-button]")).not.toBeNull();
  });

  it("offers no preset to share in the new bot defaults, only the defaults", () => {
    draw(createElement(DefaultBotSettings));
    expect(host.querySelector('[data-settings-open="share-preset"]')).toBeNull();
    expect(host.querySelector('[data-settings-open="bot-defaults"]')).not.toBeNull();
    sharing.on = true;
    draw(createElement(DefaultBotSettings));
    expect(host.querySelector('[data-settings-open="share-preset"]')).not.toBeNull();
  });

  it("has no search command that shares a bot, while the team's people stay findable", () => {
    const commands = settingsCommands();
    expect(commands.filter((command) => /share|sharing/i.test(command.name))).toEqual([]);
    expect(commands.some((command) => command.id === "setting-people")).toBe(true);
  });
});
