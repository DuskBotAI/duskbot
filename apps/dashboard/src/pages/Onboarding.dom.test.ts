// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { fixtureCatalog } from "../data/fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  query: "step=plan",
  os: "windows" as string,
  moved: [] as string[],
  finish: vi.fn(async (_home?: string) => {}),
  checkout: vi.fn(async () => true),
  profileName: "Sam",
  signInName: undefined as string | undefined,
  update: vi.fn(async (_name: string) => {}),
  tracked: [] as unknown[][],
  query0: "",
  trialDays: undefined as number | undefined,
  billing: null as unknown,
}));
vi.mock("../data/cloud", () => ({
  useCloud: () => ({ account: { profile: { name: state.profileName, onboarded: false } }, catalog: { ...fixtureCatalog, checkoutOpen: true, ...(state.trialDays ? { trialDays: state.trialDays } : {}) }, billing: state.billing, clouds: [],
    checkout: state.checkout, updateProfile: state.update, finishOnboarding: state.finish }),
}));
vi.mock("../data/session", () => ({ useSession: () => ({ account: { id: "a", email: "sam@qa.dusk.test", ...(state.signInName !== undefined ? { name: state.signInName } : {}) }, setAccount: () => {}, toast: () => {} }) }));
vi.mock("../lib/router", () => ({ useLocation: () => ({ path: "/welcome", query: new URLSearchParams(state.query) }), navigate: (path: string) => void state.moved.push(path) }));
vi.mock("../lib/analytics", () => ({ track: () => {}, trackOnboardingStep: (...args: unknown[]) => void state.tracked.push(args) }));
vi.mock("../ui/Frame", () => ({ SplitFrame: ({ children }: { children: ReactNode }) => createElement("div", null, children) }));
vi.mock("../ui/Mascot", () => ({ Mascot: () => null }));
vi.mock("../ui/Downloads", async (actual) => ({ ...(await actual<typeof import("../ui/Downloads")>()), Downloads: () => null }));
vi.mock("../lib/downloads", async (actual) => ({ ...(await actual<typeof import("../lib/downloads")>()), detectOs: () => state.os, useReleaseState: () => "out" }));
vi.mock("../ui/Digits", () => ({ StretchPill: () => null }));

const roots: Root[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.innerHTML = ""; state.moved = []; state.query = "step=plan"; state.os = "windows"; state.profileName = "Sam"; state.signInName = undefined; state.trialDays = undefined; state.billing = null; state.tracked = []; sessionStorage.clear(); vi.clearAllMocks(); vi.useRealTimers(); });

async function open() {
  const { Onboarding } = await import("./Onboarding");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(createElement(Onboarding)));
  return host;
}
const press = (host: HTMLElement, label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(label))!;

test("sent by the app, this computer ends the website's steps on the way back to the app and says so to the account", async () => {
  sessionStorage.setItem("dusk.fromApp", "1");
  const host = await open();
  await act(async () => host.querySelector<HTMLInputElement>("#home-free")!.click());
  await act(async () => press(host, "continue with free").click());
  expect(state.finish).toHaveBeenCalledWith("free");
  expect(state.moved.at(-1)).toBe("/app-signed-in?set=1");
});

test("a plan picked records dusk cloud before the checkout opens, so the app can wait on the payment", async () => {
  sessionStorage.setItem("dusk.fromApp", "1");
  const host = await open();
  await act(async () => press(host, "checkout").click());
  expect(state.finish).toHaveBeenCalledWith("cloud");
  expect(state.checkout).toHaveBeenCalledOnce();
});

test("on the website alone, this computer still goes on to getting the app", async () => {
  const host = await open();
  await act(async () => host.querySelector<HTMLInputElement>("#home-free")!.click());
  await act(async () => press(host, "continue with free").click());
  expect(state.finish).not.toHaveBeenCalled();
  expect(state.moved.at(-1)).toContain("step=app");
});

test("signed up here, the app step offers this computer's download as the one big button and says what to do once it is down", async () => {
  state.query = "step=app";
  const host = await open();
  const own = [...host.querySelectorAll("a")].find((a) => a.textContent?.includes("download for windows"))!;
  expect(own.getAttribute("href")).toMatch(/DuskBot-setup\.exe$/);
  expect(host.textContent).not.toContain("protected your pc");
  await act(async () => { own.addEventListener("click", (e) => e.preventDefault()); own.click(); });
  const steps = [...host.querySelectorAll("ol li")].map((li) => li.textContent);
  expect(steps).toHaveLength(3);
  expect(steps[0]).toContain("DuskBot-setup.exe");
  expect(steps[1]).toContain("more info, then run anyway");
  expect(steps[2]).toContain("sam@qa.dusk.test");
  await act(async () => press(host, "go to the dashboard").click());
  expect(state.finish).toHaveBeenCalledWith("free");
});

test("on a phone the app step keeps every download in the list and the dashboard as its button", async () => {
  state.query = "step=app"; state.os = "ios";
  const host = await open();
  expect([...host.querySelectorAll("a")].some((a) => a.textContent?.includes("download for"))).toBe(false);
  expect(press(host, "go to the dashboard").className).toContain("bg-primary");
});

test("a name from the sign-in is saved and the name step is skipped, recorded as skipped", async () => {
  state.query = "step=name"; state.profileName = "Ada Lovelace";
  await open();
  expect(state.moved.at(-1)).toContain("step=plan");
  expect(state.tracked).toEqual([["name", false, true]]);
});

test("a plan picked on the site goes from a sign-in name straight to checkout", async () => {
  state.query = "step=name&plan=plus"; state.profileName = "Ada";
  await open();
  expect(state.checkout).toHaveBeenCalledOnce();
});

test("a plan picked on the site goes from sign-in to checkout with no name step and no summary", async () => {
  state.query = "step=name&plan=plus"; state.profileName = "";
  const host = await open();
  expect(state.checkout).toHaveBeenCalledOnce();
  expect(host.querySelector("#onb-name")).toBeNull();
  expect(host.textContent).not.toContain("cancel any time");
  expect(state.finish).not.toHaveBeenCalled();
});

test("back from checkout, the name is asked, saved, and the first run goes on to the app step", async () => {
  state.query = "step=name"; state.profileName = ""; state.billing = { subscription: { status: "active" } };
  const host = await open();
  const input = host.querySelector<HTMLInputElement>("#onb-name")!;
  expect(input).not.toBeNull();
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Ada"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => press(host, "continue").click());
  expect(state.update).toHaveBeenCalledWith("Ada");
  expect(state.moved.at(-1)).toContain("step=app");
});

test("a sign-in name is kept when checkout is paid first, and the name step is skipped after it", async () => {
  state.query = "step=name"; state.profileName = "Ada"; state.billing = { subscription: { status: "active" } };
  await open();
  expect(state.moved.at(-1)).toContain("step=app");
});

test("back from an abandoned checkout the steps run as usual with the plan still chosen", async () => {
  sessionStorage.setItem("dusk-onboarding-checkout-opened", "1");
  state.query = "step=name&plan=plus"; state.profileName = "";
  const host = await open();
  expect(state.checkout).not.toHaveBeenCalled();
  expect(host.querySelector("#onb-name")).not.toBeNull();
});

test("with no name from the sign-in the name step stays, and shows as reached", async () => {
  state.query = "step=name"; state.profileName = "";
  const host = await open();
  expect(host.querySelector("#onb-name")).not.toBeNull();
  expect(state.update).not.toHaveBeenCalled();
  expect(state.tracked).toEqual([["name", false, false]]);
});

test("back to the name step after it was skipped shows it, so the plan step's back never loops", async () => {
  state.query = "step=name"; state.profileName = "Ada";
  sessionStorage.setItem("dusk-onboarding-name-skipped", "1");
  const host = await open();
  expect(host.querySelector("#onb-name")).not.toBeNull();
  expect(state.tracked).toEqual([["name", false, false]]);
});

const picked = (host: HTMLElement) => host.querySelector('[role="radio"][aria-checked="true"]')?.textContent ?? "";

test("the plan step opens on pro", async () => {
  state.query = "step=plan";
  const host = await open();
  expect(picked(host)).toContain("pro");
});

test("with a trial running, the cloud button says it, and without one it names the price", async () => {
  state.trialDays = 3;
  const trial = await open();
  expect(press(trial, "start 3-day free trial")).toBeDefined();
  expect(press(trial, "continue to checkout")).toBeUndefined();
  document.body.innerHTML = "";
  state.trialDays = undefined;
  const plain = await open();
  expect(press(plain, "continue to checkout, $50/mo")).toBeDefined();
});

test("a plan picked on the site still wins over the pro default", async () => {
  state.query = "step=plan&plan=plus";
  const host = await open();
  expect(picked(host)).toContain("plus");
});

test("a sign-in name the profile does not hold yet is saved before the step is skipped", async () => {
  state.query = "step=name"; state.profileName = ""; state.signInName = "Ada Lovelace";
  await open();
  expect(state.update).toHaveBeenCalledWith("Ada Lovelace");
  expect(state.moved.at(-1)).toContain("step=plan");
});
