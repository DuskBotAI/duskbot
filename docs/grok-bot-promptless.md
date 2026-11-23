# Moving from Grok Bot with as little effort as possible

This is the companion to [`docs/grok-bot-move.md`](grok-bot-move.md). It answers two questions:

1. **What genuinely lives in Grok Bot's local cache on this computer**, slice by slice, and how faithful each thing is
   against the bot's own export (stage B), which is the ground truth for a full move.
2. **How close the per-bot prompt path (stage B) can get to zero effort** without ever reading Grok Bot's stored
   session or calling its cloud. The answer is: one consent, then one Enter per bot.

The honest conclusion up front: the local cache is a UI render cache. It holds a bot's identity, its recent chat window,
the names of its routines, and the names of connected apps. It does **not** hold full instructions, memory, user facts,
skills, or routine bodies/schedules — those live only in Grok Bot's cloud. So the most a zero-action move can do is
covered below, and the rest is made cheap (not free) by the walk in the second half of this document.

## 1. What is in the local cache

Grok Bot keeps a per-account cache under the user-data folder (`…/Grok Bot/sand-client-persistence/`) as slices named
`sand.client.slice.account.<account>.<kind>`, plus photos beside it in `roster-avatars/`. The reader
(`server/grok-local.ts`) opens only the slices in the table below; everything else in those folders is never listed or
read (login material: `sand-secrets.json`, `Cookies`, `Local Storage/`, `sentry/`, `~/.grokbot`, and any other slice).

| Slice / file | What it holds | Read? | Carried onto the moved bot |
|---|---|---|---|
| `roster.last-roster` | Per bot: id, name, **title/label**, **short description**, avatar shape + colour, avatar photo key, created/updated, removed/hidden flags, group flag. The `path` field points at a cloud sandbox `store.db` (not on this computer). | yes | name, title, colour, shape; the short description as **starting** instructions |
| `roster-avatars/<key>` | A bot's picture (PNG/JPEG/WebP). | yes | the picture, cropped to a circle |
| `transcript.replicas.<rosterId>` | The **recent chat window** (≤ 200 entries): user/bot text, attachments (file names), tool calls (`mcp-app`: `serverName`, `toolName`), voice calls, widgets/emails, and `automation-changed` **events**. `precedingTimestampMs`/`seq` mark that earlier history exists only in the cloud. | yes | the window as one quiet conversation; routine **names** + on/off from the events; **per-bot app names** from `mcp-app` lines (new, see below) |
| `mcp.connect-logos` | Account-wide **connected-app names** (name + icon URL). | yes | shown as "connect again here" (names only; no addresses) |
| `mcp.*` (other) | e.g. a `connectedApps` **count**; no names or addresses. | no | — |
| `composer-drafts` | The person's **unsent draft text** in a bot's composer. | no (deliberately; it is not bot setup and may hold anything the person was typing) | — |
| `settings.*` (e.g. `settings.tokens`) | App settings / login material. | no | — |

### What the cloud keeps and the cache does not

None of the following appears in any local slice, so none of it can move with zero action:

- **Full instructions** — the roster has only a one-line description. The real role/system prompt is cloud-only.
- **Memory / notebook** and **facts about the person** — no local slice.
- **Skills** — neither bodies nor even names are in the cache (routine events name routines, not skills).
- **Routine bodies, 5-field schedule, IANA time zone, trigger** — only routine *names* and on/off reach the cache,
  via `automation-changed` chat events.
- **Connected-app server addresses and auth** — only names are cached.
- **Files/attachments** shared in chats, and **earlier chat** before the window — cloud-only.

### The one local climb made here: per-bot connected apps

Before this branch, connected apps were read only as the account-wide `mcp.connect-logos` list and shown once in the
result ("connect these again here"). The chat window, however, records which apps a bot actually *used*, in its
`mcp-app` lines (`serverName`). `readGrokChat` now aggregates those into `GrokChatWindow.appsUsed` (each name once, a
lower bound on what the bot is connected to), and the move writes them onto the bot as a memory topic
`grok-bot-apps.md` ("Apps <name> used in Grok Bot"), counted as `appsUsed` in the move result and shown as a preview
chip. This raises the **apps** item from an account-wide list to **per-bot attribution**, at zero extra action, using
data that genuinely exists locally. It is still names-only — which is exactly the ceiling stage B reaches too, because
app server addresses are refused/redacted by policy on import.

Mapper: `appsUsedIn` in `server/grok-local.ts`. Tests: `server/grok-local.test.ts` (the mapper reads `["Calendar"]`
for the synthetic Nova) and `server/grok-bot-move.test.ts` (the move writes `grok-bot-apps.md` and reports
`appsUsed: 1`).

## 2. Making stage B near zero-effort: the walk

Everything the cache cannot give still comes from the bot's own export. Before, the person asked each bot one at a
time: click **Ask <name>**, press Enter in Grok Bot, wait, repeat — plus, if a browser downloaded the file, nothing to
do, but each bot was a separate manual step. The **walk** collapses that to a single consent:

1. One consent panel names exactly what will happen: dusk bot opens each bot in Grok Bot with the request already
   typed, one after the next; the person presses Enter in each; **nothing sends on its own**; dusk bot reads only the
   file each bot saves to Downloads. Off by default — it is a button the person chooses.
2. On agreeing, dusk bot opens the first bot's prefilled request (`grokbot://app/v1/prompt?…`, the same link the manual
   Ask uses). The person presses Enter.
3. The server's existing Downloads watch picks up that bot's export and applies it. When it arrives (or is refused),
   the walk opens the **next** bot on its own and shows "Asking <name>… n of N".
4. It ends when every asked bot has sent its file or been refused; refused bots keep their per-bot **Ask again** button.

The walk is driven entirely in the renderer (`GrokMoveDialog` + `GrokMoveResult`'s `WalkBanner`) over the unchanged
server routes — no new server state, nothing new read. The per-bot Ask buttons remain as the fallback when consent is
declined, a link cannot open, or a file is refused.

### Effort, per bot, for the cloud-only items

| | Before | With the walk |
|---|---|---|
| Consent | — | 1 (once, for the whole move) |
| Clicks to ask | 1 per bot | 0 |
| Enter presses in Grok Bot | 1 per bot | 1 per bot |
| Manual Downloads handling | 0 (watched) | 0 (watched) |
| Advancing to the next bot | manual | automatic |

So a move of N bots goes from **N× (click + Enter)** to **1 consent + N× Enter**. The Enter cannot be removed without
reading Grok Bot's session (see §4) — the bot has to be the one to produce its own setup.

## 3. Score

**Metric.** Ground truth is the bot's own export (stage B), which moves six item types per bot: `instructions`,
`memories`, `user_facts`, `skills`, `routines` (with schedule + time zone), `apps`. The score is **item types moved
with zero user action at full fidelity ÷ item types stage B moves**. "Full fidelity" means word-for-word for
instructions and memory, exact 5-field schedule + IANA zone for routines, and the same names-only result for apps.
(Name, title, picture, colour and the recent chat window are *also* moved with zero action, but the export does not
carry them, so they are not in the denominator — they are a bonus the local cache gives on top.)

### Per-item fidelity, zero-action (stage A) vs the stage-B export

| Item (stage-B ground truth) | Zero-action from local cache | Full fidelity? |
|---|---|---|
| instructions | short **description** only (the roster has no more) | ✗ — full text is cloud-only |
| memories | — | ✗ — not in any local slice |
| user_facts | — | ✗ — not in any local slice |
| skills | — | ✗ — not in any local slice |
| routines (+ schedule + tz) | **names** + on/off (from chat events) | ✗ — bodies/schedule/tz cloud-only |
| apps | **names**, now per-bot (`appsUsed`) + account-wide | ✓ — names are all stage B carries too |

**Score = 1 / 6 ≈ 17%** of the export's item types move at full fidelity with zero user action.

### Hill-climb log

The metric cannot be pushed past the data that physically exists on the computer, so the climb is short and bounded by
proof, not by effort.

- **Iteration 0 (baseline on `feat/grok-bot-direct-move`): 1/6.** Apps moved at full fidelity promptless, but only as
  the account-wide `mcp.connect-logos` list; instructions were partial (description); routine names and the chat window
  moved but are not stage-B items.
- **Iteration 1 (this branch): 1/6, apps fidelity raised within the item.** Added `appsUsedIn` so each bot carries the
  apps it actually used (from its `mcp-app` chat lines) — per-bot attribution instead of one shared list. No new item
  *type* became promptless, because a search of every local slice (see §1) found no local copy of instructions,
  memory, facts, skills, or routine bodies/schedules. Ceiling reached and proven: **1/6**.
- **Why no iteration 2.** Climbing to 2/6+ would require full instructions, memory, skills or routine schedules at zero
  action. None exist locally. The only way to obtain them without an Enter is to read Grok Bot's stored session and
  call its cloud — which is §4, deliberately not built.

Measured end-to-end on the synthetic fixture by `scripts/verify-grok-move-ui.ts` (the walk) and
`scripts/verify-grok-move.ts` / `scripts/import-dry-run.ts` (counts, including `appsUsed`). No real Grok Bot session or
account is touched anywhere in this work.

## 4. Cloud session route (needs AJ's decision)

A fully prompt-less move — one that brought full instructions, memory, facts, skills and routine schedules with **zero**
Enter presses — is only possible by reading Grok Bot's stored, encrypted session from the OS keychain / its local secret
store (as `grok-bot-cli` does) and calling Grok Bot's cloud gateway with it, read-only.

That is **not built here, on purpose.** Shipping it would mean this open-source app, which others clone and fork,
contains credential-extraction behaviour (decrypting another app's saved session) by default. Whether to include a
consented, opt-in version of that path — and under what gating, attribution and review — is a product and trust
decision that belongs to the fork owner (AJ), not something this change should make silently. The code here therefore
stops at the local cache plus the one-Enter-per-bot walk, and never reads `sand-secrets.json`, cookies, `Local Storage`
or anything under `~/.grokbot`.

If that route is ever added, the honest effect on §3 would be to move all six item types to full fidelity with zero
Enter (6/6), at the cost described above.
