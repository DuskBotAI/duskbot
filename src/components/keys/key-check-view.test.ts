import { beforeEach, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { keyCheckView } from "./key-check-view";

beforeEach(() => setLocale("en"));

it.each([
  [{ ok: true, result: "works" }, "works", "ok", false, false, "Key works"],
  [{ ok: true, result: "busy" }, "busy", "ok", false, false, "Key works"],
  [{ ok: false, reason: "rejected", result: "wrong_key" }, "wrong_key", "bad", true, false, "Wrong key"],
  [{ ok: false, reason: "model", result: "wrong_model", model: "gpt-9" }, "wrong_model", "bad", true, false, "Model not found"],
  [{ ok: false, reason: "credits", result: "no_credit" }, "no_credit", "warn", false, true, "No credit"],
  [{ ok: false, reason: "unreachable", result: "unreachable" }, "unreachable", "warn", false, true, "Couldn't reach Groq"],
  [{ ok: false, reason: "address", result: "unreachable" }, "unreachable", "warn", false, true, "Check the address"],
  [{ ok: true, check: "models" }, "works", "ok", false, false, "Key works"],
  [{ ok: false, reason: "rejected" }, "wrong_key", "bad", true, false, "Wrong key"],
  [{ ok: false, reason: "unexpected", status: 500 }, "unreachable", "warn", false, true, "Couldn't reach Groq"],
])("%j reads as %s", (answer, outcome, tone, blocks, confirm, title) => {
  expect(keyCheckView(answer, "Groq")).toMatchObject({ outcome, tone, blocks, confirm, title });
});

it("names the model the provider lacks and the one it offers instead", () => {
  const view = keyCheckView({ ok: false, reason: "model", result: "wrong_model", model: "gpt-9", suggestedModel: "gpt-5-mini" }, "OpenAI");
  expect(view.line).toBe("OpenAI doesn't offer gpt-9 to this key. Pick another model.");
  expect(view.suggestedModel).toBe("gpt-5-mini");
});
