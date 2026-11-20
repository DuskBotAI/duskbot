import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { CloudSetupSteps } from "./CloudSetupSteps";
import { homeDay, homeScreenText } from "./HomeScreen";

beforeEach(() => setLocale("en"));

it("names a team's Cloud on every screen that waits on it, and keeps My Cloud's own words otherwise", () => {
  expect(homeScreenText({ screen: "offline", name: "Acme" }).title).toBe("Can't reach Acme right now.");
  expect(homeScreenText({ screen: "offline" }).title).toBe("Can't reach my cloud right now.");
  expect(homeScreenText({ screen: "opening", name: "Acme" }).title).toBe("Opening Acme…");
  expect(homeScreenText({ screen: "opening" }).title).toBe("Opening my cloud…");
  expect(homeScreenText({ screen: "signin", name: "Acme" })).toMatchObject({ title: "Sign in to open Acme", action: "sign-in" });
  expect(homeScreenText({ screen: "plan", machine: "stopped", name: "Acme" })).toMatchObject({ title: "Acme isn't running", action: "manage" });
  expect(homeScreenText({ screen: "plan", machine: "stopped" }).title).toBe("My cloud isn't running");
  for (const machine of ["stopped", "payment-problem"] as const) {
    const told = homeScreenText({ screen: "plan", machine, name: "Acme", member: true });
    expect(told, "a team's User asks its owner, and has nothing to press").toMatchObject({ title: "Acme isn't running", body: "Ask its owner to start it again. Its files are kept for a while.", action: null });
  }
  expect(homeScreenText({ screen: "plan", machine: "stopped", name: "Acme" }).body, "whoever pays is told how").toContain("Subscribe again on your plan page");
  expect(homeScreenText({ screen: "plan", machine: "payment-problem", name: "Acme" }).action).toBe("manage");
  expect(homeScreenText({ screen: "plan", machine: "failed", name: "Acme", member: true }).body, "a failed machine isn't anyone's plan").not.toContain("owner");
  expect(homeScreenText({ screen: "plan", machine: "failed", name: "Acme", member: true }).action, "a member has no plan page").toBeNull();
  expect(homeScreenText({ screen: "plan", machine: "failed" }), "the plan page it names is one press away").toMatchObject({ body: expect.stringContaining("plan page"), action: "manage" });
  expect(homeScreenText({ screen: "waking", name: "Acme" }).title, "only My Cloud is woken").toBe("Waking my cloud…");
  expect(homeScreenText(null).title).toBe("Opening my cloud…");
  expect(homeScreenText({ screen: "moving" }).title).toBe("Moving to my cloud… almost done");
  expect(homeScreenText({ screen: "moving", name: "Garage server" })).toMatchObject({ title: "Moving to Garage server… almost done", action: null, busy: true });
});

it("while the Admin sets My Cloud up, the screen says so plainly, with its step, and never asks the person to do anything", () => {
  const setup = homeScreenText({ screen: "setup", step: "storage" });
  expect(setup).toEqual({ title: "Setting up my cloud…", body: "This takes about 2 minutes. It opens by itself when it's ready.", reason: null, action: null, busy: true });
  expect(homeScreenText({ screen: "setup", name: "Acme" }).title).toBe("Setting up Acme…");
  expect(homeScreenText({ screen: "setup", step: "starting", slow: true }).body).toMatch(/taking longer than usual/);
  const steps = renderToStaticMarkup(createElement(CloudSetupSteps, { step: "checking" }));
  expect(steps).toContain('data-cloud-setup="checking"');
  expect(steps).toMatch(/aria-current="step"[^>]*>Checking it&#x27;s ready</);
  for (const words of Object.values(setup)) expect(String(words)).not.toMatch(/Server menu|choose it again|DNS|resolv|ERR_/i);
});

it("a Cloud that isn't running says what it is in plain words with its one action; one that doesn't answer says Try again, with no endless spinner", () => {
  const now = new Date(2026, 9, 30, 12).getTime(), day = new Date(2026, 10, 1, 9).getTime();
  expect(homeScreenText({ screen: "ended", name: "My Cloud", deleteAt: day }, now))
    .toEqual({ title: "My Cloud has ended.", body: "Its files are deleted on November 1.", reason: null, action: "buy", busy: false });
  expect(homeScreenText({ screen: "ended" }).title).toBe("This cloud has ended.");
  expect(homeScreenText({ screen: "ended", name: "Old" }).body, "its files' day only when the Admin names it").toBeNull();
  expect(homeScreenText({ screen: "checkout", name: "Client B" })).toEqual({ title: "The checkout for Client B wasn't finished.", body: "Nothing was charged. Continue to finish it in your browser.", reason: null, action: "continue", busy: false });
  expect(homeScreenText({ screen: "checkout" }).title).toBe("This checkout wasn't finished.");
  expect(homeScreenText({ screen: "payment", name: "Client B" }))
    .toEqual({ title: "Your payment didn't go through.", body: "Update your card to get your cloud back.", reason: null, action: "card", busy: false });
  expect(homeScreenText({ screen: "payment", name: "Client B", deleteAt: day }, now).body).toBe(`Update your card to get your cloud back. Its data is kept until ${homeDay(day, now)}.`);
  expect(homeScreenText({ screen: "payment", name: "Client B", deleteAt: day, trial: true }, now))
    .toEqual({ title: "Upgrade to keep using your cloud", body: `Your trial ended. Its data is deleted on ${homeDay(day, now)} unless you upgrade.`, reason: null, action: "upgrade", busy: false });
  expect(homeScreenText({ screen: "offline", name: "Acme" })).toMatchObject({ title: "Can't reach Acme right now.", action: "retry", busy: false });
  expect(homeScreenText({ screen: "offline" })).toMatchObject({ title: "Can't reach my cloud right now.", action: "retry", busy: false });
  expect(homeDay(new Date(2027, 0, 5).getTime(), now), "another year is named").toBe("January 5, 2027");
  for (const screen of ["ended", "checkout", "payment"] as const) {
    for (const words of Object.values(homeScreenText({ screen, name: "Client B", deleteAt: day }, now))) expect(String(words)).not.toMatch(/—|\bVM\b|engine|ctx|server/i);
  }
});

it("a deleted Cloud is said plainly, with nothing to look again for", () => {
  expect(homeScreenText({ screen: "gone", name: "Acme" })).toMatchObject({ title: "Acme was deleted.", action: null, busy: false });
  expect(homeScreenText({ screen: "gone" }).title).toBe("This cloud was deleted.");
});
