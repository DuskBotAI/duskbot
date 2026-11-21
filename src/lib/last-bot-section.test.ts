import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BOT_PANEL_OPEN_KEY,
  LAST_BOT_SECTION_KEY,
  readBotPanelOpen,
  readLastBotSection,
  rememberBotPanelOpen,
  rememberBotSection,
} from "./last-bot-section";

const surface = (initial: Record<string, string> = {}) => {
  const stored = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    stored,
  };
};

describe("last bot section", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("readLastBotSection returns null with nothing stored", () => {
    vi.stubGlobal("localStorage", surface());
    expect(readLastBotSection()).toBeNull();
  });

  it("readLastBotSection ignores an unknown section id", () => {
    vi.stubGlobal("localStorage", surface({ [LAST_BOT_SECTION_KEY]: "not-a-section" }));
    expect(readLastBotSection()).toBeNull();
  });

  it("rememberBotSection round-trips through storage", () => {
    const store = surface();
    vi.stubGlobal("localStorage", store);
    rememberBotSection("model");
    expect(store.stored.get(LAST_BOT_SECTION_KEY)).toBe("model");
    expect(readLastBotSection()).toBe("model");
  });

  it("a throwing storage surface never breaks reads or writes", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readLastBotSection()).toBeNull();
    expect(() => rememberBotSection("soul")).not.toThrow();
  });
});

describe("the bot panel left open", () => {
  afterEach(() => vi.unstubAllGlobals());
  const width = (phone: boolean) => vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("max-width") && phone }));

  it("opens again on a load where it docks beside the chat, and never over a phone's chat", () => {
    vi.stubGlobal("localStorage", surface({ [BOT_PANEL_OPEN_KEY]: "1" }));
    width(false);
    expect(readBotPanelOpen()).toBe(true);
    width(true);
    expect(readBotPanelOpen()).toBe(false);
    vi.stubGlobal("localStorage", surface({ [BOT_PANEL_OPEN_KEY]: "0" }));
    width(false);
    expect(readBotPanelOpen()).toBe(false);
  });

  it("keeps the choice made on a wide window through a load at phone width", () => {
    const store = surface({ [BOT_PANEL_OPEN_KEY]: "1" });
    vi.stubGlobal("localStorage", store);
    width(true);
    rememberBotPanelOpen(false);
    expect(store.stored.get(BOT_PANEL_OPEN_KEY)).toBe("1");
    width(false);
    expect(readBotPanelOpen()).toBe(true);
    rememberBotPanelOpen(false);
    expect(store.stored.get(BOT_PANEL_OPEN_KEY)).toBe("0");
  });
});
