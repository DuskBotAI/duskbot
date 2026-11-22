// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ path: string; body?: unknown }> = [];
let signIn = { admins: [] as string[], members: ["qa-person@example.com"] };
let publicUrl: string | null = null;
let saveFails = false;

vi.mock("@/state/store", () => ({
  api: vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "PUT") {
      if (saveFails) throw new Error("save failed");
      const body = JSON.parse(init.body ?? "{}");
      calls.push({ path, body });
      signIn = body.signIn;
      return {};
    }
    if (path === "/api/config") return { signIn };
    if (path === "/api/settings/custom-domain") return { publicUrl };
    return null;
  }),
}));
vi.mock("../lib/session", async (load) => ({ ...(await load<object>()), readSessionState: async () => ({ kind: "loopback" }) }));

const { PeopleSection } = await import("./PeopleSection");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const settle = () => act(async () => { await new Promise((done) => setTimeout(done, 350)); });
const button = (label: string, within: ParentNode = host) =>
  [...within.querySelectorAll("button")].find((element) => element.textContent === label) as HTMLButtonElement;
const confirmDialog = () => document.querySelector<HTMLElement>("[role=alertdialog]");

async function mount() {
  act(() => root.render(createElement(PeopleSection)));
  await settle();
}

beforeEach(() => {
  calls.length = 0;
  signIn = { admins: [], members: ["qa-person@example.com"] };
  publicUrl = null;
  saveFails = false;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ capabilities: { emailSignIn: false } }), { status: 200 })));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("people actions", () => {
  it("says up front that an invite link on this computer's own address opens only here", async () => {
    expect(window.location.hostname).toBe("localhost");
    await mount();
    expect(host.textContent).toContain("invite links only open on this computer");
  });

  it("warns about nothing on a server with a public address, even before anyone is on the list", async () => {
    signIn = { admins: [], members: [] };
    publicUrl = "https://acme.example.test";
    await mount();
    expect(host.textContent).not.toContain("only open on this computer");
    expect(host.textContent).not.toContain("Email sign-in is not enabled");
  });

  it("asks before removing someone, and keeps them on Cancel", async () => {
    await mount();
    act(() => button("Remove").click());
    await settle();
    expect(confirmDialog()?.textContent).toContain("Remove qa-person@example.com?");
    act(() => button("Cancel", confirmDialog()!).click());
    await settle();
    expect(calls).toEqual([]);
  });

  it("removes someone once confirmed and drops their invite link", async () => {
    await mount();
    act(() => (host.querySelector('[aria-label="Invite link"]') as HTMLButtonElement).click());
    expect(host.textContent).toContain("/pair?email=qa-person%40example.com");
    act(() => button("Remove").click());
    await settle();
    act(() => button("Remove", confirmDialog()!).click());
    await settle();
    expect(calls).toEqual([{ path: "/api/config", body: { signIn: { admins: [], members: [] } } }]);
    expect(host.textContent).not.toContain("/pair?email=");
  });

  it("keeps the person and their invite link when the removal does not save", async () => {
    saveFails = true;
    await mount();
    act(() => (host.querySelector('[aria-label="Invite link"]') as HTMLButtonElement).click());
    act(() => button("Remove").click());
    await settle();
    act(() => button("Remove", confirmDialog()!).click());
    await settle();
    expect(host.textContent).toContain("qa-person@example.com");
    expect(host.textContent).toContain("/pair?email=qa-person%40example.com");
  });

  it("asks before making someone an admin", async () => {
    await mount();
    act(() => button("Make admin").click());
    await settle();
    expect(confirmDialog()?.textContent).toContain("Make qa-person@example.com an admin?");
    expect(calls).toEqual([]);
    act(() => button("Make admin", confirmDialog()!).click());
    await settle();
    expect(calls).toEqual([{ path: "/api/config", body: { signIn: { admins: ["qa-person@example.com"], members: [] } } }]);
  });
});
