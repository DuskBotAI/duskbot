import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import de from "./locales/de.json";
import es from "./locales/es.json";

it("names the app shell's controls from the catalog, so the phone back button reads in the person's language", () => {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  expect(source.match(/aria-label="[^"]*"/g) ?? []).toEqual([]);
  expect(source).toContain('aria-label={t("app.openBotList")}');
  expect((es as Record<string, string>)["app.openBotList"]).toBe("Abrir lista de bots");
  expect((de as Record<string, string>)["app.openBotList"]).toBe("Bot-Liste öffnen");
});
