# Stress eval

Many realistic conversations, judged. `run.ts` starts real dusk bot servers from `--repo` (each with its own data
folder under `--tmp` and a port pair in 8900-8999, never `~/.duskbot`), gives each conversation a new bot on one
OpenAI-compatible engine pointed at the gateway (streaming, as the app runs it), and talks to it through the app's
HTTP routes and live event stream (`/api/events`). Several conversations run at once on each server and several
servers run at once; a server is replaced after `--recycle` conversations.

```
python3 scripts/stress-eval/fixtures.py <fixtures>      # receipt, whiteboard, chart, invoice, CV, three CSVs
node --experimental-strip-types scripts/stress-eval/run.ts --tmp <scratch>/tmp --out <scratch>/run1 --fixtures <fixtures> \
  [--model gpt-6.2-sol] [--judge gpt-6.2-sol] [--repeat 2] [--servers 4] [--parallel 3] [--only id,id]
node --experimental-strip-types scripts/stress-eval/summary.ts <scratch>/run1/results.jsonl
```

`DUSK_MODEL_DIR` may point at a copy of the local embedding model so servers do not download it. The gateway key is
read as the memory eval reads it and is written only into each server's own `config.json` (0600), removed with its
data folder; results hold transcripts, so keep `--out` outside the repo.

- **Scenarios** (`scenarios.ts`): personas (business owner across sales, support, hiring, bookkeeping and marketing;
  an agency monitoring Telegram, WhatsApp and email; student; developer; creator; non-native English; angry; vague;
  typos and dictation; Hindi and Hinglish; Portuguese) times shapes (corrections, interruptions sent while the bot
  works, "make it 3 bullets", follow-ups on earlier files, image/PDF/CSV attachments, memory across new chats,
  routines, monitors, capability questions, the headless browser, harmful-but-benign asks, long jobs).
- **Round two** (`scenarios2.ts`, `--set new`): the top use cases people post about agent bots, business workflows
  (inbox triage, a deals sheet from Telegram, outreach behind approval, weekly report, hiring screen), many asks at
  once, long chats (`--compact-at <tokens>` folds them within a test), routines and watchers the eval makes fire, and
  Telegram as a chat app. A scenario's `live` check happens after the conversation: `page` changes the page it watches,
  `tg-watch` posts in a group of the fake Telegram (`telegram.ts`, any token is its own bot), `tg-chat` pairs with the
  start code the bot gave and asks on Telegram, `webhook` calls the bot's webhook automation; the eval then waits for
  the bot to speak by itself. `--set matrix` is the 60 conversations the engine matrix runs, and `--engine codex`
  (the gateway as Codex's Company endpoint) or `--engine opencode --model opencode/big-pickle` (Zen's free models, no
  key, needs the network) swap the engine; those servers set `DUSK_ALLOW_REAL_ENGINES=1`.
- **Hard checks** (`checks.ts`): every file and document a bot shared opens, web links load, no tool names or step
  traces in chat, no error text or runtime errors, no turn without a reply, no stuck turn, first words within 20 s
  and turns within 120 s.
- **Judge** (`judge.ts`): reads the conversation as the person saw it plus what really happened (tools run,
  automations and waits that exist, memory, check results) and returns a 1-5 score, pass and rubric flags.
