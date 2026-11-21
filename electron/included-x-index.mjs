// The keyless X index's access on the desktop: every signed-in dusk account may search it (a capped number a day), so
// as soon as this computer is signed in, its sign-in's own index token is fetched from the account service once and
// handed to the local server over the private parent port (server/x-providers/x-index.ts). Kept in memory only; a
// sign-out clears it.
import { createIncludedXSync } from "./included-x.mjs";

const signedInDevice = (state) => state?.status === "connected" && typeof state.deviceId === "string" ? state.deviceId : null;

/**
 * @param {{ account: () => { xIndexAccess(): Promise<{ url: string; token: string } | null> } | null,
 *   server: () => { postMessage(message: unknown): void } | null, log: (line: string) => void }} options
 */
export function createDesktopIncludedXIndex({ account, server, log }) {
  return createIncludedXSync({
    device: signedInDevice,
    fetchAccess: () => account()?.xIndexAccess() ?? Promise.resolve(null),
    send: (access) => {
      const proc = server();
      if (!proc) return;
      try { proc.postMessage({ type: "duskbot:included-x-index", access }); }
      catch (error) { log(`X index access sync failed: ${error?.message ?? error}`); }
    },
  });
}
