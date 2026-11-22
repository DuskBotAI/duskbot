# Sidebar confirmations

Launch `node --experimental-strip-types scripts/verify-sidebar.ts`. It creates
an isolated fake-engine server and two disposable bots, then prints a preview
URL. Open that URL, never the user's live app. Ctrl-C closes both servers and
removes only the fixture data.

The preview mounts the actual Sidebar and StoreProvider. Verify:

1. Click Archive Sidebar Atlas: Archive receives focus by default, since an
   archive can be undone.
2. Tab wraps to Cancel; Shift-Tab wraps back to Archive.
3. Escape closes the dialog, leaves `Drawer: open`, and restores focus to the
   Archive trigger. No bot is archived.
4. Right-click Sidebar Atlas and choose Delete: Cancel receives focus by
   default, so Enter does not delete. Cancel leaves the bot intact and returns
   focus to the sidebar if the menu trigger has disappeared.
5. Repeat Delete and confirm. Only the disposable Atlas bot disappears; the
   remaining bots are unchanged and keyboard focus remains in the sidebar.

Verified on 2026-09-05 against the isolated renderer. Static regression coverage
in `src/components/SidebarBotListItem.test.ts` checks dialog semantics/copy,
chief labels, role badges, and working/waiting indicators. The interaction checks
above are manual browser verification, not assertions made by those unit tests.
This fixture covers the sidebar confirmation and bot-row result only; it does
not exercise Settings > Computers deletion or provider completion polling.
Use the [VPS recovery fixtures](vps-recovery.md) and
[desktop viewer fixture](desktop-viewer.md) for computer lifecycle and viewing.

## Mark all of a bot's conversations as read

Run `node --experimental-strip-types scripts/verify-sidebar.ts --unread`.
This opt-in fixture seeds Sidebar Atlas with twelve unread webhook-like
conversations across a folder and unfiled history, plus a running fake-provider
turn and a sibling report queued behind its capacity limit. The data directory contains `bulk-read-before.json`.
Open only the printed `previewUrl`:

1. Open **Actions for Sidebar Atlas → Mark all conversations as read**.
   While requests are pending the action shows progress and cannot be repeated.
2. All existing unread conversations for Atlas become read. Its working and
   queued indicators remain. No conversation is selected, deleted or archived.
3. Reload and inspect the same fixture's `/api/bots` response: unread flags
   remain cleared, transcripts and the queued report remain intact, and
   the fake turn is still running. Other bots retain their state.
4. With no unread conversation, the menu action is disabled. In the real
   app it also remains available with **Show threads** off; thread-pinned
   remote clients do not receive an action that targets their siblings.

`src/lib/bot-read.test.ts` covers legacy state, all folders/unfiled/archived
threads, work and approval preservation, ordered requests for 250 threads,
partial failure/retry and new-thread arrivals. `src/components/SidebarBotRead.test.ts` mounts
the actual menu to check progress, duplicate-click protection, error recovery,
Portuguese copy, hidden thread trees and a menu reopened during a read.
Folder reads use the same request helper and retain their existing tests.

Verified on 2026-10-09 in the isolated renderer: 14 unread threads became
read; all 15 conversations, transcripts, settings and the other bots were
unchanged. One fake-provider turn kept running and one sibling message stayed
queued. The cleared flags persisted after reload, and the empty action was
disabled. Progress was visible during the requests. Native desktop clients
were not exercised by this browser check.

## Section deletion

Run the isolated server lifecycle fixture:

```sh
pnpm exec vitest run server/team-lifecycle.e2e.test.ts src/components/SidebarSectionHeader.test.ts --maxWorkers=1
```

The API fixture checks retaining conversations and archived state when a
section is deleted, preserving legacy section data on rename, and refusing
invalid writes. The component test covers collapse, keyboard reordering,
attention indicators and the section menu. The removed Team map browser
fixture no longer proves deletion-dialog focus or current sidebar deletion
interactions; those need a new isolated renderer check. See [Sections](teams.md)
for the retained server lifecycle behavior.

## Activity, quieter rows, and notification preference

Use the full-app [threads fixture](threads.md) for channel activity, search,
and snooze interactions. Compact/quiet rows must retain live status and
keyboard-accessible owner-row New thread/New folder controls. The matching
sole thread must still appear during search even when its normal tree is hidden.

In Settings → Appearance, **Notification sounds** controls the operating
system alert sound on this computer only; it does not disable notification
banners or the bot's own notification setting. `src/lib/notification-preferences.test.ts`
and `src/lib/notify.test.ts` cover persisted preferences, blocked storage, cross-window
reads after Settings unmounts, and the silent flag sent to the desktop bridge.
Actual operating-system sound delivery requires a native Electron smoke test;
the isolated browser cannot prove it.

## Departments: dragging bots and naming them in place

Run `node --experimental-strip-types scripts/verify-sidebar-groups.ts`. It
starts a disposable fake-engine server with five bots, puts two of them in a
**Work** department and two in **Home**, and prints the address of the real app
in Advanced mode; add `?mode=simple` to it for Simple mode. Ctrl-C closes both
servers and removes only the fixture data. With `--shots <dir>` it instead
photographs each view below in a headless Chrome with a throwaway profile, from
the page's own drag events, and exits.

1. With no department, Simple's sidebar is unchanged.
2. Drag a bot over the top or bottom quarter of another: a line shows where it
   lands, and dropping saves the order (`PUT /api/bots/order`) for every client.
3. Drag it over the middle of a bot in no department: that row is ringed.
   Dropping shows a new department with both bots and its name field focused,
   "New department" selected. Enter keeps the typed name, or the default when
   it is empty; Escape puts the bots back.
4. Drag a bot over a department's heading to put it at its end, between its
   rows to place it there, and between the rows outside any department to take
   it out. With every bot in a department, a "Remove from department" place
   shows at the top while a bot is dragged.
5. Alt+Up/Down moves the focused row within its list and announces its new
   position. A bot's menu → **Move to department** lists the departments,
   **New department…** and **Remove from department**, for touch and keyboard.
6. A department's ⋯ → **Rename department** edits its name in the heading in
   Simple (Advanced keeps its dialog); **Delete department** says the bots stay.
7. Switch to Advanced: the same departments and order show, and rows drag the
   same way.

`src/lib/sidebar-bot-drop.test.ts` covers where a drop lands,
`src/components/Sidebar.departments.test.ts` the sidebar's wiring, and
`src/components/SidebarSectionHeader.naming.dom.test.ts` the name field. The
headless pictures cannot prove the operating system's own drag image or a drag
between two windows.

## Opening and closing the sidebar

Run `node --experimental-strip-types scripts/verify-sidebar-motion.ts <dir>`.
It starts a disposable fake-engine server with nine bots (three pinned, two in
a **Work** department, two archived), opens the real app in a headless Chrome
with a throwaway profile, and writes to `<dir>`: the sidebar open and as
avatars in daylight and midnight, the Archived section open and an archived
chat opened from it, a frame strip and a 60fps clip of each move (every
animation paused and stepped 1/60 s at a time), and `*-frame-times.json` with
the CPU slowed 4x: rAF frame times, the toggle handler's time, long tasks, and
the layout, style and script cost of each toggle. `--label before` names the
files for a run against an older tree.

What to see: ⌘\ (Ctrl+\ elsewhere) or a drag of the edge moves the chat column
as one slide while the sidebar's edge rides with it; each avatar glides to its
new place without being clipped; names fade where they stood and never reflow;
the avatar column, profile, feedback and section headers sit on the same 40px
centre line open and as avatars. With reduced motion it swaps at once.

`src/components/sidebar-motion.dom.test.ts` checks the shared clock, the
avatar's glide, the clip when opening, the reduced-motion swap and the curve.
Electron's own compositor and a transcript of hundreds of messages were not
part of the headless run.
