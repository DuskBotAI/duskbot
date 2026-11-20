// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BillingOverview, Selection } from "../data/contracts";
import { fixtureCatalog } from "../data/fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const plus: Selection = { license: "personal", members: 1, desktop: "shared-s", size: null, region: "eu-central", interval: "month" };
const pro: Selection = { license: "starter", members: 1, desktop: "shared-m", size: null, region: "eu-central", interval: "month" };
const billingFor = (selection: Selection, offer = true): BillingOverview => ({
  subscription: { id: "sub", bundle: null, selection, status: "active", amountUsd: 20, currentPeriodEnd: Date.UTC(2026, 11, 13), cancelAt: null },
  paymentMethod: null, invoices: [], retention: { offer: offer ? { percent: 30, cycles: 3 } : null, applied: null },
});
const state = vi.hoisted(() => ({
  cloud: {} as Record<string, unknown>,
  session: { toast: (_message: string) => {} },
  usage: { month: { totals: { turns: 42 } }, bots: [{ bot: { routines: [{}, {}, {}] } }, { bot: { routines: [] } }], loading: false },
}));
vi.mock("../data/cloud", () => ({ useCloud: () => state.cloud }));
vi.mock("../data/session", () => ({ useSession: () => state.session }));
vi.mock("../data/usage", () => ({ useAccountUsage: () => state.usage }));

const makeSpies = () => ({ cancel: vi.fn(async (_survey: object | null) => {}), keep: vi.fn(async () => {}), changePlan: vi.fn(async (_selection: Selection, _approved?: number) => {}), retentionStep: vi.fn((_input: object) => {}),
  takeDiscount: vi.fn(async (_reason: string) => {}), updateCard: vi.fn(async () => {}), onClose: vi.fn(() => {}) });
let spies = makeSpies();
beforeEach(() => { spies = makeSpies(); });
const roots: Root[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.innerHTML = ""; vi.restoreAllMocks(); });

async function open(selection: Selection, offer = true) {
  state.cloud = { billing: billingFor(selection, offer), ...spies };
  const { CancelFlow } = await import("./cancel-flow");
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  roots.push(root);
  await act(async () => root.render(createElement(CancelFlow, { open: true, onClose: () => spies.onClose(), catalog: fixtureCatalog })));
}
const title = () => document.querySelector("[role=dialog] h2")?.textContent;
const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === label) ?? null;
const click = async (label: string) => { const b = button(label); expect(b, label).not.toBeNull(); await act(async () => b!.click()); };
const pick = async (label: string) => {
  const input = [...document.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent === label)?.querySelector("input");
  expect(input, label).toBeTruthy();
  await act(async () => input!.click());
};

test("the plan page shows free until someone is on a cloud plan, then plus, pro and team", async () => {
  const { tiersFor } = await import("./Billing");
  expect(tiersFor(false)).toEqual(["free", "starter", "pro"]);
  expect(tiersFor(true)).toEqual(["starter", "pro", "team"]);
});

const text = () => document.body.textContent ?? "";
const toReason = async () => { expect(title()).toBe("before you go"); await click("continue to cancel"); expect(title()).toBe("why are you leaving?"); };

test("step one says what ends, in this person's numbers, with the date the files are deleted", async () => {
  await open(plus);
  expect(title()).toBe("before you go");
  expect(text()).toContain("everything keeps working until 13 Dec 2026");
  expect(text()).toContain("your 2 bots stop working when your mac sleeps");
  expect(text()).toContain("your 3 routines only run while your mac is awake");
  expect(text()).toContain("your dusk cloud files are kept until 12 Jan 2027, then deleted");
  await click("keep my plan");
  expect(spies.onClose).toHaveBeenCalled();
  expect(spies.retentionStep).not.toHaveBeenCalled();
});

test("skipping the reason reaches a cancel at the period's end in three screens, records nothing, then offers restart", async () => {
  await open(plus);
  await toReason();
  await click("continue to cancel");
  expect(title()).toBe("cancel your plan?");
  expect(text()).toContain("your plan ends on 13 Dec 2026, not today");
  await click("cancel on 13 Dec 2026");
  expect(spies.cancel).toHaveBeenCalledWith(null);
  expect(spies.retentionStep).not.toHaveBeenCalled();
  expect(title()).toBe("your plan is cancelled");
  await click("restart plan");
  expect(spies.keep).toHaveBeenCalled();
  expect(spies.onClose).toHaveBeenCalled();
});

test("too expensive: the one-time discount shows under the reason and can be taken", async () => {
  await open(plus);
  await toReason();
  await pick("it's too expensive");
  expect(text()).toContain("30% off your next 3 months");
  expect(button("update your card instead")).toBeNull();
  await click("take 30% off");
  expect(spies.takeDiscount).toHaveBeenCalledWith("price");
  expect(spies.cancel).not.toHaveBeenCalled();
});

test("too expensive on pro without the discount: offers plus, recorded with the offer", async () => {
  await open(pro, false);
  await toReason();
  await pick("it's too expensive");
  expect(button("take 30% off")).toBeNull();
  await click("switch to plus");
  expect(spies.changePlan).toHaveBeenCalledWith(expect.objectContaining({ desktop: "shared-s", license: "starter" }), 0);
  expect(spies.retentionStep).toHaveBeenLastCalledWith({ reason: "price", step: "help", outcome: "downgrade", offer: "downgrade" });
});

test("too expensive and cancelled anyway: the survey carries the reason and the offer shown", async () => {
  await open(plus);
  await toReason();
  await pick("it's too expensive");
  await click("continue to cancel");
  expect(spies.retentionStep).toHaveBeenLastCalledWith({ reason: "price", step: "reason", outcome: "shown", offer: "discount" });
  await click("cancel on 13 Dec 2026");
  expect(spies.cancel).toHaveBeenCalledWith({ answer: "price", offer: "discount" });
});

test("something broke: fix links, and keeping the plan is recorded", async () => {
  await open(plus);
  await toReason();
  await pick("something broke");
  expect([...document.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(expect.arrayContaining(["/cloud", expect.stringMatching(/^mailto:hello@dusk\.bot/)]));
  await click("continue to cancel");
  await click("keep my plan");
  expect(spies.retentionStep).toHaveBeenLastCalledWith({ reason: "broken", step: "confirm", outcome: "kept", offer: "help" });
  expect(spies.cancel).not.toHaveBeenCalled();
});

test("switching asks what's missing; keeping the plan keeps the note", async () => {
  await open(plus);
  await toReason();
  await pick("i'm switching to something else");
  const box = document.querySelector("textarea")!;
  expect(document.querySelector(`label[for="${box.id}"]`)?.textContent).toBe("what's missing? (optional)");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "a linux app");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("keep my plan");
  expect(spies.retentionStep).toHaveBeenLastCalledWith({ reason: "switching", step: "reason", outcome: "kept", offer: "note", note: "a linux app" });
});

test("not using it shows what the bots did; a plan with a work license ends only the dusk cloud", async () => {
  await open(pro);
  expect(text()).toContain("your dusk cloud keeps working until 13 Dec 2026. your work license stays.");
  await click("continue to cancel");
  await pick("i'm not using it");
  expect(text()).toContain("this month your 2 bots took 42 turns.");
  await click("continue to cancel");
  expect(title()).toBe("cancel your dusk cloud?");
  await click("cancel on 13 Dec 2026");
  expect(spies.changePlan).toHaveBeenCalledWith({ ...pro, desktop: "none", size: null });
  expect(spies.retentionStep).toHaveBeenLastCalledWith({ reason: "unused", step: "confirm", outcome: "cancelled", offer: "help" });
  expect(title()).toBe("your dusk cloud is cancelled");
});

test("pro on a free trial cancels the whole plan at the trial's end, never a plan change that bills at once", async () => {
  const until = Date.now() + 3 * 86_400_000;
  const billing = billingFor(pro, false);
  billing.subscription = { ...billing.subscription!, currentPeriodEnd: until, trialEndsAt: until };
  state.cloud = { billing, ...spies };
  const { CancelFlow } = await import("./cancel-flow");
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  roots.push(root);
  await act(async () => root.render(createElement(CancelFlow, { open: true, onClose: () => spies.onClose(), catalog: fixtureCatalog })));
  await toReason();
  await pick("i'm switching to something else");
  await click("continue to cancel");
  expect(title()).toBe("cancel your plan?");
  expect(text()).toContain("you won't be charged.");
  expect(text()).not.toContain("work license stays");
  await click(`cancel on ${(await import("../lib/format")).longDate(until)}`);
  expect(spies.cancel).toHaveBeenCalledWith({ answer: "switching", offer: "note" });
  expect(spies.changePlan).not.toHaveBeenCalled();
});
