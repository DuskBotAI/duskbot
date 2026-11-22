import { describe, expect, it } from "vitest";
import { aiName, aiTiles, freeModel, funnelSteps, nextStep, previousStep } from "./funnel";

const ai = (instanceId: string, driverKind: string, ready = false, extra: Record<string, unknown> = {}) => ({
  instanceId, driverKind, displayName: instanceId, access: "subscription", snapshot: { state: ready ? "available" : "unavailable", ...extra },
});
const ready = (instance: { snapshot: { state: string } }) => instance.snapshot.state === "available";

describe("the funnel's steps", () => {
  it("is two screens on this Mac: the hello, then the one AI choice", () => {
    const steps = funnelSteps({ account: false, desktop: true });
    expect(steps).toEqual(["welcome", "ai"]);
    expect(nextStep(steps, "welcome")).toBe("ai");
    expect(nextStep(steps, "ai"), "the chat comes after it").toBeNull();
    expect(previousStep(steps, "ai")).toBe("welcome");
    expect(funnelSteps({ account: false, desktop: false })).toEqual(["welcome", "ai"]);
  });

  it("never shows where bots live, bringing things in, the phone or the Mac's permissions as a step", () => {
    const steps = funnelSteps({ account: false, desktop: true, path: "mac" });
    for (const gone of ["place", "bring", "phone", "permissions", "checkout", "making"]) expect(steps).not.toContain(gone);
  });

  it("asks for an account only where the install requires one", () => {
    expect(funnelSteps({ account: true, desktop: true })).toEqual(["welcome", "account", "ai"]);
  });

  it("skips the hello on a server opened from the desktop app, where the person already met dusk bot", () => {
    expect(funnelSteps({ account: false, desktop: false, hello: false })).toEqual(["ai"]);
  });

  it("on a cloud the desktop app set up: the hello and that computer's bots when it has some, never a second AI step", () => {
    expect(funnelSteps({ account: false, desktop: false, aiAsked: true })).toEqual(["welcome"]);
    expect(funnelSteps({ account: false, desktop: false, cloudBring: true, aiAsked: true })).toEqual(["welcome", "bring"]);
  });

  it("a run already on its way to dusk cloud keeps its checkout and the cloud being made, never back to a purchase that is done", () => {
    const steps = funnelSteps({ account: false, desktop: true, path: "cloud" });
    expect(steps).toEqual(["welcome", "checkout", "ai", "making"]);
    expect(nextStep(steps, "checkout")).toBe("ai");
    expect(nextStep(steps, "ai")).toBe("making");
    expect(nextStep(steps, "making")).toBeNull();
    expect(previousStep(steps, "ai", { paid: true })).toBeNull();
    expect(funnelSteps({ account: false, desktop: true, path: "cloud", paid: true }), "an account that already owns a cloud").toEqual(["welcome", "ai", "making"]);
    expect(funnelSteps({ account: false, desktop: false, path: "cloud" }), "only on the desktop app").toEqual(["welcome", "ai"]);
  });
});

describe("the AI grid", () => {
  it("names each AI as people know it, in a fixed order, with only the ones this app can connect", () => {
    const tiles = aiTiles([ai("claude", "claudeAgent"), ai("chatgpt", "codex"), ai("antigravity", "antigravityAgent"), ai("openrouter", "openai-compat")], ready);
    expect(tiles.map((tile) => [tile.id, tile.label, tile.instance.instanceId])).toEqual([
      ["chatgpt", "ChatGPT", "chatgpt"], ["claude", "Claude", "claude"], ["antigravity", "Antigravity", "antigravity"], ["openrouter", "OpenRouter", "openrouter"],
    ]);
    expect(aiName({ instanceId: "chatgpt", driverKind: "codex", displayName: "ChatGPT plan" })).toBe("ChatGPT");
    expect(aiName({ instanceId: "kimi", driverKind: "kimiAgent", displayName: "Kimi" })).toBe("Kimi");
  });

  it("lets a signed-in one stand for its tile", () => {
    const tiles = aiTiles([ai("chatgpt", "codex"), ai("codex", "codex", true)], ready);
    expect(tiles[0]!.instance.instanceId).toBe("codex");
  });

  it("never offers an AI whose saved driver this build lacks, falling back to one of its kind it does know", () => {
    const unknown = (instanceId: string) => ({ ...ai(instanceId, "not-a-real-driver"), unknownDriver: true as const });
    const tiles = aiTiles([ai("claude", "claudeAgent"), unknown("openaiCompat"), unknown("cursor"), unknown("chatgpt"), ai("codex", "codex")], ready);
    expect(tiles.map((tile) => [tile.id, tile.instance.instanceId])).toEqual([["chatgpt", "codex"], ["claude", "claude"]]);
    expect(tiles[0]!.candidates.map((candidate) => candidate.instanceId)).toEqual(["codex"]);
  });

  it("offers the free model only when it is ready", () => {
    expect(freeModel([ai("opencodeGo", "opencodeGo", true, { freeFallback: true })], ready)?.instanceId).toBe("opencodeGo");
    expect(freeModel([ai("opencodeGo", "opencodeGo", false, { freeFallback: true })], ready)).toBeUndefined();
  });
});
