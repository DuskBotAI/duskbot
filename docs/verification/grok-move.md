# Move from Grok Bot (Nov 20 2026)

The direct move ([docs/grok-bot-move.md](../grok-bot-move.md)) through its HTTP routes, on an isolated fake-engine
server run as the desktop app's own (owner token). Its temporary home holds a synthetic Grok Bot profile
(`server/testing/grok-bot-profile.ts`): seven invented bots, two with pictures, one chat at the 200-entry window with
earlier history, one with none, routine events (one routine deleted), two connected apps, a removed bot, two bots named
the same, and one chat slice in a format newer than dusk bot reads. Login material beside it (`sand-secrets.json`,
`Cookies`, `Local Storage`, `sentry/`, `~/.grokbot`) holds a sentinel.

```sh
node --experimental-strip-types scripts/verify-grok-move.ts
```

It detects, moves every live bot, sends a second move at once, asks the first bot for the rest, drops that bot's export
into the fixture's Downloads under the requested name, waits for it to be applied, previews the undo and undoes the
move, then stops its server. It prints counts and timings only. What it shows on the synthetic profile:

| Step | Expected |
|---|---|
| detect | 7 bots, 1 removed, 2 with a picture, 236 messages, 1 chat with earlier history, 3 routine names, 2 apps, one `chat:newerFormat` problem |
| photo | 200, `image/png` |
| move | 202, the second move 409, `done`, 6 done and 0 failed, 236 messages, 2 pictures |
| landed | 6 bots in the "Grok Bot" section, 0 unread, no engine turn started (the fake engine's dump is absent) |
| request | text at most 1000 characters, URL at most 2048 |
| export | `arrived` within one Downloads look (4 s): 2 memories, 1 skill (off), 1 routine paused, 2 routines to set (an unknown zone, a schedule in words), 1 app name |
| undo | the preview names 6 bots, 6 removed, none kept |

`GROK_HOME_FROM=<home>` copies only `sand-client-persistence` and `roster-avatars` from another home's Grok Bot folder
into the fixture instead, and skips the export and the undo: the way to time a move on a copy of a real profile without
printing anything from it. Never point it at a live `~/Library/Application Support/Grok Bot`, and never open the
printed request URL on a computer where Grok Bot is installed.

```sh
pnpm exec vitest run shared/grok-move.test.ts shared/grok-import.test.ts server/grok-local.test.ts server/grok-bot-move.test.ts server/routes/grok-move.test.ts server/routes/setup-import.test.ts src/lib/grok-move.test.ts src/lib/bot-move.test.ts
```

The reader test records every file opened and checks that only the allowlisted slices and photos were, and that the
sentinel reaches no answer. The move test runs the real store, routines, skills, memory and package path over a
throwaway home: a quiet opening note, no unread conversation, a second run updating the same bot, stop, a move cut off
by a restart, undo with its new-message count, and the export applied to the same bot (instructions with history,
memories word for word, skills off, routines paused in their own zone, refusals in plain words). The route test covers
the owner-only guard, the answer away from the desktop app, methods, content type, bodies and each failure.

What a Grok Bot move would do on a real home, in counts only, without writing anything:

```sh
node --experimental-strip-types scripts/import-dry-run.ts
```

## The screens, in the real renderer

The whole app as the desktop app's own window (`scripts/testing/grok-move-preview.tsx`: its `openExternal` only records
the link it is handed), proxied to the same kind of fixture with the synthetic profile, driven by its buttons in headless
Chrome. Playwright is not a dependency: point `DUSK_VERIFY_PLAYWRIGHT` at a `playwright` or `playwright-core` module and
`DUSK_VERIFY_BROWSER_CHROME` at a Chrome.

```sh
node --experimental-strip-types scripts/verify-grok-move-ui.ts
SHOTS=.dusk-scratch/grok-shots SKIN=dark WIDTH=390 node --experimental-strip-types scripts/verify-grok-move-ui.ts
```

It opens Move from Grok Bot from the palette, checks the preview (one row per bot, the two pictures, the chat in a newer
format named on its row, focus on the title), moves every live bot (the first progress look is held 1.5 s so the screen
on its way is seen; the data is the server's), then on the result asks two bots for the rest. The page records one
`grokbot://app/v1/prompt?id=<that bot>&text=…` link per ask, at most 2048 characters, and nothing is opened. It writes the
first bot's export and a second bot's export holding a key into the fixture's Downloads under the requested names: the
first row turns to Got it, the second says the file had keys and nothing was used. Settings' Grok Bot row says
"Waiting for 1 bot to send the rest." and reopens the result; after a message to a moved bot, Undo shows the warning and
the six bots, and confirming removes them. Expected: 6 rows moved, 236 messages, 2 pictures, 6 in the "Grok Bot" section,
0 unread, the export within two Downloads looks, 0 page errors.

```sh
pnpm exec vitest run src/components/grok-move src/components/ImportSettings.test.ts src/components/onboarding/WelcomeFlow.test.ts
node --test electron/app-permissions.node-test.mjs
```

The screen tests play the server with a fake client: every screen and state (nothing found, a chat too new to read, all
already here with Update, a move running when opened, an interrupted move, a failed bot with Try again, waiting, got it,
a refused file, a dropped export, Undo with new messages). The Electron test holds the desktop bridge to Grok Bot's exact
prompt link, never through `window.open`.

`GROK_HOME_FROM=<home>` does the same as the route recipe: copies only Grok Bot's cache and photos, moves every live bot
through the screens and prints counts and timings, with no screenshot, no ask and no undo.

Not covered here: the packaged Electron window and macOS's Downloads prompt, and Grok Bot itself opening
the link (the link is checked by unit test against the parser's rules, never opened).
