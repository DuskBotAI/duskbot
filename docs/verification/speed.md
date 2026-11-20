# Speed: start, replies, chat UI and API routes

How long dusk bot takes from process start to a usable chat, and from a send to the first visible text, hop by hop, on
disposable fake-engine fixtures. Measured 2026-11-19 on an Apple M5 Pro (18 cores, 48 GB), Node 26.7, Chrome for Testing
headless, with other agents' fixtures running on the same machine (numbers move a few ms between runs).

## Running it

```sh
pnpm build && pnpm build:server
node --experimental-strip-types scripts/bench-speed.ts --only start,reply --runs 5 --replies 8
node --experimental-strip-types scripts/bench-speed.ts --only reply --cold --replies 8     # each send opens a new chat
node --experimental-strip-types scripts/bench-speed.ts --only writes --bots 100
node --experimental-strip-types scripts/bench-speed.ts --only ui --bots 50 --playwright PATH/TO/playwright/index.mjs
node --experimental-strip-types scripts/bench-desktop.ts --only server,start,big --chrome PATH/TO/CHROME
```

`bench-speed.ts` runs the packaged server entry (`dist-server/desktop-entry.mjs` with its compile cache) except for the
`ui` phase, which needs the TypeScript server: a built server never lets a local browser in without a sign-in. Each
fixture has its own temporary data folder and ports. The fake engine is wrapped so it stamps when it was spawned, when it
read the turn's prompt and when it wrote its first text, on the wall clock the bench also reads, which splits a reply
into harness time before the engine, engine time, and delivery to `/api/events`. `--cpu-prof DIR` writes a V8 profile of
the first fresh start and the first restart (or of the reply fixture with `--only reply`). `bench-desktop.ts` covers the
renderer: page load, chat switches, scrolling, streaming and the big workspace (150 bots, 300 threads, a 2,000-message
chat).

The bench talks to the server through `node:http`. Node 26's `fetch` (undici) on a reused keep-alive connection here
sometimes held a request 0.2-2 s before the server saw it (the server answered fresh connections in 1-4 ms the whole
time, and a `node:http` keep-alive agent showed no delay); an earlier version of the bench reported those stalls as
reply latency.

## Results

| area | measure | before | after |
|---|---|---|---|
| server start | spawn -> `/api/health`, restart (packaged entry, compile cache) | 284 ms | no change made |
| server start | spawn -> `/api/health`, first start ever (waits for the first engine read) | 812 ms | no change made |
| reply, warm chat | send -> prompt written to the engine (harness overhead) | 8 ms | no change made |
| reply, warm chat | engine's first text -> frame on `/api/events` | 11 ms | no change made |
| reply, warm chat | send -> first text frame | 18.8 ms | no change made |
| reply, new chat | send -> engine spawned | 61 ms | no change made |
| reply, new chat | send -> first text frame (fake engine) | 120 ms | no change made |
| UI | navigation -> sidebar with 50 bots | 249 ms | no change made |
| UI | navigation -> composer visible | 262 ms | no change made |
| UI | switch chat -> that bot's composer | 38 ms | no change made |
| UI | open a 200-message chat -> last message shown | 66 ms | no change made |
| UI (big workspace) | first load to a useful page | 247 ms | no change made |
| UI (big workspace) | scroll a 2,000-message chat back to the top: longest task | 412 ms | no change made |
| API | `POST /api/bots/:id/read`, 100 bots | 5.9 ms | 2.2 ms |
| API | `POST /api/bots/:id/read`, big workspace | 32.7 ms (135 kB written, 1 fsync) | 23.0 ms (nothing written) |

## What changed

| commit | change | measured |
|---|---|---|
| read marker | marking a chat read (`unread`, `lastReadMessageId`) is a bookkeeping save, written within a second, at shutdown and before a backup, instead of a whole `bots.json` rewrite and fsync on the request | 5.9 -> 2.2 ms at 100 bots; 32.7 -> 23.0 ms and 135 kB + 1 fsync -> nothing written on the big workspace |

## Measured and left alone

- Harness time before the engine is 8 ms on a warm chat and about 60 ms on a chat's first message, both under the
  150 ms target; delivery from the engine's first text to the live stream is 11-21 ms, under the 100 ms target.
- A chat's first message writes `bots.json` three or four times before the engine starts (the turn's start, the folder
  pin, which engine has the conversation); each is a durability point for recovery after a crash, so they stay.
- The agents MCP server answers `initialize` and `tools/list` 59 ms after spawn with or without Node's compile cache.
- `/api/bots?messages=0` is about 0.9 kB per bot (1.4 kB in the big workspace), most of it the bot's threads.
- Lifting Chromium's six-connections-per-host cap for `127.0.0.1` changed nothing on the page's start-up burst: the
  requests wait on the server, not on connections.
- A restart spends its 284 ms spread over module evaluation, the data-folder lease, session restore and config parsing;
  no one piece is over 20 ms.

## Next, not done here

- A chat's first message (and the first after ten idle minutes) starts the engine's process: with a real Claude Code
  that is its own start-up plus its MCP servers, which the fake engine does not have. Starting that process when a person
  opens a chat or starts typing would hide it, but the warm process must match the turn's launch contract (system prompt,
  MCP mounts, model), which today is built inside the turn's setup.
- Scrolling a 2,000-message chat back to its start mounts 1,000 rows and 70,000 DOM nodes; the longest task (412 ms) is
  one older page landing. Mounting a landed page in steps, as an opened chat's first paint already does, or windowing
  the rows above the viewport, would cut it.

## Real engines through the local gateway

`scripts/bench-engines.ts` runs the packaged server on its own data folder with each real engine pointed at the local
gateway (`127.0.0.1:8317`) through a timing proxy, every engine on `gpt-6.2-sol` (Claude Code's requests are answered by
it too: the gateway's Claude sign-in was not usable), and each engine CLI wrapped to stamp its own hops. Cold = a new
chat's first message (the engine process starts), warm = the next messages in the same chat. Quick questions
("What is 18% of 2,450?", "Is 91 a prime number?"), 5 runs each plus the new chat's first; medians in seconds after
send, measured 2026-11-20 on the M5 Pro.

```sh
pnpm build:server
node --experimental-strip-types scripts/bench-engines.ts --runs 5 --trace --json out.ndjson
node --experimental-strip-types scripts/bench-engines.ts --engines claude --mode warm --effort low   # pin an effort
node --experimental-strip-types scripts/bench-engines.ts --set work --mode warm                     # acks on work asks
```

| engine | turn | first model request | first words (bubble) | done, before -> after |
|---|---|---|---|---|
| Claude Code 2.1.314 | cold | 0.89 -> 0.60 | 3.73 -> 4.08 | 4.16 -> 4.72 |
| Claude Code 2.1.314 | warm | 0.02 -> 0.03 | 6.53 -> 3.48 (gateway, see below) | 7.00 -> 4.53 |
| Codex 0.170 | cold | 0.17 -> 0.20 | 2.79 -> 9.49 | 3.08 -> 10.76 |
| Codex 0.170 | warm | 0.03 -> 0.02 | 3.23 -> 3.67 | 3.47 -> 3.99 |
| Grok Build 1.0.44 | cold | 0.46 -> 0.48 | 3.84 -> 4.32 | 4.39 -> 5.15 |
| Grok Build 1.0.44 | warm | 0.06 -> 0.06 | 4.48 -> 7.05 | 5.29 -> 9.76 |
| OpenCode 1.19.3 | cold | 1.30 -> 0.53 | 7.08 -> 5.05 | 7.30 -> 5.62 |
| OpenCode 1.19.3 | warm | 0.03 | 4.33 -> 4.01 | 4.56 -> 5.06 |
| openai-compat | cold | 0.02 -> 0.02 | 3.32 -> 3.16 | 3.32 -> 3.32 |
| openai-compat | warm | 0.02 -> 0.01 | 7.29 -> 4.01 | 7.29 -> 4.01 |

Only Claude Code changed between the two runs, and every move here is the gateway, Claude Code's too (the same Codex turn took 2.7 s in one
run and 9.4 s in the next). The model's own time to first text is 1.8-2.5 s for `gpt-6.2-sol` even on a 2 kB prompt
and grows by about 0.5-1 s at the 100-120 kB a turn sends; reasoning effort changed nothing on its responses
API. Everything before the model is small: the server answers the send in under 20 ms, a warm engine sends its request
15-60 ms after the send, and the bubble shows 50 ms after the engine's first text.

| commit | change | measured |
|---|---|---|
| quick questions run at low effort | Claude Code sent `effort: high` with adaptive thinking on every turn; a default bot's short question with no picked effort now runs at low effort, set on the live process (`apply_flag_settings`, 2.1.288+) so it keeps the warm process and its cache | no gain measurable on `gpt-6.2-sol`: interleaved on one process (6 quick questions each, same minutes) first text is 3.45 s at high, 3.54 s at low and 3.33 s with thinking off (`set_max_thinking_tokens` 0). The 6.53 -> 3.48 s above was the gateway between runs. Switching effort between turns costs nothing measurable (first model request 30-60 ms on a warm process, quick and work asks alternating) |

Work asks ("Look up today's weather in Tokyo and Paris...", `--set work --mode warm`, 5 runs, the same build): the
first message is the engine's own opening line on Claude Code (4.4 s) and Codex (3.0 s); on the openai-compat path it
is the harness's ack, written by 2.7 s but held to 7.0 s, because that path never reports reasoning and the ack waits
for a tool to start or for the engine to show it is thinking (`server/turn-beats.ts`). Results land at 21.3 s (Claude
Code), 18.0 s (Codex) and 22.9 s (openai-compat), each after 4 model calls.

### Where the rest goes

- **Engine start on a new chat (or after 10 idle minutes):** send -> first model request is 0.6-0.9 s for Claude
  Code (binary load about 0.3 s, its own start 0.22 s, MCP servers connect in the background in 50-100 ms), 0.45 s for
  Grok Build, 0.5-1.3 s for OpenCode (its `initialize` 0.48 s and `session/new` 0.77 s), 0.17 s for Codex and nothing
  for the openai-compat path. Starting the engine when the person starts typing would hide it.
- **Prompt size:** 100-120 kB per turn on the CLI engines (about 25-29k tokens: system prompt and tool schemas), 65 kB
  on openai-compat. Codex reads 20.8k of 21k tokens from the cache on a warm turn.
- **Model round trips:** a reminder on the openai-compat path took 4 model calls (about 20k tokens each, 83k in all,
  11-21 s): a `find_tool` detour, `trigger_info` first (the trigger tool's description asks for it on relative dates,
  though the turn's clock line has the time and zone) and a re-read after create. The detour exists only because a
  gateway on 127.0.0.1 counts as a local model, which turns the tool bridge on; a hosted API lists every tool.
- **Acks on the openai-compat path:** posting a work ask's ready ack at `ACK_IDLE_MS` (4 s) without the thinking
  signal would bring its first message from 7.0 s to about 4 s, near Grok's 3 s.
- **Cloud and phone:** not run here (no cloud test account in this session). A suspended dusk cloud resumes in about
  2.4 s plus the home's own answer (`apps/cloud-service/src/instabox.ts`), and the app's focus ping never wakes it, so the first send after a sleep waits for that;
  a warm request to the relay from this Mac is 0.22-0.26 s (TLS connect 0.4-0.6 s), so the phone adds about 0.5 s
  (the send up, the first frame down) to the numbers above.
