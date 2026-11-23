import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ requests: [] as string[], failImport: "" }));

vi.mock("@/state/store", () => ({
  api: vi.fn(async (path: string, init: { method?: string; body?: string } = {}) => {
    fixture.requests.push(path);
    const body = JSON.parse(init.body ?? "{}");
    if (path.startsWith("/api/teams/import")) {
      if (fixture.failImport && body.package.name === fixture.failImport) throw new Error("no room");
      return { bots: [{ id: `id-${body.package.name}`, name: body.package.name, section: body.package.name }], routines: [], connections: [] };
    }
    if (path === "/api/sidebar-sections") return { bots: body.botIds.map((id: string) => ({ id, section: body.name })) };
    if (path.startsWith("/api/sidebar-sections?")) return { sections: [] };
    return {};
  }),
}));

import type { GrokBot } from "../../shared/grok-import";
import { planBotMove, runBotMove, type BotMoveLook } from "./bot-move";

const bot = (name: string, over: Partial<GrokBot> = {}): GrokBot => ({
  name, title: "", description: "", instructions: `You are ${name}.`, memories: ["a fact"], userFacts: [],
  skills: [{ name: "notes", description: "Takes notes.", instructions: "Write it down." }],
  routines: [{ name: "Daily", instruction: "Do it.", trigger: "schedule", cron: "0 9 * * *", when: "", timeZone: "UTC", paused: false, skills: [], details: "" }],
  apps: [], ...over,
});

const look = (over: Partial<BotMoveLook> = {}): BotMoveLook => ({
  bots: { apps: [
    { source: "openclaw", app: "OpenClaw", where: "~/.openclaw", bots: [bot("Molty"), bot("Scout")], channels: ["telegram"], unreadable: [] },
    { source: "hermes", app: "Hermes Agent", where: "~/.hermes", bots: [bot("Hermes", { skills: [], routines: [] })], channels: [], unreadable: ["cron/jobs.json"] },
  ] },
  ...over,
});
const facts: Parameters<typeof planBotMove>[1] = { bots: [], servers: new Set<string>(), timeZone: "UTC" };

beforeEach(() => {
  fixture.requests = [];
  fixture.failImport = "";
});

describe("the same bot kept in two apps", () => {
  it("comes over once, as the copy with the most in it, never as a numbered second bot", () => {
    const plan = planBotMove({ bots: { apps: [
      { source: "openclaw", app: "OpenClaw", where: "~/.openclaw", bots: [bot("Nova", { skills: [], routines: [], memories: [] })], channels: [], unreadable: [] },
      { source: "hermes", app: "Hermes Agent", where: "~/.hermes", bots: [bot("nova", { instructions: "You are Nova, ".repeat(50) })], channels: [], unreadable: [] },
    ] } }, facts);
    expect(plan.apps.map((app) => [app.app, app.preview.plans.map((one) => one.addedAs)])).toEqual([["Hermes Agent", ["nova"]]]);
  });
});

describe("planning a move", () => {
  it("counts what each app brings and numbers a name already taken here", () => {
    const plan = planBotMove(look(), { ...facts, bots: [{ name: "Scout" }] as never });
    expect(plan.apps.map((app) => [app.app, app.preview.plans.map((one) => one.addedAs)])).toEqual([["OpenClaw", ["Molty", "Scout 2"]], ["Hermes Agent", ["Hermes"]]]);
  });

  it("names a bot moved before as already here instead of bringing it twice", () => {
    const first = planBotMove(look(), facts);
    const installed = first.apps.flatMap((app) => app.preview.plans.map((one) => ({ name: one.addedAs, installedPackage: { id: one.packageId } })));
    const again = planBotMove(look(), { ...facts, bots: installed as never });
    expect(again.apps.flatMap((app) => app.preview.plans)).toEqual([]);
    expect(again.apps.flatMap((app) => app.preview.moved)).toEqual(["Molty", "Scout", "Hermes"]);
  });

  it("keeps the same bot found under two names once", () => {
    const twice = look();
    twice.bots.apps.push({ ...twice.bots.apps[0]! });
    expect(planBotMove(twice, facts).apps.flatMap((app) => app.preview.plans).map((one) => one.addedAs)).toEqual(["Molty", "Scout", "Hermes"]);
  });

  it("finds nothing to offer on an empty computer", () => {
    expect(planBotMove(look({ bots: { apps: [] } }), facts)).toEqual({ apps: [] });
  });
});

describe("moving", () => {
  it("moves bot by bot with progress, and one that fails costs the others nothing", async () => {
    fixture.failImport = "Scout";
    const steps: Array<[number, string]> = [];
    const reports = await runBotMove(planBotMove(look(), facts), () => {}, (done, name) => steps.push([done, name]));
    expect(fixture.requests.filter((path) => path.startsWith("/api/sidebar-sections"))).toEqual([
      "/api/sidebar-sections", "/api/sidebar-sections?section=Molty", "/api/sidebar-sections", "/api/sidebar-sections?section=Hermes",
    ]);
    expect(steps).toEqual([[0, "Molty"], [1, "Scout"], [2, "Hermes"]]);
    const moved = reports.flatMap((one) => one.report.bots);
    expect(moved.map((bot) => bot.name)).toEqual(["Molty", "Hermes"]);
    expect(reports.flatMap((one) => one.report.failed)).toEqual(["Scout"]);
  });
});
