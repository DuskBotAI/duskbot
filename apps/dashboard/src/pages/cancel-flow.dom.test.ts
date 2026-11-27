// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BillingOverview, Selection } from "../data/contracts";
import { fixtureCatalog } from "../data/fixtures";
import type { AccountRecap } from "../../../../shared/account-recap";

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
  recap: { recap: null as AccountRecap | null, loading: false },
}));
vi.mock("../data/cloud", () => ({ useCloud: () => state.cloud }));
vi.mock("../data/session", () => ({ useSession: () => state.session }));
vi.mock("../data/usage", () => ({ useAccountUsage: () => state.usage }));
vi.mock("../data/recap", () => ({ useRecap: () => state.recap }));

const makeSpies = () => ({ cancel: vi.fn(async (_survey: object | null) => {}), keep: vi.fn(async () => {}), changePlan: vi.fn(async (_selection: Selection, _approved?: number) => {}), retentionStep: vi.fn((_input: object) => {}),
  updateCard: vi.fn(async () => {}), onClose: vi.fn(() => {}) });
let spies = makeSpies();
const crew = [{ id: "nova", name: "Nova", color: "blue", body: "blob", replies: 1120 }, { id: "quill", name: "Quill", color: "purple", body: "clover", replies: 684 }];
const RECAP: AccountRecap = { v: 1, since: Date.UTC(2026, 2, 4), bots: 2, crew, topBot: crew[0]!, replies: 1804, activeDays: 140, longestStreak: 23, routines: 3, apps: 5, computers: 2 };
beforeEach(() => { spies = makeSpies(); state.recap = { recap: RECAP, loading: false }; });
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
  expect(tiersFor()).toEqual(["starter", "pro", "team"]);
});

const text = () => document.body.textContent ?? "";
const type = async (value: string) => {
  const box = document.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, value);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const dots = () => document.querySelector("[role=dialog] [data-dots]")?.getAttribute("data-dots");
/** the dialog's own buttons at its foot, left to right, without close */
const footButtons = () => [...document.querySelectorAll<HTMLButtonElement>("[role=dialog] button")].filter((b) => !b.hasAttribute("data-close")).slice(-2);
const footer = () => footButtons().map((b) => b.textContent);
/** the left button, the way on toward the cancel, whatever the screen calls it */
const onward = async () => { const [way] = footButtons(); expect(way?.textContent).not.toBe("keep my plan"); await act(async () => way!.click()); };
/** past the recap to the reason step */
const toReason = async () => { expect(title()).toBe("look what you and your bots did"); await onward(); expect(title()).toBe("why are you leaving?"); };
/** the reason step, a reason picked, then on */
const toOffer = async (reason: string) => { await toReason(); await pick(reason); await onward(); };

test("the first screen is a look back in the person's own numbers, with the top bot, and continue to cancel moves on", async () => {
  await open(plus);
  expect(title()).toBe("look what you and your bots did");
  expect(dots()).toBe("1/5");
  expect(text()).toContain("since March 2026");
  const stats = Object.fromEntries([...document.querySelectorAll("[data-stat]")].map((el) => [el.getAttribute("data-stat"), el.textContent]));
  expect(stats).toEqual({ replies: "replies from your bots1,804", days: "days you worked together140", streak: "days in a row, your best streak23", routines: "routines on a schedule3", apps: "apps connected5", bots: "bots you made2" });
  expect(document.querySelector("[data-top-bot]")?.textContent).toBe("Nova did the most: 1,120 replies.");
  expect(document.querySelector("[data-cancel-scene=day]")).toBeTruthy();
  expect(footer()).toEqual(["continue to cancel", "keep my plan"]);
  await onward();
  expect(title()).toBe("why are you leaving?");
  expect(footer()).toEqual(["continue to cancel", "keep my plan"]);
  expect(spies.retentionStep).not.toHaveBeenCalled();
});

test("the recap leaves out what is zero, says so when there is nothing yet, and still moves on while it loads or fails", async () => {
  state.recap = { recap: { ...RECAP, replies: 0, activeDays: 0, longestStreak: 0, routines: 0, apps: 0, bots: 1, topBot: null }, loading: false };
  await open(plus);
  expect([...document.querySelectorAll("[data-stat]")].map((el) => el.getAttribute("data-stat"))).toEqual(["bots"]);
  expect(document.querySelector("[data-top-bot]")).toBeNull();
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
  state.recap = { recap: null, loading: true };
  await open(plus);
  expect(document.querySelector("[aria-busy=true]")).toBeTruthy();
  await onward();
  expect(title()).toBe("why are you leaving?");
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
  state.recap = { recap: null, loading: false };
  await open(plus);
  expect(text()).toContain("your bots are set up and ready whenever you are.");
  await onward();
  expect(title()).toBe("why are you leaving?");
});

test("the reason is required: continue with nothing picked says so and stays; prefer not to say counts and goes straight to what you'd lose", async () => {
  await open(plus);
  await toReason();
  expect(dots()).toBe("2/5");
  expect(document.querySelector("[role=alert]")).toBeNull();
  await onward();
  expect(title()).toBe("why are you leaving?");
  expect(document.querySelector("[role=alert]")?.textContent).toBe("pick one, or choose prefer not to say.");
  expect(spies.retentionStep).not.toHaveBeenCalled();
  await pick("prefer not to say");
  expect(document.querySelector("[role=alert]")).toBeNull();
  await onward();
  expect(spies.retentionStep).toHaveBeenLastCalledWith({ reason: "skip", step: "reason", outcome: "shown", offer: "losses" });
  expect(title()).toBe("what you'd lose");
  expect(dots()).toBe("3/4");
  expect(document.querySelector("[data-cancel-scene=dusk]")).toBeTruthy();
  expect(text()).toContain("Nova and Quill stop working when your mac sleeps");
  expect(text()).toContain("your 3 routines only run while your mac is awake");
  expect(text()).toContain("the 5 apps they use only work while your mac is awake");
  expect(text()).toContain("your dusk cloud's files, and what your bots remember there, are kept until 12 Jan 2027, then deleted");
  expect(footer()).toEqual(["i understand, continue", "keep my plan"]);
  await onward();
  expect(spies.retentionStep).toHaveBeenLastCalledWith({ reason: "skip", step: "help", outcome: "shown", offer: "losses" });
  expect(title()).toBe("cancel your plan?");
  expect(dots()).toBe("4/4");
});

test("what you'd lose names a few bots and counts the rest, and reads plainly without a recap", async () => {
  const { botNames, losses } = await import("./cancel-flow");
  expect(botNames(["Nova", "Quill", "Rivet", "Juno", "Basil"], 6)).toBe("Nova, Quill, Rivet and 3 more");
  expect(botNames(["Nova", "Quill", "Rivet", "Juno"], 4)).toBe("Nova, Quill, Rivet and Juno");
  expect(botNames(["Nova"], 1)).toBe("Nova");
  expect(botNames([], 0)).toBe("your bots");
  expect(losses({ desk: true, work: false, keepsLicense: false, keptUntil: "12 Jan 2027", recap: null }).map((row) => row.text)).toEqual([
    "your bots stop working when your mac sleeps", "routines only run while your mac is awake", "your dusk cloud's files, and what your bots remember there, are kept until 12 Jan 2027, then deleted"]);
  expect(losses({ desk: false, work: true, keepsLicense: false, keptUntil: "12 Jan 2027", recap: RECAP }).map((row) => row.text)).toEqual(["work use is no longer covered. personal use stays free."]);
});

test("the note is optional and labelled", async () => {
  await open(plus);
  await toReason();
  const box = document.querySelector("textarea")!;
  expect(document.querySelector(`label[for="${box.id}"]`)?.textContent).toBe("anything else you'd like us to know? (optional)");
});

test("keep my plan works on every screen before the cancel: it closes, cancels nothing, and logs kept once a reason is picked", async () => {
  await open(pro);
  await click("keep my plan");
  expect(spies.onClose).toHaveBeenCalledTimes(1);
  expect(spies.retentionStep).not.toHaveBeenCalled();
  await toReason();
  await pick("it's too expensive");
  await click("keep my plan");
  expect(spies.retentionStep).toHaveBeenLastCalledWith({ reason: "price", step: "reason", outcome: "kept", offer: "downgrade" });
  await onward();
  expect(title()).toBe("keep it for less");
  await click("keep my plan");
  expect(spies.retentionStep).toHaveBeenLastCalledWith({ reason: "price", step: "help", outcome: "kept", offer: "downgrade" });
  await onward();
  expect(title()).toBe("what you'd lose");
  await click("keep my plan");
  expect(spies.retentionStep).toHaveBeenLastCalledWith({ reason: "price", step: "confirm", outcome: "kept", offer: "downgrade" });
  await onward();
  expect(title()).toBe("cancel your dusk cloud?");
  await click("keep my plan");
  expect(spies.retentionStep).toHaveBeenLastCalledWith({ reason: "price", step: "confirm", outcome: "kept", offer: "downgrade" });
  expect(spies.cancel).not.toHaveBeenCalled();
});

test("too expensive on pro: the smaller plan, never a discount even when billing has one, and taking it is logged as a downgrade", async () => {
  await open(pro);
  await toOffer("it's too expensive");
  expect(title()).toBe("keep it for less");
  expect(dots()).toBe("3/5");
  expect(footer()).toEqual(["no thanks, continue", "keep my plan"]);
  expect(text()).toContain("switch to plus");
  expect(text()).not.toMatch(/% off/);
  // keep my plan is the only dark button on the screen
  expect([...document.querySelectorAll("[role=dialog] button")].filter((b) => b.className.includes("bg-primary")).map((b) => b.textContent)).toEqual(["keep my plan"]);
  await click("continue to change plan");
  expect(spies.changePlan).toHaveBeenCalledWith(expect.objectContaining({ desktop: "shared-s", license: "starter" }), 0);
  expect(spies.retentionStep).toHaveBeenLastCalledWith({ reason: "price", step: "help", outcome: "downgrade", offer: "downgrade" });
  expect(spies.cancel).not.toHaveBeenCalled();
});

test("too expensive on the smallest plan: personal use stays free, and no thanks, continue goes on", async () => {
  await open(plus);
  await toOffer("it's too expensive");
  expect(title()).toBe("free stays free");
  expect(text()).toContain("personal use on your mac stays free");
  expect(text()).not.toMatch(/% off/);
  await onward();
  expect(spies.retentionStep).toHaveBeenLastCalledWith({ reason: "price", step: "help", outcome: "shown", offer: "none" });
  expect(title()).toBe("what you'd lose");
});

test("not using it enough: what the bots did this month, then the smaller plan on pro", async () => {
  await open(pro);
  await toOffer("i'm not using it enough");
  expect(title()).toBe("your bots this month");
  expect(text()).toContain("this month your 2 bots took 42 turns.");
  expect(text()).toContain("switch to plus");
  expect(text()).not.toMatch(/% off/);
  await click("continue to change plan");
  expect(spies.retentionStep).toHaveBeenLastCalledWith({ reason: "unused", step: "help", outcome: "downgrade", offer: "downgrade" });
});

test("not using it enough on the smallest plan: what the bots did, and personal use stays free", async () => {
  await open(plus);
  await toOffer("i'm not using it enough");
  expect(title()).toBe("your bots this month");
  expect(text()).toContain("this month your 2 bots took 42 turns.");
  expect(text()).toContain("personal use on your mac stays free");
  expect(button("continue to change plan")).toBeNull();
  await onward();
  expect(spies.retentionStep).toHaveBeenLastCalledWith({ reason: "unused", step: "help", outcome: "shown", offer: "none" });
});

test("technical problems: fix links, and keeping the plan from the offer is logged", async () => {
  await open(plus);
  await toOffer("i'm having technical problems");
  expect(title()).toBe("let's fix it");
  expect([...document.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(expect.arrayContaining(["/cloud", "/workspaces", expect.stringMatching(/^mailto:hello@dusk\.bot/)]));
  await click("keep my plan");
  expect(spies.retentionStep).toHaveBeenLastCalledWith({ reason: "broken", step: "help", outcome: "kept", offer: "help" });
  expect(spies.onClose).toHaveBeenCalled();
});

test("missing a feature: tell us and we'll reply, the note goes into the mail", async () => {
  await open(plus);
  await toReason();
  await type("a linux app");
  await pick("it's missing a feature i need");
  await onward();
  expect(title()).toBe("tell us what's missing");
  const mail = [...document.querySelectorAll("a")].find((a) => a.getAttribute("href")?.startsWith("mailto:"))!;
  expect(mail.getAttribute("href")).toContain(`body=${encodeURIComponent("a linux app")}`);
  await act(async () => mail.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
  expect(spies.retentionStep).toHaveBeenLastCalledWith({ reason: "feature", step: "help", outcome: "helped", offer: "note", note: "a linux app" });
});

test("switching: what you'd lose, confirm and cancel with the survey; done shows the access date over the night scene and resumes", async () => {
  await open(plus);
  await toReason();
  const lightButton = footButtons()[0]!.className;
  await type("going elsewhere");
  await pick("i'm switching to something else");
  await onward();
  expect(title()).toBe("what you'd lose");
  await onward();
  expect(title()).toBe("cancel your plan?");
  expect(text()).toContain("your plan ends on 13 Dec 2026, not today");
  expect(text()).toContain("your dusk cloud's files are kept until 12 Jan 2027");
  expect(button("keep my plan")?.className).toContain("bg-primary");
  expect(footer()).toEqual(["cancel subscription", "keep my plan"]);
  // the cancel is as quiet as continue to cancel was: the light button, never red
  expect(button("cancel subscription")?.className).toBe(lightButton);
  await click("cancel subscription");
  expect(spies.cancel).toHaveBeenCalledWith({ answer: "switching", offer: "losses", improve: "going elsewhere" });
  expect(title()).toBe("your plan is cancelled");
  expect(document.querySelector("[role=status]")?.textContent).toContain("you have access until 13 Dec 2026.");
  expect(document.querySelector("[data-cancel-scene=night]")).toBeTruthy();
  expect(dots()).toBeUndefined();
  await click("resume my plan");
  expect(spies.keep).toHaveBeenCalled();
  expect(spies.retentionStep).toHaveBeenLastCalledWith({ reason: "switching", step: "confirm", outcome: "kept", offer: "losses" });
  expect(spies.onClose).toHaveBeenCalled();
});

test("every reason reaches the confirm with continue to cancel alone, through its one offer at most", async () => {
  for (const [label, offer, screens] of [
    ["it's too expensive", "none", ["free stays free", "what you'd lose"]], ["i'm not using it enough", "none", ["your bots this month", "what you'd lose"]],
    ["it's missing a feature i need", "note", ["tell us what's missing", "what you'd lose"]], ["i'm switching to something else", "losses", ["what you'd lose"]],
    ["i'm having technical problems", "help", ["let's fix it", "what you'd lose"]], ["prefer not to say", "losses", ["what you'd lose"]],
  ] as const) {
    spies = makeSpies();
    await open(plus);
    await toOffer(label);
    expect(spies.retentionStep).toHaveBeenLastCalledWith(expect.objectContaining({ step: "reason", outcome: "shown", offer }));
    for (const screen of screens) { expect(title()).toBe(screen); await onward(); }
    expect(title()).toBe("cancel your plan?");
    expect(button("continue to cancel")).toBeNull();
    await click("cancel subscription");
    expect(spies.cancel).toHaveBeenCalledTimes(1);
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    document.body.innerHTML = "";
  }
});

test("a plan with a work license ends only the dusk cloud", async () => {
  await open(pro);
  expect(footer()).toEqual(["continue to cancel dusk cloud", "keep my plan"]);
  await toOffer("prefer not to say");
  expect(text()).toContain("your dusk cloud keeps working until 13 Dec 2026 and your work license stays.");
  await onward();
  expect(title()).toBe("cancel your dusk cloud?");
  await click("cancel dusk cloud");
  expect(spies.changePlan).toHaveBeenCalledWith({ ...pro, desktop: "none", size: null });
  expect(spies.retentionStep).toHaveBeenLastCalledWith({ reason: "skip", step: "confirm", outcome: "cancelled", offer: "losses" });
  expect(spies.cancel).not.toHaveBeenCalled();
  expect(title()).toBe("your dusk cloud is cancelled");
  expect(text()).toContain("your dusk cloud works until 13 Dec 2026");
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
  await toOffer("it's too expensive");
  expect(button("continue to change plan")).toBeNull();
  await onward();
  expect(text()).not.toContain("work license stays");
  await onward();
  expect(title()).toBe("cancel your plan?");
  expect(text()).toContain("you won't be charged.");
  await click("cancel subscription");
  expect(spies.cancel).toHaveBeenCalledWith({ answer: "price", offer: "none" });
  expect(spies.changePlan).not.toHaveBeenCalled();
});

test("a past-due plan offers to update the card on the reason step", async () => {
  const billing = billingFor(plus);
  billing.subscription = { ...billing.subscription!, status: "past_due" };
  state.cloud = { billing, ...spies };
  const { CancelFlow } = await import("./cancel-flow");
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  roots.push(root);
  await act(async () => root.render(createElement(CancelFlow, { open: true, onClose: () => spies.onClose(), catalog: fixtureCatalog })));
  await toReason();
  await click("update your card instead");
  expect(spies.updateCard).toHaveBeenCalled();
});
