import { expect, it } from "vitest";
import { runsCommands } from "./bot-reach.ts";

it("counts an engine with its own shell or a computer the bot was given, and nothing else, as running commands", () => {
  expect(runsCommands({ computer: "off" }, "codex")).toBe(true);
  expect(runsCommands({ computer: "off" }, "openai-compat")).toBe(false);
  expect(runsCommands({}, "openai-compat")).toBe(false);
  expect(runsCommands({ computer: "vps" }, "openai-compat")).toBe(true);
  expect(runsCommands({ computer: "off" }, undefined)).toBe(false);
});
