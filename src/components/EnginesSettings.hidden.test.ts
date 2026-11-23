// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  instances: [] as Array<Record<string, unknown>>,
  hidden: [] as Array<{ instanceId: string; displayName: string }>,
  calls: [] as Array<{ path: string; body?: unknown }>,
  refresh: vi.fn(),
  dispatch: vi.fn(),
  apiReply: null as ((path: string, body?: unknown) => unknown) | null,
}));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: { instances: fixture.instances, bots: [] }, dispatch: fixture.dispatch, refreshInstances: fixture.refresh, refreshModels: vi.fn() }),
  api: async (path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    fixture.calls.push({ path, ...(body !== undefined ? { body } : {}) });
    if (fixture.apiReply) {
      const custom = fixture.apiReply(path, body);
      if (custom !== undefined) return custom;
    }
    if (path === "/api/instances/hidden") return { instances: fixture.hidden };
    fixture.hidden = [];
    return { instances: [] };
  },
}));

const { DisconnectProvider, FoundProvider, HiddenEngines } = await import("./EnginesSettings");
const instance = (extra: object) => ({ instanceId: "grok", driverKind: "grok", displayName: "Grok", snapshot: { state: "available", authenticated: true }, models: { default: "m", options: [] }, ...extra }) as never;

let root: Root;
let host: HTMLElement;
const settle = () => new Promise((done) => setTimeout(done, 0));
beforeEach(() => {
  fixture.instances = [];
  fixture.calls = [];
  fixture.apiReply = null;
  fixture.refresh.mockReset();
  fixture.dispatch.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); });

describe("disconnected providers in Settings", () => {
  it("shows nothing while no provider is hidden", async () => {
    fixture.hidden = [];
    flushSync(() => root.render(createElement(HiddenEngines)));
    await settle();
    expect(host.querySelector("[data-hidden-engines]")).toBeNull();
  });

  it("lists disconnected providers as rows under their own label, and reconnects one with a click", async () => {
    fixture.hidden = [{ instanceId: "hermes", displayName: "Hermes" }, { instanceId: "pi", displayName: "pi" }];
    flushSync(() => root.render(createElement(HiddenEngines)));
    await settle();
    const list = host.querySelector("[data-hidden-engines]")!;
    expect(list.querySelector("[data-settings-heading]")!.textContent).toBe("Disconnected (2)");
    expect(list.textContent).toContain("Hermes");
    flushSync(() => host.querySelector<HTMLButtonElement>('[data-unhide-engine="hermes"]')!.click());
    await settle();
    expect(fixture.calls).toContainEqual({ path: "/api/instances/hermes", body: { hidden: false } });
    expect(fixture.refresh).toHaveBeenCalled();
  });
});

describe("a provider found on this computer", () => {
  it("says so and turns on with Use it; a chosen one shows nothing", async () => {
    flushSync(() => root.render(createElement(FoundProvider, { instance: instance({}) })));
    expect(host.textContent).toBe("");
    flushSync(() => root.render(createElement(FoundProvider, { instance: instance({ found: true }) })));
    expect(host.textContent).toContain("Found on this computer");
    flushSync(() => host.querySelector<HTMLButtonElement>('[data-use-found="grok"]')!.click());
    await settle();
    expect(fixture.calls).toContainEqual({ path: "/api/instances/grok", body: { chosen: true } });
    expect(fixture.refresh).toHaveBeenCalled();
  });
});

describe("disconnecting a provider", () => {
  it("asks first, then leaves it out of every list", async () => {
    flushSync(() => root.render(createElement(DisconnectProvider, { instance: instance({}) })));
    flushSync(() => host.querySelector<HTMLButtonElement>('[data-disconnect-engine="grok"]')!.click());
    expect(fixture.calls).toEqual([]);
    const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Disconnect" && !button.hasAttribute("data-disconnect-engine"))!;
    expect(document.body.textContent).toContain("Disconnect Grok?");
    flushSync(() => confirm.click());
    await settle();
    expect(fixture.calls).toContainEqual({ path: "/api/instances/grok", body: { hidden: true } });
  });

  const confirmButton = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent === label && !button.hasAttribute("data-disconnect-engine"))!;

  it("signs out first where dusk bot can, so the signed-in app cannot bring it back", async () => {
    flushSync(() => root.render(createElement(DisconnectProvider, { instance: instance({ authentication: { method: "device-code", signOut: true } }) })));
    flushSync(() => host.querySelector<HTMLButtonElement>('[data-disconnect-engine="grok"]')!.click());
    expect(document.body.textContent).toContain("dusk bot signs out of Grok");
    flushSync(() => confirmButton("Disconnect").click());
    await settle();
    expect(fixture.calls.map((call) => call.path)).toEqual(["/api/instances/grok/auth/sign-out", "/api/instances/grok"]);
    expect(fixture.calls[1]).toEqual({ path: "/api/instances/grok", body: { hidden: true } });
  });

  it("keeps the sign-in when asked and only hides the provider", async () => {
    flushSync(() => root.render(createElement(DisconnectProvider, { instance: instance({ authentication: { method: "device-code", signOut: true } }) })));
    flushSync(() => host.querySelector<HTMLButtonElement>('[data-disconnect-engine="grok"]')!.click());
    flushSync(() => confirmButton("Keep sign-in").click());
    await settle();
    expect(fixture.calls).toEqual([{ path: "/api/instances/grok", body: { hidden: true } }]);
  });

  it("only hides a provider it cannot sign out of, and offers no second choice", async () => {
    flushSync(() => root.render(createElement(DisconnectProvider, { instance: instance({}) })));
    flushSync(() => host.querySelector<HTMLButtonElement>('[data-disconnect-engine="grok"]')!.click());
    expect(document.querySelector("[data-confirm-alternative]")).toBeNull();
    flushSync(() => confirmButton("Disconnect").click());
    await settle();
    expect(fixture.calls).toEqual([{ path: "/api/instances/grok", body: { hidden: true } }]);
  });

  it("is not offered for a provider the organization runs", () => {
    flushSync(() => root.render(createElement(DisconnectProvider, { instance: instance({ readOnly: true }) })));
    expect(host.querySelector("[data-disconnect-engine]")).toBeNull();
  });
});

describe("a provider's own page in Settings", () => {
  it("goes back to the list, once, when its provider is disconnected under it", async () => {
    const { SubPageContext } = await import("./ListRows");
    const { EnginesSettings } = await import("./EnginesSettings");
    const back = vi.fn();
    const nav = { at: "engine:claude", open: () => {}, back };
    const page = () => createElement(SubPageContext.Provider, { value: nav }, createElement(EnginesSettings, { simple: true, more: { id: "m", open: false, onToggle: () => {} } }));
    flushSync(() => root.render(page()));
    flushSync(() => root.render(page()));
    await settle();
    expect(back).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[data-simple-engine]")).toBeNull();
  });

  it("opens a newly added Antigravity account's page and starts Google sign-in right away", async () => {
    const { SubPageContext } = await import("./ListRows");
    const { EnginesSettings } = await import("./EnginesSettings");
    const primary = {
      instanceId: "antigravity", driverKind: "antigravityAgent", displayName: "Antigravity", cliDefault: "agy",
      snapshot: { state: "available", authenticated: true, account: { email: "primary@example.test" } },
      models: { default: "gemini", options: [] },
      authentication: { method: "paste-code", signOut: true },
      install: { managed: { label: "Install official Antigravity", downloadBytes: 1024 } },
    };
    const added = {
      instanceId: "antigravity-college", driverKind: "antigravityAgent", displayName: "College", cliDefault: "agy",
      snapshot: { state: "available", authenticated: false },
      models: { default: "gemini", options: [] },
      authentication: { method: "paste-code", signOut: true },
      install: { managed: { label: "Install official Antigravity", downloadBytes: 1024 } },
    };
    fixture.instances = [primary];
    const openExternal = vi.fn(async () => {});
    const previousDesktop = (window as unknown as { duskDesktop?: unknown }).duskDesktop;
    (window as unknown as { duskDesktop?: unknown }).duskDesktop = { openExternal };
    fixture.apiReply = (path) => {
      if (path === "/api/instances/antigravity-accounts") {
        fixture.instances = [primary, added];
        return { instanceId: added.instanceId, instances: fixture.instances };
      }
      if (path === "/api/instances/antigravity-college/auth/start") {
        return { auth: { phase: "waiting", flowId: "flow-1", authorizationUrl: "https://accounts.google.com/o/oauth2/auth?client_id=test" } };
      }
      return undefined;
    };

    try {
      let currentAt: string | undefined = "engine:antigravity";
      const opened: Array<{ id: string; title: string }> = [];
      const renderAt = () => createElement(
        SubPageContext.Provider,
        {
          value: {
            at: currentAt,
            open: (id, title) => {
              opened.push({ id, title });
              currentAt = id;
            },
            back: () => { currentAt = undefined; },
          },
        },
        createElement(EnginesSettings, { simple: true, more: { id: "m", open: false, onToggle: () => {} } }),
      );

      flushSync(() => root.render(renderAt()));
      expect(host.textContent).toContain("primary@example.test");
      expect(host.textContent).not.toContain("Claude connected");

      flushSync(() => host.querySelector<HTMLButtonElement>('[data-add-account-row="/api/instances/antigravity-accounts"]')!.click());
      const input = document.querySelector<HTMLInputElement>('[data-add-account="/api/instances/antigravity-accounts"] input')!;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      flushSync(() => {
        setter.call(input, "College");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const submit = document.querySelector<HTMLButtonElement>('[data-panel-modal="add-account"] button[type="submit"]')!;
      flushSync(() => submit.click());
      await settle();

      expect(fixture.calls).toContainEqual({
        path: "/api/instances/antigravity-accounts",
        body: { displayName: "College", sourceInstanceId: "antigravity" },
      });
      expect(opened).toEqual([{ id: "engine:antigravity-college", title: "College" }]);

      // Re-render on the navigated page and verify Google paste-code sign-in starts automatically.
      flushSync(() => root.render(renderAt()));
      await settle();

      expect(fixture.calls).toContainEqual({ path: "/api/instances/antigravity-college/auth/start" });
      expect(openExternal).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/auth?client_id=test");
      expect(host.textContent).toContain("Sign in to College");
      expect(host.textContent).toContain("Open Google sign-in again");
      expect(host.textContent).not.toContain("Sign in to Claude");
      expect(host.textContent).not.toContain("Found on this computer");
    } finally {
      (window as unknown as { duskDesktop?: unknown }).duskDesktop = previousDesktop;
    }
  });
});

