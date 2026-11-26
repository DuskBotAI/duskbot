// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { sessionCheck, sessionEnded } from "@/lib/session-ended";
import { api } from "@/state/api";
import { MOBILE_LINK_VERSION, mobileLinkUrl, universalPairLink, type MobileConnectionRecord, type MobileLinkPayload } from "../../../shared/mobile-link";
import { holdSignInForService } from "../account/environment";
import { PlatformContext, SecretsLocked, webPlatform, type MobilePlatform } from "../platform";
import { ConnectionGate, pairedButUnreachable } from "./ConnectionGate";
import { PairError } from "./pair";
import { AccountGate } from "../account/AccountGate";

vi.mock("@/components/Avatar", () => ({ MausAvatar: () => createElement("span") }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const record = (id: string, label: string): MobileConnectionRecord => ({
  id, environmentId: `env-${id}`, label, transport: "https", origin: `https://${id}.example.test`, sessionRef: `token.${id}`,
  capabilities: {} as MobileConnectionRecord["capabilities"], addedAt: 1, lastUsedAt: 1,
});
let host: HTMLDivElement, root: Root, platform: MobilePlatform, prefs: Map<string, string>;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  setLocale("en");
  host = document.createElement("div"); document.body.append(host);
  prefs = new Map([["dusk.mobile.connections.v1", JSON.stringify([record("mac", "Studio Mac"), record("vps", "Box")])], ["dusk.mobile.active.v1", "mac"]]);
  const secrets = new Map([["token.mac", "mac-token"], ["token.vps", "vps-token"]]);
  platform = { ...webPlatform(),
    prefs: { get: async (key) => prefs.get(key) ?? null, set: async (key, value) => { prefs.set(key, value); }, remove: async (key) => { prefs.delete(key); } },
    secrets: { get: async (key) => secrets.get(key) ?? null, set: async (key, value) => { secrets.set(key, value); }, remove: async (key) => { secrets.delete(key); } },
  };
  fetcher = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", fetcher);
  // happy-dom has no EventSource; the installed transport wraps it
  vi.stubGlobal("EventSource", class {});
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const mount = () => act(async () => {
  root = createRoot(host);
  root.render(createElement(PlatformContext, { value: platform }, createElement(ConnectionGate, null, createElement("p", null, "home"))));
});
const settle = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); });
const click = (text: string) => act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent?.includes(text))!.click(); });

it("an offline server at launch keeps the link, retries, and offers the other saved installations", async () => {
  fetcher.mockRejectedValue(new TypeError("offline"));
  await mount(); await settle();
  expect(host.querySelector("h1")?.textContent).toBe("Can't reach Studio Mac");
  expect(host.textContent).not.toContain("Link to your");
  expect(host.textContent).toContain("Box");
  expect(prefs.get("dusk.mobile.active.v1")).toBe("mac");

  fetcher.mockResolvedValue(new Response("{}"));
  await click("Try again"); await settle();
  expect(host.textContent).toBe("home");
});

it("a dusk cloud its edge says was deleted is said once, never retried, and Remove takes it off and opens the next place", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fetcher.mockImplementation(async (input) => String(input).startsWith("https://mac.example.test")
    ? new Response("This dusk bot was deleted.", { status: 410, headers: { "x-dusk-cloud-power": "gone" } })
    : new Response("{}"));
  await mount(); await settle();
  expect(host.querySelector("h1")?.textContent).toBe("Studio Mac was deleted");
  expect(host.textContent).not.toContain("Try again");
  const asked = fetcher.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
  window.dispatchEvent(new Event("online"));
  await settle();
  expect(fetcher.mock.calls.length).toBe(asked);
  await click("Remove from this phone"); await settle();
  expect(JSON.parse(prefs.get("dusk.mobile.connections.v1")!).map((entry: MobileConnectionRecord) => entry.id)).toEqual(["vps"]);
  expect(prefs.get("dusk.mobile.active.v1")).toBe("vps");
  expect(host.textContent).toBe("home");
  vi.useRealTimers();
});

it("the unreachable screen tries again as soon as the app is back in front or on another network", async () => {
  const resumed = new Set<() => void>(), moved = new Set<() => void>();
  platform = { ...platform,
    onResume: (listener) => { resumed.add(listener); return () => resumed.delete(listener); },
    onNetworkChange: (listener) => { moved.add(listener); return () => moved.delete(listener); } };
  fetcher.mockRejectedValue(new TypeError("offline"));
  await mount(); await settle();
  expect(host.querySelector("h1")?.textContent).toBe("Can't reach Studio Mac");
  fetcher.mockResolvedValue(new Response("{}"));
  await act(async () => { for (const listener of resumed) listener(); }); await settle();
  expect(host.textContent).toBe("home");
  await act(async () => root.unmount());
  fetcher.mockRejectedValue(new TypeError("offline"));
  await mount(); await settle();
  expect(host.querySelector("h1")?.textContent).toBe("Can't reach Studio Mac");
  fetcher.mockResolvedValue(new Response("{}"));
  await act(async () => { for (const listener of moved) listener(); }); await settle();
  expect(host.textContent).toBe("home");
});

it("switches to another saved installation from the unreachable screen", async () => {
  fetcher.mockImplementation(async (input) => String(input).startsWith("https://vps.") ? new Response("{}") : Promise.reject(new TypeError("offline")));
  await mount(); await settle();
  await click("Box"); await settle();
  expect(prefs.get("dusk.mobile.active.v1")).toBe("vps");
  expect(host.textContent).toBe("home");
});

it("a refused place at launch is kept, and the phone opens its other saved place instead of pairing", async () => {
  fetcher.mockImplementation(async (input) => String(input instanceof Request ? input.url : input).startsWith("https://mac.") ? new Response("{}", { status: 401 }) : new Response("{}"));
  await mount(); await settle(); await settle();
  expect(host.textContent).toBe("home");
  expect(prefs.get("dusk.mobile.active.v1")).toBe("vps");
  expect(prefs.get("dusk.mobile.connections.v1")).toContain("Studio Mac");
});

it("when every saved place refuses, the link stays and the phone keeps trying, with link again and remove as the person's choice", async () => {
  fetcher.mockResolvedValue(new Response("{}", { status: 401 }));
  await mount(); await settle(); await settle();
  expect(host.querySelector("h1")?.textContent).toContain("Can't reach");
  expect(host.textContent).toContain("didn't take this phone's link");
  expect(prefs.get("dusk.mobile.connections.v1")).toContain("Studio Mac");
  expect(prefs.get("dusk.mobile.connections.v1")).toContain("Box");
  expect(host.querySelector("[data-testid=mobile-refused-link]")).not.toBeNull();
  await act(async () => { host.querySelector<HTMLButtonElement>("[data-testid=mobile-refused-remove]")!.click(); });
  await settle();
  expect(JSON.parse(prefs.get("dusk.mobile.connections.v1")!).map((entry: MobileConnectionRecord) => entry.id), "only the person's remove deletes").toHaveLength(1);
});

it("a phone removed on the computer while the app is open never loses the link by itself", async () => {
  fetcher.mockResolvedValue(new Response("{}"));
  await mount(); await settle();
  expect(host.textContent).toBe("home");
  fetcher.mockImplementation(async (input) => String(input instanceof Request ? input.url : input).startsWith("https://mac.") ? new Response('{"error":"unauthorized"}', { status: 401 }) : new Response("{}"));
  await act(async () => { await api("/api/bots").catch(() => {}); await sessionCheck(); });
  await settle(); await settle();
  expect(prefs.get("dusk.mobile.connections.v1")).toContain("Studio Mac");
  expect(prefs.get("dusk.mobile.active.v1")).toBe("vps");
  expect(sessionEnded()).toBe(false);
});

it("a Keychain it cannot read at launch (a locked phone) never shows pairing: it waits and reads again in front", async () => {
  let locked = true;
  const resumed = new Set<() => void>();
  const read = platform.secrets.get;
  platform = { ...platform, secrets: { ...platform.secrets, get: async (key) => { if (locked) throw new SecretsLocked(); return read(key); } },
    onResume: (listener) => { resumed.add(listener); return () => resumed.delete(listener); } };
  fetcher.mockResolvedValue(new Response("{}"));
  await mount(); await settle();
  expect(host.textContent).not.toContain("Link");
  expect(host.textContent).not.toBe("home");
  expect(prefs.get("dusk.mobile.active.v1")).toBe("mac");
  locked = false;
  await act(async () => { for (const listener of resumed) listener(); });
  await settle(); await settle();
  expect(host.textContent).toBe("home");
});

it("a refused request on a session that still answers changes nothing", async () => {
  fetcher.mockResolvedValue(new Response("{}"));
  await mount(); await settle();
  fetcher.mockImplementation(async (input) => String(input instanceof Request ? input.url : input).endsWith("/api/auth/session") ? new Response("{}") : new Response("{}", { status: 401 }));
  await act(async () => { await api("/api/bots").catch(() => {}); await sessionCheck(); });
  await settle();
  expect(host.textContent).toBe("home");
  expect(prefs.get("dusk.mobile.active.v1")).toBe("mac");
});

it("a dusk cloud asleep at launch opens on its chats and is woken, never the can't reach screen it could not leave", async () => {
  // the edge never wakes a cloud for a read, so the launch check only ever hears that it sleeps
  fetcher.mockImplementation(async (input, init) => {
    const method = (input instanceof Request ? input.method : init?.method) ?? "GET";
    return method === "GET" ? new Response("asleep", { status: 503, headers: { "x-dusk-cloud-power": "asleep", "retry-after": "5" } }) : new Response("{}");
  });
  await mount(); await settle();
  expect(host.textContent).toBe("home");
  const posts = fetcher.mock.calls.filter(([input, init]) => ((input instanceof Request ? input.method : init?.method) ?? "GET") === "POST");
  expect(posts.map(([input]) => String(input instanceof Request ? input.url : input))).toContain("https://mac.example.test/api/cloud/wake");
});

describe("two accounts, each with its own dusk cloud", () => {
  const cloudOrigin = "https://d2222222222222222222b.dusk.bot";
  const tokenOf = (who: string) => `omc_${who[0]!.repeat(43)}`;
  const kept = (id: string) => ({ origin: "https://dusk.bot", token: tokenOf(id), expiresAt: Date.now() + 86_400_000, deviceId: "phone", account: { id, email: `${id}@example.com` } });
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  let secrets: Map<string, string>;
  const asked = (path: string) => fetcher.mock.calls.filter(([input]) => String(input).endsWith(path));
  const authOf = (call: Parameters<typeof fetch>) => (call[1]?.headers as Record<string, string> | undefined)?.authorization;
  const bobCloud = (tagged: boolean): MobileConnectionRecord => ({ ...record("bob-cloud", "Bob cloud"), origin: cloudOrigin, ...(tagged ? { account: { id: "bob", email: "bob@example.com" } } : {}) });
  const start = async (cloud: MobileConnectionRecord) => {
    vi.stubEnv("VITE_DUSK_ALLOW_SIGNED_OUT", ""); vi.stubEnv("VITE_DUSK_ACCOUNT_ORIGIN", "");
    secrets = new Map([["token.bob-cloud", "cloud-token"], ["dusk.account", JSON.stringify(kept("alice"))], ["dusk.account.others", JSON.stringify([kept("bob")])]]);
    prefs = new Map([["dusk.mobile.connections.v1", JSON.stringify([cloud])], ["dusk.mobile.active.v1", "bob-cloud"], ["dusk.mobile.installed", "1"]]);
    platform = { ...platform, native: true, kind: "android",
      prefs: { get: async (key) => prefs.get(key) ?? null, set: async (key, value) => { prefs.set(key, value); }, remove: async (key) => { prefs.delete(key); } },
      secrets: { get: async (key) => secrets.get(key) ?? null, set: async (key, value) => { secrets.set(key, value); }, remove: async (key) => { secrets.delete(key); } },
      onAppUrl: () => () => {}, onResume: () => () => {} };
    fetcher.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith(cloudOrigin)) return json({});
      if (url.endsWith("/api/cloud/desktop/session")) {
        const bob = authOf([input, init]) ===`Bearer ${tokenOf("bob")}`;
        return json({ clouds: bob ? [{ id: "cb", role: "owner", teamId: null, status: "ready", origin: cloudOrigin, name: "Bob cloud" }] : [], teams: [] });
      }
      return json({ error: "not_found" }, 404);
    });
    await act(async () => {
      root = createRoot(host);
      root.render(createElement(PlatformContext, { value: platform }, createElement(AccountGate, null, createElement(ConnectionGate, null, createElement("p", null, "home")))));
    });
    for (let i = 0; i < 30 && JSON.parse(secrets.get("dusk.account")!).account.id !== "bob"; i++) await settle();
    await settle();
  };
  afterEach(() => { vi.unstubAllEnvs(); });

  it("opening the other account's cloud puts that account in use and keeps the first one signed in", async () => {
    await start(bobCloud(true));
    expect(host.textContent).toBe("home");
    expect(JSON.parse(secrets.get("dusk.account")!).account.id).toBe("bob");
    expect(JSON.parse(secrets.get("dusk.account.others")!).map((one: { account: { id: string } }) => one.account.id)).toEqual(["alice"]);
    expect(asked("/v1/app/enroll-grant").map(authOf).filter((auth) => auth === `Bearer ${tokenOf("alice")}`), "never enrolled into the other account").toEqual([]);
  });

  it("a cloud linked before the phone knew whose it was is tagged with the account that lists it, which takes over", async () => {
    await start(bobCloud(false));
    expect(JSON.parse(secrets.get("dusk.account")!).account.id).toBe("bob");
    expect(JSON.parse(prefs.get("dusk.mobile.connections.v1")!)[0].account).toEqual({ id: "bob", email: "bob@example.com" });
    expect(asked("/v1/app/enroll-grant").map(authOf).filter((auth) => auth === `Bearer ${tokenOf("alice")}`)).toEqual([]);
  });
});

it("keeps a pairing the computer accepted when the first connect fails, and drops only a refused one", () => {
  expect(pairedButUnreachable(new PairError("unreachable"))).toBe(true);
  expect(pairedButUnreachable(new TypeError("Load failed"))).toBe(true);
  expect(pairedButUnreachable(new PairError("refused"))).toBe(false);
});

it("the unreachable screen with no other saved places still lets the person open another place or remove it", async () => {
  prefs.set("dusk.mobile.connections.v1", JSON.stringify([record("mac", "Studio Mac")]));
  fetcher.mockRejectedValue(new TypeError("offline"));
  await mount(); await settle();
  expect(host.querySelector("h1")?.textContent).toBe("Can't reach Studio Mac");
  expect(host.querySelector("[data-testid=mobile-unreachable-add]")).not.toBeNull();
  expect(host.querySelector("[data-testid=mobile-unreachable-remove]")).not.toBeNull();

  await act(async () => { host.querySelector<HTMLButtonElement>("[data-testid=mobile-unreachable-add]")!.click(); });
  await settle();
  expect(host.querySelector("h1")?.textContent).toBe("Link another computer");
  await act(async () => { host.querySelector<HTMLButtonElement>("button[aria-label='Close']")!.click(); });
  await settle();
  expect(host.querySelector("h1")?.textContent).toBe("Can't reach Studio Mac");

  await act(async () => { host.querySelector<HTMLButtonElement>("[data-testid=mobile-unreachable-remove]")!.click(); });
  await settle();
  expect(JSON.parse(prefs.get("dusk.mobile.connections.v1")!)).toEqual([]);
  expect(host.querySelector("h1")?.textContent).toBe("Your bots, on your phone");
});

it("switching or opening another place works while a retry is still in flight", async () => {
  fetcher.mockRejectedValueOnce(new TypeError("offline"));
  await mount(); await settle();
  expect(host.querySelector("h1")?.textContent).toBe("Can't reach Studio Mac");

  let aborted = false;
  fetcher.mockImplementation(async (input, init) => {
    if (String(input).startsWith("https://vps.")) return new Response("{}");
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("aborted", "AbortError")); }, { once: true });
    });
  });
  await click("Try again");
  expect(host.textContent).toContain("Trying again...");
  expect(host.querySelector<HTMLButtonElement>("[data-testid=mobile-unreachable-add]")?.disabled).toBe(false);
  const boxButton = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Box"))!;
  expect(boxButton.disabled).toBe(false);

  await act(async () => { boxButton.click(); });
  await settle();
  expect(aborted).toBe(true);
  expect(prefs.get("dusk.mobile.active.v1")).toBe("vps");
  expect(host.textContent).toBe("home");
});

it("when signed in, opening another place from the unreachable screen shows the account's places", async () => {
  vi.stubEnv("VITE_DUSK_ALLOW_SIGNED_OUT", ""); vi.stubEnv("VITE_DUSK_ACCOUNT_ORIGIN", "");
  const kept = { origin: "https://dusk.bot", token: `omc_${"a".repeat(43)}`, expiresAt: Date.now() + 86_400_000, deviceId: "phone", account: { id: "alice", email: "alice@example.com" } };
  const secrets = new Map([["token.mac", "mac-token"], ["dusk.account", JSON.stringify(kept)]]);
  prefs = new Map([["dusk.mobile.connections.v1", JSON.stringify([record("mac", "Studio Mac")])], ["dusk.mobile.active.v1", "mac"], ["dusk.mobile.installed", "1"]]);
  platform = { ...platform, native: true, kind: "android",
    prefs: { get: async (key) => prefs.get(key) ?? null, set: async (key, value) => { prefs.set(key, value); }, remove: async (key) => { prefs.delete(key); } },
    secrets: { get: async (key) => secrets.get(key) ?? null, set: async (key, value) => { secrets.set(key, value); }, remove: async (key) => { secrets.delete(key); } },
    onAppUrl: () => () => {}, onResume: () => () => {} };
  fetcher.mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith("https://mac.example.test")) throw new TypeError("offline");
    if (url.endsWith("/api/cloud/desktop/session")) {
      return new Response(JSON.stringify({ clouds: [{ id: "c1", role: "owner", teamId: null, status: "ready", asleep: false, origin: "https://c1.dusk.bot", name: "Alice Cloud" }], teams: [], computers: [] }));
    }
    if (url.endsWith("/v1/app/session")) return new Response(JSON.stringify({ account: kept.account }));
    return new Response("{}", { status: 404 });
  });
  await act(async () => {
    root = createRoot(host);
    root.render(createElement(PlatformContext, { value: platform }, createElement(AccountGate, null, createElement(ConnectionGate, null, createElement("p", null, "home")))));
  });
  await settle(); await settle();
  expect(host.querySelector("h1")?.textContent).toBe("Can't reach Studio Mac");
  await act(async () => { host.querySelector<HTMLButtonElement>("[data-testid=mobile-unreachable-add]")!.click(); });
  await settle(); await settle();
  expect(host.querySelector("[data-testid=mobile-cloud-picker]")).not.toBeNull();
  expect(host.textContent).toContain("Alice Cloud");
  vi.unstubAllEnvs();
});

it("restores a held universal pairing QR after a service-switch reload", async () => {
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => { saved.set(key, value); },
    removeItem: (key: string) => { saved.delete(key); },
  });
  const linkPayload: MobileLinkPayload = {
    v: MOBILE_LINK_VERSION,
    workspace: { name: "Emil PC", environmentId: "env-pc", kind: "mac" },
    grant: { id: "g-pc", secret: "s3cret", expiresAt: Date.now() + 600_000 },
    via: [{ kind: "https", url: "https://pc.example.test" }],
  };
  const qr = universalPairLink(mobileLinkUrl(linkPayload), "ABCD-EFGH-JKLM", { code: "WXYZQRST", email: "owner@example.test", serviceOrigin: "https://dusk.bot" });
  holdSignInForService("https://dusk.bot", qr);
  prefs = new Map();
  platform = { ...platform, native: true, onAppUrl: () => () => {} };
  await mount(); await settle();
  expect(host.querySelector("h1")?.textContent).toBe("Link this phone to Emil PC?");
});
