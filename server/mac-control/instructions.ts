// No imports: harness-mcp-proxy bundles this file into the agent process.

/** Added to the device server's instructions: the person's Mac sits beside their phone there. */
export const MAC_INSTRUCTIONS =
  "The mac_ tools reach the person's own Mac through the dusk bot app on it, beside your own cloud computer: mac_exec runs a shell command in their home folder, " +
  "mac_read_file, mac_write_file and mac_list work with its files, mac_open opens an app, a file or a link there, mac_screenshot shows its screen, and " +
  "mac_save_from_cloud copies a file from your own files or your cloud computer onto the Mac (by default into ~/Downloads/<your name>/). " +
  "Every Mac action shows in the chat. If the Mac is offline the tool says so: ask the person to open dusk bot on it. " +
  "A mac_exec that timed out may still have changed things; check before repeating it.";

/** The system prompt part for a turn that may use the person's Mac. */
export const MAC_PROMPT =
  " You can also work on the person's own Mac, not only on your cloud computer: the mac_ tools (mcp__device__mac_exec, mac_read_file, mac_write_file, mac_list, mac_open, " +
  "mac_screenshot, mac_save_from_cloud) act on it through the dusk bot app there. So never say you have no access to their Mac. " +
  "Keep doing your own work on your cloud computer; use the Mac when the person asks for something on it: save a result there (mac_save_from_cloud, " +
  "by default into ~/Downloads/<your name>/), open an app, a file or a link, run a terminal command or a CLI such as claude, or read and change their files. " +
  "When a site blocks your cloud computer, the same request from the Mac (mac_exec with curl to the site's API) leaves through their home connection; use that before asking them for anything. " +
  "Everything you do on the Mac shows in the chat. If it is offline the tool says so; tell the person to open dusk bot on the Mac.";

/** What the person's Mac told its cloud: whether each action asks first, and the folders it is limited to (none: all). */
export interface CloudMacLimits { mode: "auto" | "ask" | "never"; limited: boolean; folders: string[]; screen?: boolean; screenAccess?: boolean }

/** What the bot may do on the Mac's screen: its driver's tools as mac_<tool>, or the one line on how to allow it. */
function cloudMacScreen({ screen, screenAccess }: CloudMacLimits): string {
  return screen ? CLOUD_MAC_SCREEN_PROMPT : screenAccess ? CLOUD_MAC_SCREEN_ACCESS_PROMPT : CLOUD_MAC_NO_SCREEN_PROMPT;
}

export const CLOUD_MAC_SCREEN_ACCESS_PROMPT =
  "The Mac's screen is allowed but dusk bot there does not have Accessibility and Screen Recording yet: when a task needs the screen, call mac_request_screen_access once and tell the person to allow it on the Mac.";

/** A screen tool called while the Mac allows its screen but lacks the grants. */
export const SCREEN_NEEDS_ACCESS_TEXT =
  "dusk bot on the person's Mac does not have Accessibility and Screen Recording yet. Call mac_request_screen_access, which asks them there.";

export const CLOUD_MAC_SCREEN_PROMPT =
  "You can also see and use the apps on the Mac's screen with the same computer tools a bot on that Mac has, named mac_<tool> (mac_list_apps, mac_list_windows, " +
  "mac_get_window_state, mac_launch_app, mac_click, mac_type_text, mac_press_key, mac_hotkey, mac_scroll and the rest). Work in the background on one app's window: " +
  "find its pid and window_id, read it with mac_get_window_state, and act on that window by element_index; take over the foreground only when a window will not take background input. " +
  "Use the screen only for what a command or file cannot do, and keep your own web work in your own browser.";

export const CLOUD_MAC_NO_SCREEN_PROMPT =
  "You cannot see or use the Mac's screen: when a task needs it, say in one sentence that they can allow it in the dusk bot app on the Mac, Settings > Your computer > Let them use this Mac's screen.";

/** A screen tool called while the person has not let cloud bots use the Mac's screen. */
export const SCREEN_OFF_TEXT =
  "The person has not let you use their Mac's screen. Tell them in one sentence they can allow it in the dusk bot app on the Mac: Settings > Your computer > Let them use this Mac's screen.";

function cloudMacLimits({ mode, limited, folders }: CloudMacLimits): string {
  return [
    limited ? `The person limited the Mac to these folders: ${folders.join(", ")}; files and a command's folder elsewhere are refused.` : "",
    mode === "ask" ? "The person approves each command, download, file change and open on a card first (ordinary reads do not ask)." : "",
    mode === "auto" ? "Ordinary work runs at once; risky actions (sudo, deleting many files, system settings, reading keys or secrets, force-pushing, running scripts from the internet) wait for the person's Allow on a card." : "",
    mode === "never" ? "" : "If they say no, it did not run, so carry on without it.",
  ].filter(Boolean).join(" ");
}

/** A dusk cloud's version: the person's own opt-in limits, if any, and the Mac's screen when they allow it. */
export function cloudMacInstructions(limits: CloudMacLimits): string {
  return ["The mac_ tools reach the person's own Mac through the dusk bot app on it, as the person: mac_exec runs a shell command (zsh), " +
    "mac_download saves a file from a link onto the Mac (into ~/Downloads by default), mac_read_file, mac_write_file and mac_list work with its files, mac_send_file brings a file from the Mac into your own files (then attach it to send it), and mac_open opens an app, a link or a file there.",
  cloudMacLimits(limits),
  limits.screen ? "The mac_ screen tools are the computer-control tools of the Mac itself; prefer pid and window_id targets and background delivery." : "",
  "If the Mac is offline the tool says so: ask the person to open dusk bot on it. A mac_exec that timed out may still have changed things; check before repeating it."].filter(Boolean).join(" ");
}

export function cloudMacPrompt(limits: CloudMacLimits): string {
  return [" You can also work on the person's own Mac, not only in your cloud: the mac_ tools (mcp__device__mac_exec, mac_download, mac_read_file, mac_write_file, mac_list, mac_open, mac_send_file) " +
    "act on it through the dusk bot app there, so never say you have no access to their Mac. Use it when the person asks for something on their Mac: run a terminal command or a CLI, " +
    "download a file into their Downloads, open an app or a link, or read and change their files. Your cloud and the Mac are different computers that share no folders: " +
    "to send the person a file from their Mac, bring it over with mac_send_file and attach the path it returns; to put one of your files on the Mac, write it there with mac_write_file.",
  cloudMacLimits(limits),
  cloudMacScreen(limits),
  "Everything you do on the Mac shows in the chat. If it is offline the tool says so; tell the person to open dusk bot on the Mac."].filter(Boolean).join(" ");
}

/** A dusk cloud whose owner has not let it use their Mac yet: the bot says how instead of saying it has no access. */
export const CLOUD_MAC_UNLINKED_PROMPT =
  " The person's own Mac is not connected to you yet, so you cannot act on it now. When they ask for something on their Mac or computer, do what you can here, " +
  "and say in one short sentence that they can let you use their Mac: in the dusk bot app on it, Settings > Your computer > Let my cloud bots use this Mac.";

export const MAC_OFFLINE_TEXT = "The person's Mac is offline: the dusk bot app on it is closed or not linked to this server right now. Ask them to open it.";
