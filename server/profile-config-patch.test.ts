import { describe, expect, it } from "vitest";
import { parseConfigPatch, parseStoredConfig } from "./config.ts";

describe("a profile patch", () => {
  it("takes a name of up to 80 characters and an email address, or empty ones", () => {
    expect(parseConfigPatch({ profile: { name: "  Ada  ", email: "ada@example.com" } }).profile).toEqual({ name: "Ada", email: "ada@example.com" });
    expect(parseConfigPatch({ profile: { name: "n".repeat(80), email: "" } }).profile).toEqual({ name: "n".repeat(80), email: "" });
    expect(parseConfigPatch({ profile: { aboutMe: "I like tea" } }).profile).toEqual({ aboutMe: "I like tea" });
  });

  it("refuses an email that is not an address and a name past 80 characters", () => {
    expect(() => parseConfigPatch({ profile: { email: "not-an-email" } })).toThrow(/email address/);
    expect(() => parseConfigPatch({ profile: { name: "n".repeat(81) } })).toThrow(/at most 80/);
  });

  it("still loads a stored profile saved before the check", () => {
    expect(parseStoredConfig({ profile: { name: "n".repeat(216), email: "not-an-email" } }).profile).toEqual({ name: "n".repeat(216), email: "not-an-email" });
  });
});
