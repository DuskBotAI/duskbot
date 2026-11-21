import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import { EmptyChat } from "./ChatEmptyState";

const html = (bot: Partial<Bot> = {}) => renderToStaticMarkup(createElement(EmptyChat, { bot: { id: "juniper", name: "Juniper", ...bot } as Bot }));

describe("a chat with no messages", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("says so on screen with the bot's face and name, on a computer as on the phone, never as a blank pane", () => {
    for (const mobileApp of [undefined, "android"]) {
      if (mobileApp) vi.stubGlobal("document", { documentElement: { dataset: { mobileApp } } });
      const markup = html();
      expect(markup).not.toContain("sr-only");
      expect(markup).toMatch(/<p role="status"[^>]*>No messages yet<\/p>/);
      expect(markup).toContain(">Juniper</p>");
      expect(markup).toContain('aria-label="Juniper"');
    }
  });

  it("says what the bot is for, from its description or else its role", () => {
    expect(html({ description: "Researches shops and prices.", title: "Researcher" })).toContain(">Researches shops and prices.</p>");
    expect(html({ description: " ", title: "Researcher" })).toContain(">Researcher</p>");
  });
});
