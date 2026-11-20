// @vitest-environment happy-dom
// The Simple bot panel in a real DOM, where effects run and focus moves: named links, Escape and focus, and the chat
// header's pill that opens it.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, BotSettingsSection } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), settingsOpen: false }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({ state: { ...original.initialState, settingsOpen: fixture.settingsOpen }, dispatch: fixture.dispatch, flushBotPatches: () => Promise.resolve(null) }),
  };
});
vi.mock("../DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("../DesktopCapabilities")>(),
  useCaptionChrome: () => ({ dragProps: {}, padClass: "" }),
}));
vi.mock("../Avatar", () => ({ BotAvatar: () => null, MausAvatar: () => null }));
vi.mock("../AvatarImageGenerator", () => ({ AvatarImageGenerator: () => null }));
vi.mock("@/lib/use-organization-branding", () => ({ useOrganizationBranding: () => null }));
const stub = (name: string) => (props: Record<string, unknown>) =>
  createElement("div", { [`data-stub-${name}`]: true, "data-editing-instructions": props.editingInstructions === true ? "true" : undefined });
vi.mock("./DetailsTab", () => ({
  DetailsTab: (props: { onOpen: (page: string) => void }) =>
    createElement("div", { "data-stub-details": true }, createElement("button", { type: "button", "data-panel-gear": true, onClick: () => props.onOpen("settings") }, "bot settings")),
}));
vi.mock("./LibraryTab", () => ({ LibraryPage: stub("library"), LibrarySection: stub("library-section"), libraryItems: () => ({ pages: [], apps: [], shared: [], unshared: [] }) }));
vi.mock("./ComputerTab", () => ({ ComputerTab: stub("computer") }));
vi.mock("./AdvancedTab", () => ({ AdvancedTab: stub("advanced") }));
vi.mock("./pages", () => ({
  PageBody: ({ page, editingInstructions }: { page: string; editingInstructions?: boolean }) =>
    createElement("div", { "data-stub-page": page, "data-editing-instructions": editingInstructions === true ? "true" : undefined },
      createElement("section", { "data-panel-card": "approval" })),
  pageSurfaceCls: "",
}));

const { BotPanel, PanelPageBody, PanelDetailsTab, PanelAdvancedTab, PanelAvatarEditor } = await import("./PanelShell");
await Promise.all([PanelPageBody.preload(), PanelDetailsTab.preload(), PanelAdvancedTab.preload(), PanelAvatarEditor.preload()]);
const { openBotSettings } = await import("./panel-link");
const { pendingPanelModal, takePanelModalRequest } = await import("./modals/panel-modal");
/** The dialog a link asked the Advanced tab to open, cleared as it is read. */
const asked = () => {
  const request = pendingPanelModal();
  if (request) takePanelModalRequest(request);
  return request?.page;
};
const { ChatHeadPill } = await import("../ChatHeadPill");

const bot: Bot = {
  id: "scout", threadId: "thread-scout", name: "Scout", title: "Researcher", description: "", soul: "",
  notifications: true, color: "green", unread: false, messages: [],
  modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
};
const onClose = vi.fn();
const derived = { activeState: "idle", patch: vi.fn(), botRoutines: [] } as never;

let host: HTMLDivElement;
let root: Root;
// The panel sits inside BotSettingsDialog's <aside role="dialog">, as it does in the app.
const render = (linkedSection: BotSettingsSection | null, computerRequest = 0) =>
  flushSync(() => root.render(createElement("aside", { role: "dialog" }, createElement(BotPanel, { bot, derived, linkedSection, computerRequest, onClose }))));
// Passive effects and the renders they schedule.
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const tab = () => host.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute("data-panel-tab") ?? null;
const page = () => host.querySelector("[data-panel-page-view]")?.getAttribute("data-panel-page-view") ?? null;
const click = (element: Element | null) => {
  if (!element) throw new Error("nothing to click");
  flushSync(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
};
const press = (element: Element | null, key: string) => {
  if (!element) throw new Error("nothing to press");
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  flushSync(() => element.dispatchEvent(event));
  return event;
};
const menu = () => document.querySelector("[data-panel-share-menu]");
const shareOpen = () => moreButton()?.getAttribute("aria-expanded") === "true";
const moreButton = () => host.querySelector("[data-panel-share]")?.closest("button") ?? null;
// What BotSettingsDialog's window listener would do with the key: close the whole panel.
const dialogCloses = vi.fn();
const onWindowKey = (event: KeyboardEvent) => {
  if (event.key === "Escape" && !event.defaultPrevented) dialogCloses();
};

beforeEach(() => {
  fixture.dispatch.mockReset();
  onClose.mockReset();
  dialogCloses.mockReset();
  window.addEventListener("keydown", onWindowKey);
  // Menus close at once instead of animating out.
  document.documentElement.dataset.reducedMotion = "true";
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  window.removeEventListener("keydown", onWindowKey);
  flushSync(() => root.unmount());
  host.remove();
  // A link without a page lands where its section does, so no test sees another's page.
  openBotSettings(vi.fn(), "overview");
});

describe("named links into the bot panel", () => {
  it("opens on the page a link names, or over the Advanced tab with the dialog it names, and moves when a link arrives", async () => {
    asked();
    openBotSettings(fixture.dispatch, "access", { page: "apps" });
    render("access");
    await settle();
    expect(page()).toBe("apps");

    flushSync(() => openBotSettings(fixture.dispatch, "access", { page: "folder" }));
    await settle();
    expect([tab(), page()]).toEqual(["advanced", null]);
    expect(asked()).toBe("folder");

    // Simple mode has no MCP page: the link lands where Access does, the Where it works dialog.
    flushSync(() => openBotSettings(fixture.dispatch, "access", { page: "mcp" }));
    await settle();
    expect([tab(), page()]).toEqual(["advanced", null]);
    expect(asked()).toBe("where");

    flushSync(() => openBotSettings(fixture.dispatch, "access"));
    await settle();
    expect(asked()).toBe("where");
  });

  it("lands on the Computer tab each time the bot's computer is asked for, even when already open", async () => {
    render(null);
    await settle();
    expect(tab()).toBe("details");
    render(null, 1);
    await settle();
    expect(tab()).toBe("computer");
    click(host.querySelector('[data-panel-tab="details"]'));
    render(null, 1);
    await settle();
    expect(tab()).toBe("details");
    render(null, 2);
    await settle();
    expect(tab()).toBe("computer");
  });

  it("follows the same link again after the panel has moved on", async () => {
    asked();
    openBotSettings(fixture.dispatch, "access");
    render("access");
    await settle();
    expect(asked()).toBe("where");

    click(host.querySelector('[data-panel-tab="details"]'));
    expect(tab()).toBe("details");

    flushSync(() => openBotSettings(fixture.dispatch, "access"));
    render("access");
    await settle();
    expect(tab()).toBe("advanced");
    expect(asked()).toBe("where");
  });

  it("opens the Instructions dialog over the Advanced tab for a soul link, with no page to go back from", async () => {
    asked();
    openBotSettings(fixture.dispatch, "soul");
    render("soul");
    await settle();
    expect([tab(), page()]).toEqual(["advanced", null]);
    expect(host.querySelector("[data-panel-back]")).toBeNull();
    expect(asked()).toBe("instructions");
  });

  it("lands permissions, voice and library links on the Advanced tab", async () => {
    for (const section of ["permissions", "voice", "library"] as const) {
      openBotSettings(fixture.dispatch, section);
      render(section);
      await settle();
      expect([tab(), page()], section).toEqual(["advanced", null]);
    }
  });

  it("lands a Bot settings link, the sidebar's and search's, on the Advanced tab", async () => {
    openBotSettings(fixture.dispatch, "overview", { page: "settings" });
    render("overview");
    await settle();
    expect([tab(), page()]).toEqual(["advanced", null]);
    expect(host.querySelector("[data-stub-advanced]")).not.toBeNull();
  });

  it("lands model, usage, history and visibility links on the Details tab, with no Advanced page", async () => {
    for (const section of ["model", "usage", "history", "visibility", "overview"] as const) {
      openBotSettings(fixture.dispatch, section);
      render(section);
      await settle();
      expect([tab(), page()], section).toEqual(["details", null]);
    }
  });
});

describe("the panel's tabs", () => {
  it("are Details, Computer and Advanced, opening on Details, each drawing its own tab", async () => {
    render(null);
    await settle();
    expect([...host.querySelectorAll('[role="tab"]')].map((element) => [element.getAttribute("data-panel-tab"), element.textContent]))
      .toEqual([["details", "Details"], ["computer", "Computer"], ["advanced", "Advanced"]]);
    expect(tab()).toBe("details");
    expect(host.querySelector("[data-panel-tabs]")!.className.split(" ")).toEqual(expect.arrayContaining(["sticky", "top-0", "bg-app"]));
    expect(host.querySelector('[role="tablist"]')!.className.split(" ")).toEqual(expect.arrayContaining(["gap-0.5"]));
    expect(host.querySelector('[role="tab"]')!.className.split(" ")).toEqual(expect.arrayContaining(["h-[26px]", "text-[13px]", "bg-ink/[0.06]"]));
    for (const id of ["computer", "advanced", "details"]) {
      click(host.querySelector(`[data-panel-tab="${id}"]`));
      expect(tab()).toBe(id);
      expect(host.querySelector(`[data-stub-${id}]`), id).not.toBeNull();
    }
  });
});

describe("the panel's top", () => {
  it("has a round Share button holding Create a copy, this chat's Copy and Download, and Close", async () => {
    render(null);
    await settle();
    const top = [...host.querySelectorAll("button")].slice(0, 2);
    expect(top.map((button) => button.getAttribute("aria-label") ?? button.getAttribute("title"))).toEqual(["Share and more", "Close panel"]);
    expect(top[0]!.getAttribute("title")).toBe("Share");
    for (const button of [moreButton()!, top[1]!]) expect(button.querySelector("span, svg, i")).not.toBeNull();
    click(moreButton());
    const rows = () => [...menu()!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(rows().map((row) => row.getAttribute("data-panel-share-item"))).toEqual(["duplicate", "copy", "download"]);
    // an empty chat has nothing to copy or download yet
    expect(rows().filter((row) => row.disabled).map((row) => row.getAttribute("data-panel-share-item"))).toEqual(["copy", "download"]);
    expect(menu()!.querySelectorAll('[role="separator"]')).toHaveLength(0);
    expect(menu()!.textContent).toContain("Create a copy");
    click(rows()[0]!);
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "duplicateBot", botId: "scout" });
    expect(shareOpen()).toBe(false);
    click(top[1]!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("opens Bot settings on the Advanced tab, with no page to go back from", async () => {
    render(null);
    await settle();
    click(host.querySelector('[data-panel-tab="computer"]'));
    expect(host.querySelector("[data-panel-gear]")).toBeNull();
    click(host.querySelector('[data-panel-tab="details"]'));
    click(host.querySelector("[data-panel-gear]"));
    expect([tab(), page()]).toEqual(["advanced", null]);
    expect(host.querySelector("[data-panel-back]")).toBeNull();
    expect(host.querySelector('[role="tabpanel"]')!.getAttribute("aria-label")).toBe("Advanced");
  });

  it("puts the name right under the avatar, with no call button beside it", async () => {
    render(null);
    await settle();
    const row = host.querySelector("[data-panel-name-row]")!;
    expect(row.querySelector("[data-panel-rename]")!.textContent).toBe("Scout");
    expect(row.querySelector("[data-panel-rename]")!.hasAttribute("aria-label")).toBe(false);
    expect(row.querySelector("[data-panel-rename]")!.getAttribute("title")).toBe("Rename Scout");
    expect(host.querySelector("[data-panel-avatar]")!.nextElementSibling).toBe(row);
    expect(host.querySelector("[data-call-button]")).toBeNull();
  });
});

describe("the chat header's pill", () => {
  const withTasks: Bot = { ...bot, tasks: [
    { threadId: "thread-scout", title: "Plan the launch", createdAt: 1 },
    { threadId: "other", title: "Older notes", createdAt: 0, unread: true },
  ] };
  const pill = (props: Partial<Parameters<typeof ChatHeadPill>[0]> = {}) => {
    const header = document.createElement("div");
    document.body.append(header);
    const headerRoot = createRoot(header);
    const onToggle = vi.fn();
    flushSync(() => headerRoot.render(createElement(ChatHeadPill, { bot: withTasks, avatar: { state: "idle" }, privacy: null, onToggle, ...props })));
    return { header, onToggle, done: () => { flushSync(() => headerRoot.unmount()); header.remove(); } };
  };

  it("names the bot, opens the bot panel, and dots another conversation that needs a look", () => {
    const { header, onToggle, done } = pill();
    try {
      const button = header.querySelector<HTMLButtonElement>("[data-chathead-pill]")!;
      // the hover chevron is an icon-font glyph, so read the name itself
      expect(button.querySelector('span[dir="auto"]')?.textContent).toBe("Scout");
      expect(button.getAttribute("aria-label")).toBe("Open Scout's profile");
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(button.hasAttribute("aria-controls")).toBe(false);
      expect(header.querySelector("[data-chathead-chevron]")).toBeNull();
      expect(header.querySelector("[data-chathead-elsewhere]")).toBeNull();
      click(button);
      expect(onToggle).toHaveBeenCalledOnce();
    } finally {
      done();
    }
  });

  it("says the panel is open and points at it, then hides the hover chevron", () => {
    fixture.settingsOpen = true;
    const { header, done } = pill();
    try {
      const button = header.querySelector<HTMLButtonElement>("[data-chathead-pill]")!;
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(button.getAttribute("aria-controls")).toBe("bot-panel");
      expect(header.querySelector("[data-chathead-chevron]")).toBeNull();
    } finally {
      fixture.settingsOpen = false;
      done();
    }
  });

  it("names the conversation on screen when it is not the bot's main one", () => {
    const { header, done } = pill({ bot: { ...withTasks, mainThreadId: "other" } });
    try {
      const button = header.querySelector<HTMLButtonElement>("[data-chathead-pill]")!;
      expect(header.querySelector("[data-chathead-conversation]")!.textContent).toBe("Plan the launch");
      expect(button.getAttribute("aria-label")).toBe("Open Scout's profile, Plan the launch");
      expect(header.querySelector("[data-chathead-chevron]")).toBeNull();
    } finally {
      done();
    }
    const untitled = pill({ bot: { ...withTasks, mainThreadId: "other", tasks: [{ ...withTasks.tasks![0]!, title: "New thread" }, withTasks.tasks![1]!] } });
    try {
      expect(untitled.header.querySelector("[data-chathead-conversation]")!.textContent).toBe("New conversation");
    } finally {
      untitled.done();
    }
  });

  it("says who can read a team chat", () => {
    const quiet = pill({ bot: { ...withTasks, tasks: withTasks.tasks!.map((task) => ({ ...task, unread: false })) }, privacy: { kind: "private" } });
    try {
      expect(quiet.header.querySelector("[data-chathead-elsewhere]")).toBeNull();
      expect(quiet.header.querySelector('[data-chathead-privacy="private"]')!.textContent).toBe("Private · only you");
    } finally {
      quiet.done();
    }
  });
});

describe("Escape in the bot panel", () => {
  const onPage = async () => {
    openBotSettings(fixture.dispatch, "routines");
    render("routines");
    await settle();
    expect(page()).toBe("routines");
  };

  it("goes back from a drill-in page instead of closing the panel, though the panel sits in a dialog", async () => {
    await onPage();
    const back = host.querySelector<HTMLElement>("[data-panel-back]");
    back?.focus();
    const event = press(back, "Escape");
    expect(event.defaultPrevented).toBe(true);
    expect([tab(), page()]).toEqual(["details", null]);
    expect(dialogCloses).not.toHaveBeenCalled();
    // On a tab, Escape is the dialog's: it closes the panel.
    press(host.querySelector('[data-panel-tab="details"]'), "Escape");
    expect(dialogCloses).toHaveBeenCalledTimes(1);
  });

  it("closes the Share menu first on a tab, and Escape on a page goes back, before anything reaches the panel", async () => {
    render(null);
    await settle();
    moreButton()?.focus();
    click(moreButton());
    expect(shareOpen()).toBe(true);
    press(moreButton(), "Escape");
    expect(shareOpen()).toBe(false);
    expect(dialogCloses).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(moreButton());

    flushSync(() => root.unmount());
    root = createRoot(host);
    await onPage();
    // a page's header is Grok's: Back, its title and Close, with no Share
    expect(moreButton()).toBeNull();
    press(host.querySelector("[data-panel-back]"), "Escape");
    expect([tab(), page()]).toEqual(["details", null]);
    expect(dialogCloses).not.toHaveBeenCalled();
  });
});

describe("focus around the hero", () => {
  const avatar = () => host.querySelector<HTMLElement>("[data-panel-avatar]");
  const card = () => host.querySelector("[data-panel-avatar-editor]");

  it("moves focus into the avatar editor, and back to the avatar however it closes", async () => {
    render(null);
    await settle();
    avatar()!.focus();
    click(avatar());
    await settle();
    expect(card()).not.toBeNull();
    expect(document.activeElement?.getAttribute("aria-pressed")).toBe("true");

    const event = press(document.activeElement, "Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(avatar());
    expect(dialogCloses).not.toHaveBeenCalled();

    click(avatar());
    await settle();
    click(host.querySelector("[data-panel-scrim]"));
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(avatar());
    // Focus is back where Escape is heard: the next one is the dialog's.
    press(document.activeElement, "Escape");
    expect(dialogCloses).toHaveBeenCalledTimes(1);
  });

  it.each([["data-panel-rename", "Enter"], ["data-panel-rename", "Escape"]])(
    "gives focus back to the %s button after %s, so the next Escape still works",
    async (attr, key) => {
      render(null);
      await settle();
      click(host.querySelector(`[${attr}]`));
      const input = host.querySelector<HTMLInputElement>(`[${attr}-input]`);
      expect(document.activeElement).toBe(input);
      press(input, key);
      await settle();
      expect(host.querySelector(`[${attr}-input]`)).toBeNull();
      expect(document.activeElement).toBe(host.querySelector(`[${attr}]`));
      expect(dialogCloses).not.toHaveBeenCalled();
      press(document.activeElement, "Escape");
      expect(dialogCloses).toHaveBeenCalledTimes(1);
    },
  );
});
