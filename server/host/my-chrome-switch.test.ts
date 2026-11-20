import { describe, expect, it, vi } from "vitest";

import { YourComputerDeclined } from "../your-computer-consent.ts";
import { createMyChromeSwitch, MY_CHROME_MOVED, MY_CHROME_NOT_THIS_TURN, MY_CHROME_WAITING, type MyChromeSwitchDeps, type SwitchTurn } from "./my-chrome-switch.ts";

const turn = (over: Partial<SwitchTurn> = {}): SwitchTurn => ({ botId: "b1", threadId: "t1", generation: "g1", depth: 0, browserSession: "bot-session", ...over });
const refused = () => ({ content: [{ type: "text", text: "page" }], signInRefused: true });
const said = (result: unknown) => ((result as { content: Array<{ text?: string }> }).content).map((part) => part.text).join("\n");

function deps(over: Partial<MyChromeSwitchDeps> = {}): MyChromeSwitchDeps {
  return { profile: () => "my-chrome", ownRequest: () => true, asks: () => false, ask: vi.fn(async () => undefined), session: async (_turn, profile) => `session-${profile}`, waitMs: 50, ...over };
}

describe("moving a turn to the person's own Chrome", () => {
  it("at Full access moves at once, with no card, on the turn's own capability", async () => {
    const options = deps();
    const value = turn();
    const result = await createMyChromeSwitch(options).after(value, refused());
    expect(options.ask).not.toHaveBeenCalled();
    expect(value).toMatchObject({ browserProfile: "my-chrome", browserSession: "session-my-chrome" });
    expect(said(result)).toContain(MY_CHROME_MOVED);
    expect(result).not.toHaveProperty("signInRefused");
  });

  it("below Full access asks once with the Chrome card and moves on Allow", async () => {
    const ask = vi.fn(async () => undefined);
    const value = turn();
    const result = await createMyChromeSwitch(deps({ asks: () => true, ask })).after(value, refused());
    expect(ask).toHaveBeenCalledWith(value, "google.com");
    expect(value.browserProfile).toBe("my-chrome");
    expect(said(result)).toContain(MY_CHROME_MOVED);
  });

  it("stays in the bot's browser on Deny and says so", async () => {
    const value = turn();
    const result = await createMyChromeSwitch(deps({ asks: () => true, ask: async () => { throw new YourComputerDeclined("the person said no"); } })).after(value, refused());
    expect(value.browserProfile).toBeUndefined();
    expect(value.browserSession).toBe("bot-session");
    expect(said(result)).toMatch(/did not let you use their own Chrome \(the person said no\)/);
  });

  it("holds the next browser call while the person has not answered, then moves once they allow", async () => {
    let allow!: () => void;
    const value = turn();
    const move = createMyChromeSwitch(deps({ asks: () => true, ask: () => new Promise<void>((resolve) => { allow = resolve; }) }));
    expect(said(await move.after(value, refused()))).toContain(MY_CHROME_WAITING);
    expect(await move.before(value)).toBe(MY_CHROME_WAITING);
    expect(value.browserProfile).toBeUndefined();
    allow();
    expect(await move.before(value)).toBeNull();
    expect(value.browserSession).toBe("session-my-chrome");
    expect(await move.before(value)).toBeNull();
  });

  it.each([
    ["a routine, a guest, a room or the Bot API", turn(), { ownRequest: () => false }],
    ["another bot's request", turn({ depth: 1 }), {}],
  ])("never moves %s, and never asks", async (_label, value, over) => {
    const options = deps({ asks: () => true, ...over });
    const result = await createMyChromeSwitch(options).after(value, refused());
    expect(options.ask).not.toHaveBeenCalled();
    expect(value.browserProfile).toBeUndefined();
    expect(said(result)).toContain(MY_CHROME_NOT_THIS_TURN);
  });

  it("leaves results alone when nothing refused sign-in, no My Chrome is set up, or the turn already moved", async () => {
    const options = deps({ profile: () => null });
    const plain = { content: [{ type: "text", text: "page" }] };
    expect(await createMyChromeSwitch(deps()).after(turn(), plain)).toBe(plain);
    expect(await createMyChromeSwitch(options).after(turn(), refused())).toEqual({ content: [{ type: "text", text: "page" }] });
    const moved = turn({ browserProfile: "my-chrome" }), again = deps();
    expect(said(await createMyChromeSwitch(again).after(moved, refused()))).toBe("page");
    expect(again.ask).not.toHaveBeenCalled();
  });
});
