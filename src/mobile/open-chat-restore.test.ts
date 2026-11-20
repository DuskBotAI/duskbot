import { describe, expect, it } from "vitest";
import type { Bot, Group } from "@/state/store";
import { placeForTarget, rereadDue, restoredChat } from "./open-chat-restore";

const bot = (id: string, transcriptLoaded = true) => ({ id, threadId: `t-${id}`, messages: [], transcriptLoaded }) as unknown as Bot;
const room = (id: string) => ({ id, threadId: `t-${id}`, messages: [] }) as unknown as Group;

describe("reopening the chat a reload left open", () => {
  it("waits for the snapshot instead of opening a chat with nothing to show", () => {
    expect(restoredChat("nova", { bots: [], groups: [] })).toBe("wait");
    expect(restoredChat("nova", { bots: [bot("nova")], groups: [] })).toBe("wait");
  });

  it("opens the bot or room once the snapshot has it", () => {
    expect(restoredChat("nova", { hydrated: true, bots: [bot("nova")], groups: [] })).toBe("nova");
    expect(restoredChat("team", { hydrated: true, bots: [], groups: [room("team")] })).toBe("team");
  });

  it("goes to the list for a bot that was deleted or belongs to another workspace", () => {
    expect(restoredChat("gone", { hydrated: true, bots: [bot("nova")], groups: [room("team")] })).toBeNull();
  });
});

describe("the stream-down reread", () => {
  it("never runs while a transcript is still loading, since a snapshot read aborts it", () => {
    expect(rereadDue({ bots: [bot("nova", false)], groups: [] }, false)).toBe(false);
    expect(rereadDue({ bots: [bot("nova")], groups: [] }, false)).toBe(true);
    expect(rereadDue({ bots: [bot("nova")], groups: [] }, true)).toBe(false);
  });
});

describe("a link or notification from another saved place", () => {
  const records = [{ id: "mac", environmentId: "env-mac" }, { id: "cloud", environmentId: "env-cloud" }];
  it("names the saved place its chat lives in when that is not the one on screen", () => {
    expect(placeForTarget("env-cloud", records, "mac")).toBe("cloud");
  });
  it("stays put for this place, an unknown place, or no place at all", () => {
    expect(placeForTarget("env-mac", records, "mac")).toBeNull();
    expect(placeForTarget("env-gone", records, "mac")).toBeNull();
    expect(placeForTarget(undefined, records, "mac")).toBeNull();
  });
});
