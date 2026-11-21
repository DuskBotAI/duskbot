import { join } from "node:path";

/** The npm prefix engines are installed and updated into. */
export function npmEnginesPrefix(dataDir: string): string {
  return join(dataDir, "tools", "npm");
}

/** Antigravity's own runtime releases, one folder per platform. */
export function antigravityRuntimesRoot(dataDir: string): string {
  return join(dataDir, "tools", "antigravity-acp");
}

/** AIs' own standalone builds the app installs without Node.js: per engine, its versions and the bin/ on PATH. */
export function standaloneEnginesRoot(dataDir: string): string {
  return join(dataDir, "tools", "standalone");
}

/** Every folder dusk bot installs engine code into. Only packages and releases live there, never a sign-in or a
 * setting, which is what lets the bot box show them to every turn (read-only). */
export function engineInstallRoots(dataDir: string): string[] {
  return [npmEnginesPrefix(dataDir), antigravityRuntimesRoot(dataDir), standaloneEnginesRoot(dataDir)];
}

/** Engine code a vendor's own installer keeps in the server's HOME, read-only in the bot box like the folders above.
 * Cursor's installer (cursor.com/install) unpacks each version under ~/.local/share/cursor-agent/versions and links
 * ~/.local/bin/cursor-agent there; its sign-in lives in ~/.config/cursor, never in this folder. */
export function vendorEngineRoots(home: string): string[] {
  return [join(home, ".local", "share", "cursor-agent")];
}
