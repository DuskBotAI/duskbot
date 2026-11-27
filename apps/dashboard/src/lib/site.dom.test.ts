import { describe, expect, it } from "vitest";
import { fixtureCatalog } from "../data/fixtures";
import { cartFromSelection } from "../data/live";
import { teamSelection } from "../pages/plan-sheet";
import { planIntent, planQuery } from "./site";

const intent = (q: string) => planIntent(new URLSearchParams(q));

describe("plan links from the site", () => {
  it("knows plus, pro and the dedicated team plan", () => {
    expect(intent("plan=plus")).toEqual({ plan: "starter", interval: null });
    expect(intent("plan=pro&period=year")).toEqual({ plan: "pro", interval: "year" });
    expect(intent("plan=dedicated&period=month")).toEqual({ plan: "team", interval: "month" });
    expect(intent("plan=team")).toEqual({ plan: "team", interval: null });
    expect(intent("plan=nope")).toBeNull();
  });
  it("carries dedicated through sign-up as dedicated", () => {
    expect(planQuery(intent("plan=team&period=year"))).toBe("plan=dedicated&period=year");
    expect(planQuery(intent("plan=plus"))).toBe("plan=plus");
  });
  it("builds the team bundle for someone with no plan: team license, its seats, the dedicated machine", () => {
    const sel = teamSelection(fixtureCatalog, "year")!;
    expect(sel).toMatchObject({ license: "team", desktop: "dedicated", size: null, interval: "year", region: "eu-central" });
    expect(sel.members).toBe(2);
    expect(cartFromSelection(sel, fixtureCatalog)).toMatchObject({ license: { kind: "team", members: 2 }, desktop: { kind: "dedicated" } });
  });
});
