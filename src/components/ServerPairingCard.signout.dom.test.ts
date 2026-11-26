// @vitest-environment happy-dom
import { act, createElement, Fragment, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const { api, FakeApiError } = vi.hoisted(() => {
  class HoistedApiError extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  }
  return { api: vi.fn(), FakeApiError: HoistedApiError };
});

vi.mock("@/state/store", () => ({ api, ApiError: FakeApiError }));
vi.mock("@/lib/user-presence", () => ({ requireUserPresence: vi.fn(async () => true) }));
vi.mock("@/lib/companion-bridge", () => ({ companionBridge: () => null }));
vi.mock("../lib/session", async (original) => ({
  ...await original<typeof import("../lib/session")>(),
  readSessionState: async () => ({ kind: "loopback" }),
}));
vi.mock("motion/react", async (original) => {
  const actual = await original<typeof import("motion/react")>();
  const strip = ({ initial: _i, animate: _a, exit: _e, transition: _t, ...rest }: Record<string, unknown>) => rest;
  const motion = new Proxy({}, { get: (_, tag: string) => (props: Record<string, unknown>) => createElement(tag, strip(props)) });
  return { ...actual, motion, AnimatePresence: ({ children }: { children: ReactNode }) => createElement(Fragment, null, children), useReducedMotion: () => true };
});

import { MobilePairingCard } from "./MobilePairingCard";
import { ServerPairingCard, type PairedDevice } from "./ServerPairingCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

const iphone: PairedDevice = {
  id: "sess-iphone",
  label: "iPhone",
  scopes: ["admin", "client"],
  lastSeenAt: Date.now() - 8 * 60_000,
  expiresAt: Date.now() + 86_400_000,
};

beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  api.mockReset();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host.remove();
});

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const signOutButton = () => [...host.querySelectorAll<HTMLButtonElement>('[data-settings-block="paired-sessions"] button')]
  .find((button) => button.textContent?.trim() === "Sign out");

describe("Signed-in devices Sign out", () => {
  it("signs out a device on a cloud phone page, disables while in flight, and removes the row", async () => {
    let sessions: PairedDevice[] = [iphone];
    let resolveDelete: (() => void) | undefined;
    api.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === "/api/mobile/devices") return { devices: [], current: null };
      if (path === "/api/auth/sessions") return { sessions, current: null };
      if (path === "/api/config") return { computerName: "" };
      if (path === "/api/auth/sessions/sess-iphone" && init?.method === "DELETE") {
        await new Promise<void>((resolve) => { resolveDelete = resolve; });
        sessions = [];
        return { ok: true };
      }
      throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
    });

    await act(async () => {
      root = createRoot(host);
      root.render(createElement(MobilePairingCard, {
        remote: false,
        cloudHome: true,
        children: (phone) => createElement(ServerPairingCard, { phone, cloudHome: true, simple: true }),
      }));
    });
    await flush();

    const button = signOutButton()!;
    expect(button).toBeDefined();
    await act(async () => { button.click(); });
    expect(signOutButton()?.disabled).toBe(true);

    await act(async () => { resolveDelete?.(); });
    await flush();
    expect(host.querySelector('[data-settings-block="paired-sessions"]')?.textContent).toContain("No devices paired yet.");
    expect(signOutButton()).toBeUndefined();
  });

  it("clears a stale row when DELETE answers 404 instead of silently doing nothing", async () => {
    let sessions: PairedDevice[] = [iphone];
    api.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === "/api/mobile/devices") return { devices: [], current: null };
      if (path === "/api/auth/sessions") return { sessions, current: null };
      if (path === "/api/config") return { computerName: "Mac" };
      if (path === "/api/auth/sessions/sess-iphone" && init?.method === "DELETE") {
        sessions = [];
        throw new FakeApiError("no such session", 404);
      }
      throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
    });

    await act(async () => {
      root = createRoot(host);
      root.render(createElement(MobilePairingCard, {
        remote: false,
        cloudHome: true,
        children: (phone) => createElement(ServerPairingCard, { phone, cloudHome: true, simple: true }),
      }));
    });
    await flush();

    await act(async () => { signOutButton()!.click(); });
    await flush();
    expect(host.querySelector('[data-settings-block="paired-sessions"]')?.textContent).toContain("No devices paired yet.");
    expect(host.querySelector('[data-settings-block="paired-sessions"] [role="alert"]')).toBeNull();
  });

  it("shows a visible error inside Signed-in devices when sign-out fails on a cloud phone page or elsewhere page", async () => {
    api.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === "/api/mobile/devices") return { devices: [], current: null };
      if (path === "/api/auth/sessions") return { sessions: [iphone], current: null };
      if (path === "/api/config") return { computerName: "Mac" };
      if (path === "/api/auth/sessions/sess-iphone" && init?.method === "DELETE") {
        throw new FakeApiError("Server temporarily unavailable", 503);
      }
      throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
    });

    await act(async () => {
      root = createRoot(host);
      root.render(createElement(MobilePairingCard, {
        remote: false,
        cloudHome: true,
        children: (phone) => createElement(ServerPairingCard, { phone, cloudHome: true, simple: true }),
      }));
    });
    await flush();

    await act(async () => { signOutButton()!.click(); });
    await flush();
    const alert = host.querySelector('[data-settings-block="paired-sessions"] [role="alert"]');
    expect(alert?.textContent).toContain("Server temporarily unavailable");
    expect(alert?.closest("[hidden]")).toBeNull();

    await act(async () => root.unmount());
    await act(async () => {
      root = createRoot(host);
      root.render(createElement(ServerPairingCard, { elsewhere: { connect: null } }));
    });
    await flush();

    await act(async () => { signOutButton()!.click(); });
    await flush();
    expect(host.querySelector('[data-settings-block="paired-sessions"] [role="alert"]')?.textContent).toContain("Server temporarily unavailable");
  });

  it("keeps Linked phones and Signed-in devices in sync in both directions", async () => {
    let devices = [{ id: "dev-iphone", name: "iPhone", platform: "ios", createdAt: 1, lastSeenAt: Date.now(), expiresAt: Date.now() + 86_400_000, relay: true, push: null }];
    let sessions: PairedDevice[] = [iphone];
    api.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === "/api/mobile/devices") return { devices, current: null };
      if (path === "/api/auth/sessions") return { sessions, current: null };
      if (path === "/api/config") return { computerName: "Mac" };
      if (path === "/api/mobile/devices/dev-iphone" && init?.method === "DELETE") {
        devices = [];
        sessions = [];
        return { ok: true };
      }
      if (path === "/api/auth/sessions/sess-iphone" && init?.method === "DELETE") {
        devices = [];
        sessions = [];
        return { ok: true };
      }
      throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
    });

    // Removing from Linked phones clears Signed-in devices too
    await act(async () => {
      root = createRoot(host);
      root.render(createElement(MobilePairingCard, {
        remote: false,
        children: (phone) => createElement(ServerPairingCard, { phone, simple: true }),
      }));
    });
    await flush();
    expect(signOutButton()).toBeDefined();
    const removeButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Remove")!;
    await act(async () => { removeButton.click(); });
    await flush();
    expect(signOutButton()).toBeUndefined();

    // Signing out from Signed-in devices clears Linked phones too
    devices = [{ id: "dev-iphone", name: "iPhone", platform: "ios", createdAt: 1, lastSeenAt: Date.now(), expiresAt: Date.now() + 86_400_000, relay: true, push: null }];
    sessions = [iphone];
    await act(async () => root.unmount());
    await act(async () => {
      root = createRoot(host);
      root.render(createElement(MobilePairingCard, {
        remote: false,
        children: (phone) => createElement(ServerPairingCard, { phone, simple: true }),
      }));
    });
    await flush();
    await act(async () => { signOutButton()!.click(); });
    await flush();
    expect(signOutButton()).toBeUndefined();
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Remove")).toBeUndefined();
  });
});
