import { describe, expect, it } from "vitest";
import { channelPrompt } from "./channel-prompt.ts";

describe("channelPrompt", () => {
  it("tells a Telegram or Discord turn how replies read there, and says nothing in the app's own chats", () => {
    expect(channelPrompt("telegram")).toContain("You are replying in Telegram: no tables");
    expect(channelPrompt("discord")).toContain("You are replying in Discord");
    expect(channelPrompt("discord")).toContain("Wrap a bare link in <>");
    expect(channelPrompt(null)).toBe("");
  });
});
