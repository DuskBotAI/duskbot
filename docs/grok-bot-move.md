# Move from Grok Bot

Grok Bot is a thin desktop client over a cloud service. Most of a bot lives in Grok Bot's cloud; the Mac keeps a
cache for its window. dusk bot moves a person's Grok Bot bots in two stages: first from that cache, with one click,
then from an export each bot writes of itself, with one click and one Enter per bot, whenever the person likes.

Nothing changes in Grok Bot. Sign-ins and keys never move.

## What moves, and what cannot

| Item | Where Grok Bot keeps it | Stage A (this computer) | Stage B (the bot's export) |
|---|---|---|---|
| Bot: name, description, colour, mascot shape, picture | the roster and `roster-avatars/` | yes | |
| Instructions | cloud; the roster has only a short description | the description, as starting instructions | the full text replaces them; the earlier text stays in the bot's history |
| Recent chat | a window of the last 200 entries or fewer per bot | one conversation, opened by a note saying how many messages came and that earlier ones stayed | |
| Earlier chat | cloud | no | no |
| Memory, facts about the person | cloud | no | every item, word for word, as memory topics |
| Skills | cloud | no | yes, switched off until reviewed |
| Routines | cloud; the chat names them in its events | their names, as a memory topic | paused, with their schedule and time zone exactly; an unknown zone, a schedule in words or an event trigger is listed for the person to set, never guessed |
| Connected apps | cloud; the cache has their names | names, to connect again on the Apps page | names only, never a server address |
| Files | cloud | no | no |
| Sign-ins, keys, tokens | Grok Bot's login files | never | refused |

There is no dusk bot equivalent for Grok Bot's app settings that a person would want carried, so none move.

Grok Bot's cloud has an API that would give everything, but it needs the account's session from Grok Bot's login
store. dusk bot never reads that store and never calls that API: using another app's session outside it is not ours
to do.

## Stage A: from this computer

Detection reads the roster, each bot's chat window, the connected apps' names and the bots' photos. The preview shows
each bot with its picture (or the nearest dusk bot colour and body to its look), its one-line description and what can
come now. Bots removed or hidden in Grok Bot are set apart and unchecked, two bots of one name are told apart, and a bot
moved before is shown as already here, with Update.

The move runs on the server, one bot at a time, each step named: profile, picture, chat, routines. A bot is made
through the package path (no keys, no grants, no connected apps, the default approval level) and lands in a "Grok Bot"
sidebar section. The move starts no engine turn, raises no notification, leaves no conversation unread and does not
switch the person's view. Stop finishes the bot being moved and keeps the ones done. Only one move runs at a time.
Each move records what it made, so Undo removes exactly that: the bots it made (after saying which have new messages)
and, for a bot it updated, only the conversation it added.

## Stage B: the rest, from the bot itself

For each moved bot, dusk bot builds a one-line request and opens it in Grok Bot with
`grokbot://app/v1/prompt?id=<roster id>&text=<request>`. Grok Bot opens that bot with the request typed in an empty
message box; it never sends, so the person presses Enter. The request asks the bot to save
`grok-bot-export-<tag>.md` in Downloads (the tag is eight hex digits hashed from the whole roster id, so no two bots share a file), holding one JSON block in the shape `parseGrokExport` reads, with no
passwords, tokens or keys and header names only. If the link does not work, the same request can be copied.

While a bot is awaited, the server looks in Downloads every 4 seconds for that file name only (a browser's numbered copy
too). A dropped or pasted export goes through the same path. The export is applied to the same bot, never a new one. A
file that cannot be used is named with the reason in plain words: cut off, holding a key so nothing in it was used, in a
newer format, too large, or for a bot not moved. The waiting state survives a restart.

## Identity

Every moved bot carries where it came from on its installed package: the app (`grok-bot`) and its roster id. A second
move, an export, a dropped file or a notes import for the same bot updates that bot. Exports and notes, which carry no
roster id, find it by name: Grok bots' package ids are their app and name, and the ids an earlier version gave them
(name and instructions) are still recognised.

## Security rules

- Only these are opened: the slices `roster.last-roster`, `transcript.replicas.<id>` and `mcp.connect-logos` in
  `sand-client-persistence`, the photos in `roster-avatars` named by the roster, and in Downloads only files named as an
  export. Never `sand-secrets.json`, `Cookies`, `Local Storage`, `sentry/`, anything under `~/.grokbot` or any other
  slice.
- Paths are built from fixed folder names and a folder's own listing. A link in place of a folder or file is refused.
- Every slice is checked for size and format version; one that is too large, unreadable or newer costs only that item,
  with a plain message.
- Chat text and export text stay on the server. The renderer gets names, descriptions, counts and pictures only.
- Imported text runs through secret redaction. An export with a credential-named key is refused whole. An MCP address
  is never enabled on import, and one whose host or path looks like a key is not carried at all.
- The routes answer only the desktop app's own owner, on the computer whose files they read. Logs carry counts and ids.

## The link's limits

Grok Bot's link parser drops a link silently when it breaks a rule, so the request is built to fit: one line, printable
ASCII, at most 1000 characters, no `#` or `\`, and the whole URL at most 2048 characters once percent-encoded. The bot's
name is reduced to plain ASCII and shortened. A unit test checks these limits with the worst bot name.

## Where it is

- Wire contract: `shared/grok-move.ts` (routes, detection, choices, progress, result, waiting state, the request and
  link builders).
- Readers: `server/grok-local.ts`. The move and stage B: `server/grok-bot-move.ts`. Records: `server/grok-bot-move-store.ts`
  (the local database beside the messages). Routes: `server/routes/grok-move.ts`.
- Verification: [docs/verification/grok-move.md](verification/grok-move.md).
