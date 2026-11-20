import { describe, expect, it } from "vitest";

import { threads } from "./content.mjs";
import { backupProjection, buildThread } from "./transcripts.mjs";

const project = (bot: string, key: string) => {
  const thread = threads()[bot].find((candidate: { key: string }) => candidate.key === key);
  return backupProjection(buildThread(bot, thread, { now: Date.UTC(2026, 10, 19), attachmentsDir: "/unused" })) as Array<{ text: string }>;
};

describe("the test bots' live seed", () => {
  it("shows Quill's question once, with the answers it offered", () => {
    const texts = project("quill", "holiday").map((message) => message.text);
    expect(texts.filter((text) => text.startsWith("Which subject line should go out?"))).toHaveLength(1);
    expect(texts.at(-1)).toContain("1. Three new glazes, just in time");
    expect(texts.at(-1)).toContain("3. Order by 15 December");
  });

  it("leaves an answered approval out, as a chat keeps no line for it", () => {
    expect(project("rivet", "checkout").some((message) => message.text.includes("Allow Rivet to run a command?"))).toBe(false);
  });
});
