/** The language a phone listens in when Voice settings name none: the app's own language, in the region the device
 * lists for it ("es" on a phone set to es-MX listens in es-MX). A recognizer left to its own default hears in the
 * device's language, so Spanish spoken on an English iPhone came back as English words nobody said. */
export function dictationLocale(appLanguage: string, deviceLanguages: readonly string[]): string {
  const app = appLanguage.trim();
  const base = app.split("-")[0]!.toLowerCase();
  if (!base) return deviceLanguages[0] ?? "";
  if (app.includes("-")) return app;
  return deviceLanguages.find((tag) => tag.split("-")[0]!.toLowerCase() === base && tag.includes("-")) ?? base;
}
