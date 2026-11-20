import { describe, expect, it } from "vitest";
import { dictationLocale } from "./locale";

describe("the phone's dictation language", () => {
  it("is the app's language, never the device's other one", () => {
    expect(dictationLocale("es", ["en-US", "en"])).toBe("es");
  });

  it("takes the device's region for the app's language", () => {
    expect(dictationLocale("es", ["en-US", "es-MX"])).toBe("es-MX");
  });

  it("keeps a region the app's language already names", () => {
    expect(dictationLocale("pt-BR", ["pt-PT"])).toBe("pt-BR");
  });

  it("falls back to the device's first language when the app has none", () => {
    expect(dictationLocale("", ["fr-FR"])).toBe("fr-FR");
  });
});
