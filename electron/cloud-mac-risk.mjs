// Which cloud-bot actions on the person's Mac are risky enough to ask about in Auto mode (docs/cloud-uses-mac.md).
// Plain rules, no model: deny-list patterns over a command and checks on the paths it names. The cloud uses them to
// decide on a card and the Mac uses the same ones to refuse a risky job that came without one.
//
// Known limit, by design: this catches ordinary dangerous commands, not a determined attacker; a command can hide
// what it does (an interpreter, a script file). "Ask before every action" is the setting for that.

export const CLOUD_MAC_MODES = Object.freeze(["auto", "ask", "never"]);
export const isCloudMacMode = (value) => CLOUD_MAC_MODES.includes(value);
const READS = new Set(["mac_read_file", "mac_list"]);
/** The computer-control driver's tools that only look at the screen (a mac_screen job's `name`). */
export const SCREEN_READS = Object.freeze(["list_apps", "list_windows", "get_window_state", "get_accessibility_tree", "get_desktop_state",
  "get_screen_size", "get_cursor_position", "verify_state"]);
const SCREEN_RISKS = { kill_app: "stops other programs", clipboard_read: "reads the clipboard, which can hold passwords" };
/** Screen actions that click, type or press keys in a window: in a sensitive app they ask first. */
export const SCREEN_INPUTS = Object.freeze(["click", "double_click", "right_click", "drag", "type_text", "press_key", "hotkey", "set_value", "invoke_menu"]);
/** Apps that run commands, change the system or hold passwords, by name or bundle id. */
const SENSITIVE_APP = /\b(terminal|iterm2?|ghostty|warp|alacritty|kitty|wezterm|hyper|tabby|script ?editor\d?|scripteditor2?|automator|shortcuts|system ?(settings|preferences)|systempreferences|keychain ?access|keychainaccess|disk ?utility|diskutility|1password|bitwarden|lastpass|dashlane|keepassxc?|enpass|keeper|passwords|powershell|pwsh|cmd(\.exe)?|command prompt|windows ?terminal|windowsterminal|regedit)\b/i;
export const sensitiveApp = (value) => typeof value === "string" && SENSITIVE_APP.test(value);
/** Web browsers, the Chromium dusk bot drives included, by name or bundle id: what they show is the web. dusk bot's own
 * window is not one. */
const BROWSER_APP = /\b(safari|google chrome|chrome|chromium|arc|firefox|microsoft edge|edge|brave( browser)?|opera|vivaldi|orion|zen|com\.apple\.safari|com\.google\.chrome|company\.thebrowser|org\.mozilla\.firefox|com\.microsoft\.edgemac|com\.brave\.browser)\b/i;
export const browserApp = (value) => typeof value === "string" && BROWSER_APP.test(value);
/** Screen reads that return what a window shows. */
export const SCREEN_PAGE_READS = Object.freeze(["get_window_state", "get_accessibility_tree", "get_desktop_state", "verify_state"]);

/** Whether this screen read brought in outside content: a browser window's page, the whole desktop, or a window the Mac
 * could not name. `target` as in screenRisk. */
export function screenReadOutside(name, target) {
  if (!SCREEN_PAGE_READS.includes(name)) return false;
  if (name === "get_desktop_state") return true;
  return !target || target.app === null || browserApp(target.app);
}
const SENSITIVE_REASON = "works in an app that can run commands, change the system or hold passwords";
/** Outside content read earlier in the turn (a page, an email, a message): its instructions may be steering the bot. */
export const OUTSIDE_REASON = "follows content from outside (a web page, an email or a message) read in this turn";
/** The reason "Ask before every action" gives for an action no rule calls risky. */
export const EVERY_ACTION = "asks before every action";

/** [pattern, reason] over a command with its whitespace folded. */
const COMMAND_RULES = [
  [/(^|[\s;&|(`])(sudo|doas|su)(\s|$)/, "runs as administrator"],
  [/osascript\b/, "runs AppleScript, which can control other apps and the system"],
  [/(^|[\s;&|(`])(csrutil|spctl|tccutil|launchctl|profiles|systemsetup|networksetup|pmset|scutil|dscl|dseditgroup|fdesetup|nvram|bless|kextload|kextunload|kmutil|softwareupdate|sysadminctl|security\s+(authorizationdb|add-trusted-cert|delete-certificate))\b/, "changes system settings or security"],
  [/\bdefaults\s+(-currentHost\s+)?(write|delete|import)\s+(\/Library|\/System|-g\b|-globalDomain|NSGlobalDomain|com\.apple\.)/, "changes system settings"],
  [/(^|[\s;&|(`])(diskutil|hdiutil|fdisk|gpt|asr|newfs_\w+|mkfs(\.\w+)?|dd)\s/, "works on disks or partitions"],
  [/\b(curl|wget|fetch)\b[^|;&]*\|\s*(sudo\s+)?(env\s+)?(ba|z|da|k|fi)?sh\b/, "runs a script straight from the internet"],
  [/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(python3?|ruby|perl|node|osascript)\b/, "runs a script straight from the internet"],
  [/(ba|z)?sh\s+(-c\s+)?["']?\$\(\s*(curl|wget)|<\(\s*(curl|wget)/, "runs a script straight from the internet"],
  [/\bbase64\s+(-d|-D|--decode)\b[^;&]*\|\s*(ba|z)?sh\b|(^|[\s;&|(])eval\s/, "runs hidden or generated code"],
  [/\bxattr\s+(-\w*[dc]\w*)(\s+-\w+)*\s*(com\.apple\.quarantine)?/, "removes macOS download protection"],
  [/(^|[\s;&|(`])(ba|z)?sh\s+[^\s;&|]*Downloads\//, "runs a downloaded script"],
  [/(^|[\s;&|(`])(open\s+)?[^\s;&|]*Downloads\/[^\s;&|]*\.(pkg|mpkg|command|tool|sh)\b/, "runs a downloaded installer or script"],
  [/(^|[\s;&|(`])(kill|killall|pkill)(\s|$)/, "stops other programs"],
  [/\bsecurity\s+(find-(generic|internet)-password|dump-keychain|export|unlock-keychain)\b|Keychains\//, "reads saved passwords"],
  [/(^|[\s;&|(`])security\s+[a-z]/, "uses the keychain"],
  [/Login[\\\s_]*Data|Cookies|Web[\\\s_]*Data|Local[\\\s_]*State|key4\.db|logins\.json|cookies\.sqlite|Keychain|\.keychain(-db)?\b|1Password|Bitwarden/i, "reads saved passwords or cookies"],
  [/(~|\$HOME|\$\{HOME\}|\/Users\/[^/\s]+)\/\.(ssh|aws|gnupg|kube|docker\/config\.json|netrc|npmrc|pypirc|config\/gh)\b|\bid_(rsa|ed25519|ecdsa|dsa)\b|(^|[\s/'"])\.env(\.\w+)?(\s|$|['"])/, "reads keys or secrets"],
  [/\bgh\s+auth\s+token\b|\b(gcloud|aws)\s+(auth\s+print-access-token|configure\s+get)/, "reads keys or secrets"],
  [/\bgit\s+push\b[^;&|]*(\s--force(-with-lease)?\b|\s-f\b|\s\+\S|\s--delete\b|\s--mirror\b)/, "rewrites or deletes history on a remote"],
  [/\bgit\s+(reset\s+[^;&|]*--hard|filter-branch|filter-repo|rebase|reflog\s+expire|update-ref\s+-d|branch\s+-D|clean\s+-\w*f\w*|checkout\s+--\s+\.|restore\s+(--staged\s+)?\.(\s|$)|stash\s+(drop|clear))\b/, "throws away or rewrites git history"],
  [/(^|[\s;&|(`])rm\s+(-\w*[rR]\w*|--recursive)\b|(^|[\s;&|(`])rm\s[^;&|]*[*?]/, "deletes many files"],
  [/\bfind\b[^;&|]*\s(-delete|-exec\s+rm)\b|\brsync\b[^;&|]*--delete|\b(shred|srm)\b|\.Trash\b|empty\s+(the\s+)?trash/i, "deletes files"],
  [/(>|>>|\btee(\s+-a)?)\s*[^\s;&|]*(\.(zshrc|zprofile|zshenv|bashrc|bash_profile|profile)|LaunchAgents\/|LaunchDaemons\/|\/etc\/)/, "changes what runs at login"],
  [/\bcrontab\b|\/Library\/LaunchAgents|\/Library\/LaunchDaemons/, "changes what runs on a schedule or at login"],
  [/(^|[\s;&|(`])(mas\s+purchase|stripe\s+(charges|payment_intents|payouts)\s+create)\b/, "pays for something"],
];

const WRITERS = /(^|[\s;&|(`])(rm|mv|cp|ln|chmod|chown|chgrp|touch|mkdir|rmdir|rsync|truncate|tee|install|ditto|unzip|tar)\s/;
const SYSTEM_PATH = /(^|[\s='"])\/(System|Library|usr|etc|bin|sbin|private|var|opt|Applications|Volumes|cores)(\/|\s|$)/;
const RECURSIVE_OWNERSHIP = /(^|[\s;&|(`])(chmod|chown|chgrp)\s+(-\w*R\w*|--recursive)\s+(\S+\s+)?(["']?(~|\$HOME|\$\{HOME\})["']?\/?(\s|$)|\/(\s|$)|\/(System|Library|usr|etc|Applications|Users)\b|~\/Library\b)/;

/** Why this shell command is risky, or null for an ordinary one. */
export function commandRisk(command) {
  const text = String(command ?? "").replace(/\s+/g, " ").trim();
  for (const [pattern, reason] of COMMAND_RULES) if (pattern.test(text)) return reason;
  if (RECURSIVE_OWNERSHIP.test(text)) return "changes permissions across your home or system folders";
  if (WRITERS.test(text) && SYSTEM_PATH.test(text)) return "changes system files";
  if (/(>|>>)\s*\/(System|Library|usr|etc|bin|sbin|private|dev\/disk)/.test(text)) return "changes system files";
  return null;
}

/** `path` with ~ written out against `home`, for the path rules. */
function expand(value, home) {
  const text = String(value ?? "").trim();
  if (!text || text === "~") return home;
  if (text.startsWith("~/")) return `${home}/${text.slice(2)}`;
  return text.startsWith("/") ? text : `${home}/${text}`;
}

const SECRET_PATH = /\/\.(ssh|aws|gnupg|kube|netrc|npmrc|pypirc|docker|config\/gh)(\/|$)|\/Library\/Keychains(\/|$)|\/\.env(\.[\w-]+)?$|\/(Cookies|Login Data)$|\/id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/;
const STARTUP_PATH = /\/\.(zshrc|zprofile|zshenv|zlogin|bashrc|bash_profile|profile)$|\/Library\/(LaunchAgents|LaunchDaemons)(\/|$)/;
const OPENS_CODE = /\.(pkg|mpkg|command|tool|sh|app|scpt|workflow|terminal|dmg)\/?$/i;
const PAYMENT = /(checkout|payment|purchase|\/pay(\/|$|\?)|\/buy(\/|$|\?)|billing)/i;

/** Why a path outside the person's own ordinary files is risky to change, or null. */
function writeRisk(file, home) {
  if (SECRET_PATH.test(file)) return "changes keys or secrets";
  if (STARTUP_PATH.test(file)) return "changes what runs at login";
  if (file !== home && !file.startsWith(`${home}/`)) return "changes files outside your home folder";
  if (file.startsWith(`${home}/Library/`) && !file.startsWith(`${home}/Library/Mobile Documents/`)) return "changes app or system data in your Library";
  return null;
}

/** Why this cloud-bot action is risky, or null. `home` is the Mac's home folder path. */
export function macActionRisk(tool, args, home) {
  const a = args ?? {};
  switch (tool) {
    case "mac_exec":
      return commandRisk(a.command);
    case "mac_read_file":
    case "mac_list":
    case "mac_send_file":
      return SECRET_PATH.test(expand(a.path ?? "~", home)) ? "reads keys or secrets" : null;
    case "mac_write_file":
      return writeRisk(expand(a.path, home), home);
    case "mac_download": {
      const to = expand(a.to ?? "~/Downloads/", home);
      return to.startsWith(`${home}/Downloads`) ? null : writeRisk(to, home);
    }
    case "mac_open": {
      const target = String(a.target ?? "").trim();
      const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(target)?.[0]?.toLowerCase();
      if (scheme && !target.startsWith("/")) {
        if (scheme !== "https:" && scheme !== "http:" && scheme !== "mailto:") return "opens a link that starts another app or a setting";
        return PAYMENT.test(target) ? "opens a payment or checkout page" : null;
      }
      if (sensitiveApp(String(a.app ?? target))) return "opens a tool that can change the system";
      return OPENS_CODE.test(target) && /[/.]/.test(target) ? "opens an installer, app or script" : null;
    }
    case "mac_screen":
      return screenRisk(a);
    default:
      return "is not a known Mac action";
  }
}

/** `target`: the app the Mac found behind an input action's pid ({ app: null } when it could not name one); only the
 * Mac knows it, so the cloud's own check skips it and the Mac asks for a card when it matters. */
function screenRisk({ name, arguments: call, target }) {
  if (Object.hasOwn(SCREEN_RISKS, name)) return SCREEN_RISKS[name];
  const args = call && typeof call === "object" ? call : {};
  if (name === "launch_app") return Object.values(args).flat().some(sensitiveApp) ? SENSITIVE_REASON : null;
  if (!SCREEN_INPUTS.includes(name) || !target) return null;
  if (target.app === null) return "acts on a window this Mac could not name";
  return sensitiveApp(target.app) ? SENSITIVE_REASON : null;
}

/** Ordinary looks: they never need a card for following outside content. */
export const isMacRead = (tool, args) => READS.has(tool) || (tool === "mac_screen" && SCREEN_READS.includes(args?.name));
const isRead = isMacRead;

/** Whether this action needs the person's Allow first in `mode`; null when it may run, else the reason to show. */
export function macApprovalReason(mode, tool, args, home) {
  if (mode === "never") return null;
  const risk = macActionRisk(tool, args, home);
  if (mode === "ask") return isRead(tool, args) && !risk ? null : risk ?? EVERY_ACTION;
  return risk;
}
