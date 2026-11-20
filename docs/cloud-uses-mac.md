# Cloud bots use this Mac

A person's bots on their dusk cloud can work on that person's Mac while the Mac is on and the dusk bot app is open: run
terminal commands, download files, read and write files, and open apps and links, and see and use the Mac's screen with
the same computer tools a bot on the Mac has, through the app's own computer control (its Accessibility and Screen
Recording grants); see [Screen](#screen). Both are on by default for the owner's own Mac; the person can turn either off.

## What it reuses

- **"Your Mac" for a linked VPS** (`server/mac-control/`, `electron/mac-control*.mjs`): the Mac app long-polls its
  server for jobs (`GET /api/mac/self/jobs`), runs them and posts results. Jobs reach bots as the device MCP server's
  `mac_*` tools, so every call shows in the chat. The cloud path is the same host, poller and executor with a cloud
  mode added.
- **The app's own session at My Cloud**: the same signed Admin pairing the app already uses to lend its connection
  (`electron/home-egress-link.mjs`). It is an admin, non-browser session with no team membership, which is what
  `macHostSession` requires. No port opens on the Mac.
- **The cloud's link key** (`linkPublicKey` at the Admin, the private half in the cloud's `dashboard-link.json`): the
  trust anchor for sealing, see below.
- **Harness-native approval cards** (the peer approval pattern): Allow, Deny, Always allow, with `allowKey` saved to
  the bot's `alwaysAllow` through the existing route.

## Transport

The Mac reaches `https://<cloud>` with its session cookie, but TLS ends at the hosting provider's port proxy, not on
the cloud machine (`apps/cloud-service/deploy/Caddyfile`). So the jobs are sealed end to end on top:

1. The Mac makes an X25519 key pair per run and sends the public half with each poll (`key=`).
2. The cloud seals each job to that key (one-job X25519 key, HKDF-SHA256, AES-256-GCM) and signs the envelope with its
   link key (Ed25519).
3. The Mac gets the cloud's link public key from dusk.bot (in the pairing grant it already asks for), never from the
   cloud's own address, checks the signature and that the job was sealed to its own key, refuses expired or repeated
   jobs, then decrypts.
4. The result goes back sealed with the same job key, bound to the job id.

The edge can neither read jobs or results passively nor inject or change a job. Open risk: an edge that swaps the
Mac's key in a poll can read that one job's contents (it still cannot run anything: the real Mac refuses a job not
sealed to its key).

## Tools

| Asked for | Tool |
| --- | --- |
| mac.run | `mac_exec` (command, cwd, timeoutSeconds up to 600, last 200 KB of output) |
| mac.download | `mac_download` (https or http link to a folder or file path, default `~/Downloads/`, 2 GB cap) |
| mac.files | `mac_read_file`, `mac_list`, `mac_write_file` |
| mac.open | `mac_open` (an app by name, a link, a file) |
| mac.send | `mac_send_file` (a file from the Mac into the bot's own files, `from-mac/`, up to 8 MB; the bot attaches it to send it) |

The cloud and the Mac share no folders: a file the person asks for from the Mac comes over in the sealed outcome of a
`mac_send_file` job, and is kept under a name of its own in the bot's files. Under Auto it asks only for keys and secrets
(as a read does), and like any action but a look it asks once the turn has read outside content.

`mac_screenshot` and `mac_save_from_cloud` are not offered on a cloud. The person's own Mac is not outside content: a
`mac_` call (a download there answers only where it saved) does not make the rest of the turn ask. When the Mac is not polling, a call answers
"The person's Mac is offline" and nothing runs.

## Screen

"Use my Mac to do X" from the phone or a cloud bot works on the Mac's apps, not only its terminal, when the person
allows the screen:

- **The tools** are the Mac's own computer-control driver's (cua-driver, the one a bot on the Mac uses), offered as
  `mac_<tool>`: `mac_list_apps`, `mac_list_windows`, `mac_get_window_state`, `mac_launch_app`, `mac_click`,
  `mac_type_text`, `mac_press_key`, `mac_hotkey`, `mac_scroll` and the rest, without the driver's `*_out_file` arguments
  (a screenshot comes back in the answer, never as a file written on the Mac). The catalog is the cloud's
  (`server/mac-control/screen.ts`): the Mac lists its driver's tools in a sealed `mac_screen_tools` job once it polls
  with the screen allowed (again when the driver's version changes), and the cloud keeps those a local bot gets beside a
  browser of its own (`server/computer-tool-list.ts`: no driver upkeep, none of the driver's own browser). The prompt
  steers to window-targeted background work: pid and window_id, read with `mac_get_window_state`, act by
  element_index, the foreground only when a window will not take background input.
- **Each call** is one sealed `mac_screen` job (`{ name, arguments }`), the same transport, sealing and poller as the
  commands. The cloud runs the local computer proxy's relay (`localComputerRelay` in
  `server/local-computer-guidance.ts`) over those jobs, so multi-line text is typed line by line with Shift+Return
  between and Windows gets its paced typing and click check, exactly as on the Mac. The answer is the driver's own
  result (text, the first image, structuredContent, isError).
- **On the Mac** (`electron/cloud-screen.mjs`) the app speaks MCP over stdio to the driver connection it already runs
  (`cuaConnection()` in `electron/cua.mjs`), so the person's existing grants apply and nothing new is installed. Windows
  is the same path through its packaged driver.

Consent, on top of everything in Settings and safety below:

- **"Let them use this Mac's screen"** (Settings > Your computer, under the main switch): on by default (an unset value
  is on; a person who turned it off stays off). With Accessibility and Screen Recording already given to dusk bot the
  Mac says `screen=1` and the screen tools are offered. Without them it says `screen=grant`: the bot gets one tool,
  `mac_request_screen_access`, and calls it on first need; the Mac then runs the app's own grant flow
  (`requestComputerUse`, macOS's own prompts), at most once per 10 minutes, and the tools appear on a later turn.
  Turning the switch back on after an off goes through a native confirm on the Mac (and the same grant flow). While off
  the Mac says nothing about the screen, the cloud offers no screen tools, the prompt carries one line on where to allow
  it, a screen call is answered with that same line, and the Mac refuses any screen job itself.
- **Indicator and Stop**: while a cloud bot acts on the screen, and for 15 s after its last action, a menu bar item
  says "Cloud bot on screen" with Stop, and the Settings card shows "<bot> is using this Mac's screen" with Stop. Stop
  ends what runs, closes the driver connection and turns the screen switch off. Turning the main switch off stops it
  too.
- **When to ask**: under Auto, `kill_app` and `clipboard_read` ask, and so does anything in an app that runs commands,
  changes the system or holds passwords (Terminal, iTerm, Ghostty, Warp and other terminals, Script Editor, Automator, Shortcuts, System Settings,
  Keychain Access, Disk Utility, 1Password, Bitwarden and other password managers, PowerShell, Command Prompt):
  launching one is caught by the cloud, and a click, typing or keys into one by the Mac, which looks up the app behind
  the action's pid with the driver's `list_apps` and refuses with `ask` (the outcome's reason); the cloud then shows the
  card and sends the action again, allowed. An input action whose window the Mac cannot name asks too. Under "Ask
  before every action" every screen action but a look (`list_apps`, `list_windows`, `get_window_state` and the other
  reads) asks, `mac_request_screen_access` included, on both sides. The card names the tool and its text, keys or app.
  "Always allow" saves `mac_screen:<tool>` for that bot.
- **Outside content**: under Auto, once a turn has read outside content since the person's last message (a web page or
  fetched link, an email or connector result, a download, another bot's words, a webhook or watched chat's message;
  the same test that keeps such words out of memory, `server/memory-trust.ts`), every command, file change, download,
  open and screen input in the rest of that turn asks, with "it follows content from outside". That card offers
  **Allow for this task** beside Allow and Deny (no Always allow): it lets the rest of that task's turn run without
  outside-content asks (`allowTask` on the card, `always` on the answer, cleared when the next turn starts). Sensitive
  apps, credential commands and every other rule still ask each time. Looks stay free, but
  reading a browser's window (`get_window_state`, `get_accessibility_tree`, `verify_state` on Safari, Chrome, Chromium,
  Arc, Firefox, Edge, Brave and others; dusk bot's own window is not one), the whole desktop (`get_desktop_state`) or a window the
  Mac cannot name counts as outside content itself: the Mac marks that result `outside` and the cloud counts the rest of
  the turn as tainted. Other apps' windows stay free.
- **Naming the app**: the Mac names the app behind a pid from the driver's `list_apps`, its `structuredContent.apps`
  (`pid`, `name`, `bundle_id`, `running`; installed apps that are not running have pid 0) or, failing that, its text
  lines (`- Finder (pid 685) [com.apple.finder]`), the shape cua-driver 0.28.2 answers with.
- **Log**: each screen action is one line (`mac_screen click on pid 42 window 7`); never the typed text.
- **Only these folders** limits files and commands, not the screen: a bot on the screen can reach what the person's
  apps can.

## Settings and safety

Settings > Your computer, on the cloud's own Settings page in the app:

- **"Let my cloud bots use this Mac"**: on by default for the owner's own Mac and decided on the Mac: an unset value is
  on, with no confirm; a person who turned it off stays off. Turning it back on from off shows a native confirm on the
  Mac, so a page cannot turn it on alone. A settings file that is there but cannot be read turns both switches off.
  Anything else the cloud's page asks that loosens the rules (a laxer When to ask, turning Only these folders off)
  passes a native confirm too; tightening, adding a folder (its own picker) and removing one do not. While off the app does not poll at all. Turning it off is the kill
  switch: running commands are stopped and the cloud is told to forget the Mac.
- **When to ask**:
  - **Auto (asks only for risky actions)**, the default. Ordinary work just runs; a card appears only for what
    `electron/cloud-mac-risk.mjs` calls risky: sudo and other admin, AppleScript, system and security settings
    (csrutil, spctl, tccutil, launchctl, profiles, system `defaults` domains), disk tools, `curl | sh` and running
    downloaded scripts or installers, removing quarantine, recursive delete or delete by wildcard, emptying the
    Trash, recursive permission changes on home or system folders, killing processes, reading keys, passwords and
    `.env` files, browser saved passwords and cookies (Login Data, Cookies, logins.json), the keychain and any
    `security` command, force-push, `reset --hard` and other history rewrites, login and schedule items, writes outside the
    home folder or into `~/Library`, non-web links, checkout pages, payments. Plain rules, no model; a table of
    examples both ways is in `electron/cloud-mac-risk.node-test.mjs`.
  - **Ask before every action**: every command, download, file change and open asks; ordinary reads do not.
  - **Never ask**.
  - The card says why it asks. "Always allow" saves an exact plain command (no shell syntax) in its folder, a download
    site, a write folder, an exact open target or a read path, per bot.
- **Only these folders**: off by default. When on, reads, lists, writes, downloads and a command's folder must resolve
  (links followed) inside the list (default `~/Downloads` and `~/dusk bot`), and only https, http and mailto links open.
- **View log**: each job is one line in `~/Library/Logs/Dusk Bot/mac-control.log` (tool, bot, command or paths, whether
  a card allowed it, outcome or refusal; never file contents). The chat keeps each tool call too.

The Mac tells its cloud its mode, home folder and folder limit in each poll, so the cloud knows when to show a card;
the Mac applies the same rules itself before it runs a job, so a cloud or edge that skips the card gets a refusal.
The Auto rules catch ordinary dangerous commands, not a determined attacker who hides what a command does; "Ask
before every action" is the setting for that.

**Same account only**: the app serves only its own My Cloud (never a team cloud or another person's), the cloud only
takes a session from the owner's own app, and only the owner's own turns get the tools. Team members: not in this
version. **Credentials never leave the Mac**: jobs run there as the person; the cloud sees only what a command prints
or a read returns. Polling never wakes or keeps awake a sleeping cloud: the app polls only while it is awake, and the
poll is a background path.

Security invariant: the cloud's `dashboard-link.json` must stay unreadable to bot turns, as it already must for the
Admin link; a bot that could read it could sign jobs.

## Releases

- **Desktop app**: the screen switch, its confirm, the driver client and the indicator; the Settings rows' bridge, the poller, sealing, rules, executor (`mac_download`, stoppable
  commands), log.
- **Cloud image**: the screen catalog and relay, cloud mode of `/api/mac`, sealing, cards, the Settings rows, the poll as a background path.
- **Admin (dashboard)**: the pairing grant carries the cloud's link public key.

All three are needed; an older piece fails closed (the app says the cloud needs an update and does not poll).
