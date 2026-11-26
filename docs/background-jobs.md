# Background jobs

A bot can run a program of its own that keeps going after its turn ends: a Telegram long-poller, a feed or page
watcher, anything that should watch something and speak up when it matters. The program wakes the bot with
`dusk-notify "<text>"`, and the bot decides what to tell the person. Code: `server/jobs/`.

## What the bot does

One tool, `background_job` (`server/drivers/agents-job-tools.ts`):

| Action | What it does |
|---|---|
| `start` | Starts a job: `template: "telegram_watch"` with `secret` (the Vault label of the bot token) and optional `chats` and `keywords`, or `command` (one shell line run with `sh -c` in `cwd`). `secrets` maps an environment name to a Vault label; `env` sets plain values; `on_notify` is what the bot's run does when woken. A job of the same bot with the same label is replaced. |
| `list` | The bot's jobs and their state. |
| `logs` | The end of a job's output (secrets shown as `[secret]`). |
| `stop` | Stops a job for good. |

Only the person's own turn in a one-to-one chat may start a job; a room, a Cloud guest, another bot's hand-off, a
routine run or an outside event cannot (`jobTurnRefusal`), and none of them may read a job's list or log. At every
approval level but Ask for approval the job starts at once; at Ask the start shows one card, "Keep running <label> in the background" (Allow, Deny): Allow
starts it and the chat says so; the bot is told to end its turn and not ask again. The card's request lives in memory,
so one a restart left open closes at start. A routine run may stop a job. The prompt line is
`backgroundJobsPrompt()` in `server/jobs/prompt.ts`.

Inside a job:

- `dusk-notify "<text>"` (on `PATH`) starts a run of the bot with the bot's `on_notify` instructions and the text as
  untrusted event data, through the same path as a connected-app event (`routines.enqueueWebhook`, `eventSource:
  "job"`): notifications that arrive before the run starts join it. Off a Cloud the run reports in the chat the job was
  started in; on a Cloud, like every outside event, in a chat of its own named after the job. A run with nothing to
  say replies `NOTHING NEW` and posts nothing.
- `dusk-notify --tell "<text>"` posts the text in the chat as is, with no AI.
- Without the helper: `POST $DUSK_JOB_NOTIFY_URL` with `authorization: Bearer $DUSK_JOB_TOKEN` and
  `{ "text": "…", "tell": false }`.
- `DUSK_JOB_DIR` is a folder of its own that survives restarts (a poller's offset).

At most 60 notifications an hour and 4,000 characters each.

## telegram_watch

`server/jobs/telegram-watch.ts`, Node's standard library only: `getMe`, then `getUpdates` long polls (50 s), the offset
kept in `DUSK_JOB_DIR`, each batch of new messages (groups, channels, captions; filtered by chat title or id and by
keyword when given) handed over in bounded notifications. Large batches use multiple notifications; long messages
use numbered parts. The offset advances past matching messages only after their complete text has been accepted.
If delivery fails partway through a long message, that message is retried from its first part. It tells the person, once, with `--tell`:

- privacy mode is on (`can_read_all_group_messages` false): the bot sees only commands and @mentions in groups; the fix
  is BotFather → `/setprivacy` → Disable, then remove and re-add the bot (or make it a group admin);
- another program holds the bot's updates (409: a webhook or a second poller);
- Telegram refuses the token (401): it tells the person and ends, so it is not restarted.

The token comes from the person's Vault (`request_credential`; a token pasted in chat is kept there), read at every
start, never written in the command or the job list.

## Supervision

`JobSupervisor` (`server/jobs/supervisor.ts`) keeps the list in `<data>/jobs.json` and each job's output in
`<data>/job-logs/`.

- **Restarts.** An exit with an error starts the job again after 1 s, doubling to 5 minutes; a run of a minute resets
  that. After 5 failed starts in a row the chat gets one line saying the job keeps stopping. An exit with 0 ends the
  job (`done`).
- **Server restarts.** Every job that was running starts again when the server starts (`restore`); a process an earlier
  server left behind with the same command line is ended first. On shutdown every job's process group is ended.
- **Caps.** 3 jobs per bot, 12 per computer. A job runs at `nice 10`; one whose process group uses more than 1 GB of
  memory, or a whole CPU on average for 5 minutes, is ended and restarted (`ps`, every 30 s). The log keeps the newest
  1 MB plus the 1 MB before it.
- **Secrets.** Values from the Vault are removed from the log and from notifications.

## Where it runs

| Host | How |
|---|---|
| dusk cloud (and any host with the bot box on) | A bot box of its own (`botBox.wrap`, docs/bot-box.md): the same mounts, egress gate, harness gate, seccomp filter and environment allow-list as a turn, with `HOME` at `workspaces/<bot>/.jobs/home` instead of the engines' home, so the engines' sign-ins are not in it. The box outlives the turn's box and dies with the server (`--die-with-parent`). |
| Desktop app (Mac) and own VPS without the box | A plain process group on that computer, with a fresh environment (the shell's names, the job's own, its secrets): never the server's keys. The job stops while the computer sleeps or the app is closed, and starts again with the server. |
| Windows | Not supported: the start says so. |

## Sleep and cost

A dusk cloud sleeps when idle. A job must run around the clock to be any use, so while a job should be running
(including while it waits to restart) the home reports the busy code `job` (`server/cloud-power.ts`) and the Admin never
sleeps it (an unknown or work code holds it awake, `apps/cloud-service/src/power/rails.ts`). The Admin counts that time
as explained awake time (`EXPLAINED_BUSY`), so its operator page shows `job` as the reason a home stays up and its
daily usage and cost rows (`infra_usage_daily`) carry the cost. The person is not shown a cost. If the home is stopped
anyway (the owner pauses it, the cost ceiling), its jobs start again when it wakes.

## Security

- A job runs the bot's own code with what a turn of that bot already has; boxed, it reaches only the internet through
  the egress gate and this server only at `/api/internal/` (the notify route checks the job's own bearer, which is new
  for every start and dies with it).
- What a job sends is treated as outside data: the run it starts is an outside-event run (fenced like an app event's)
  and cannot start or replace jobs, so a message in a watched chat cannot make the bot run new code.
- A Vault secret a job uses stays in its process environment for as long as it runs. Boxed, nothing outside the box
  sees it; unboxed on a Mac, the person's own programs could.
- Known gap: the box's `broker.unbrokered` report lists a job's `*_TOKEN`, `*_KEY` and `*_SECRET` names, since they are
  raw in that box by design.

## Checking a change

```sh
pnpm vitest run server/jobs/ server/jobs.e2e.test.ts
```

`server/jobs/jobs.linux.test.ts` runs only where an unprivileged bubblewrap works (Linux): run it there.
