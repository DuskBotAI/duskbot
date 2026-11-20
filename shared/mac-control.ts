/** "Your Mac": a linked VPS's bots reach the owner's Mac through the Mac app's own signed-in link to that server. */

export const MAC_TOOL_NAMES = [
  "mac_exec", "mac_read_file", "mac_write_file", "mac_list", "mac_open", "mac_save_from_cloud", "mac_screenshot",
] as const;
/** Only a dusk cloud's bots get these (shared/cloud-mac.ts). */
export const CLOUD_ONLY_MAC_TOOL_NAMES = ["mac_download", "mac_send_file"] as const;
export type MacToolName = (typeof MAC_TOOL_NAMES)[number] | (typeof CLOUD_ONLY_MAC_TOOL_NAMES)[number];
/** What a job asks the Mac to do: a bot's Mac tool, or on a dusk cloud a call to the Mac's computer-control driver. */
export type MacJobTool = MacToolName | "mac_screen" | "mac_screen_tools" | "mac_screen_access";

export function isMacToolName(value: unknown): value is MacToolName {
  return typeof value === "string" && ([...MAC_TOOL_NAMES, ...CLOUD_ONLY_MAC_TOOL_NAMES] as readonly string[]).includes(value);
}

/** GET and PUT /api/mac answer this. */
export interface MacControlStatus {
  /** On a dusk cloud, as the Mac last said: when actions ask first, the folders it is limited to, if any, and whether its
   * screen tools are offered (the person allows the screen and the Mac listed them). */
  cloud?: { folders: string[]; mode: "auto" | "ask" | "never"; limited: boolean; screen: boolean };
  /** The owner's Mac app has served this server at least once: the switch means something here. */
  available: boolean;
  /** The Settings switch; default true. */
  enabled: boolean;
  /** The Mac app is polling for work right now. */
  online: boolean;
  /** The Mac's own name, as its app reported it. */
  name: string | null;
  lastSeenAt: number | null;
}

/** One job as the Mac app receives it from GET /api/mac/self/jobs. `download` is a one-time path on this server
 * holding the bytes a mac_save_from_cloud job writes. */
export interface MacJob {
  id: string;
  /** On a dusk cloud: the person allowed this one on its card (reads never ask). */
  approved?: true;
  tool: MacJobTool;
  arguments: Record<string, unknown>;
  bot: { id: string; name: string };
  expiresAt: number;
  download?: { path: string; name: string; bytes: number };
}

/** What the Mac app posts to /api/mac/self/jobs/:id/result. A mac_screen job's result also carries the driver's
 * structuredContent, whether the driver answered with an error, and `outside` when it read outside content (a browser
 * window's page, the whole desktop, or a window the Mac could not name), and a mac_send_file job's result the file. */
export type MacJobOutcome =
  | { ok: true; result: { text: string; image?: { data: string; mimeType: "image/png" | "image/jpeg" }; structured?: Record<string, unknown>; isError?: true; outside?: true;
    /** A mac_send_file job's file: its name and its bytes as base64. */
    file?: { name: string; data: string } } }
  /** `ask`: on a dusk cloud, the Mac refused because the person must allow this on a card first, and says why. */
  | { ok: false; error: string; ask?: string };
