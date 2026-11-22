import { useEffect, useState } from "react";
import type { LocaleKey } from "@/locales";

export const LOAD_GIVE_UP_MS = 8_000;

/** What the main area says while there is no chat to show. `hydrated`: the bots have loaded at least once; `updating`:
 * the window just reloaded My Cloud's page for its newer version (the desktop app says so as the page loads);
 * `developer`: a developer's build, the only one that names the command which starts a server; `unreachable`: the
 * first chat read failed and the window has stopped waiting quietly for it. "No bots yet" only once the bots have
 * loaded and there are none. */
export function loadingLine({ connected, hydrated, updating = window.duskDesktop?.home?.updating === true, developer, unreachable = false }: {
  connected: boolean; hydrated: boolean; updating?: boolean; developer: boolean; unreachable?: boolean;
}): { text: LocaleKey; busy: boolean; command: boolean; failed: boolean } {
  if (connected && hydrated) return { text: "app.loading.noBots", busy: false, command: false, failed: false };
  if (unreachable && !hydrated) return { text: "app.loading.unreachable", busy: false, command: developer, failed: true };
  return { text: updating && !hydrated ? "app.loading.updating" : "app.loading.connecting", busy: true, command: developer && !connected, failed: false };
}

/** True once the first chat read has failed (`AppState.loadFailed`) and the window has been open LOAD_GIVE_UP_MS. */
export function useLoadGaveUp(failed: boolean): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), LOAD_GIVE_UP_MS);
    return () => clearTimeout(timer);
  }, []);
  return failed && late;
}
