# Suggestions

dusk bot notices what the person is working toward (a job hunt, a move, a launch, a deal), looks out for something new
that helps, and offers one concrete next step they can start with one tap. Code: `server/host/offers.ts`.

## What the person sees

One message in the chat where the goal came up (else the proactive bot's own chat), and a notification (phone push
included) unless that bot's notifications are off:

> There's a design jobs fair in Lisbon on 4 December where studios hiring product designers meet candidates. example.org
>
> Want Scout to prep a shortlist of the studios worth meeting?
>
> **Do it** · Not now · Don't suggest this

- **Do it** sends the work to the bot named, as the person's own request (in the same chat when it is that chat's bot,
  else a new chat of that bot, opened by the proactive bot). The request says to prepare only and to ask before signing
  up, applying, paying, booking or sending anything; the bot's approval level still applies.
- **Not now** rests that goal for 3 days and lowers its weight.
- **Don't suggest this** stops that goal for good.
- An offer left unanswered for 3 days counts once as a skip.

Only the owner or an admin answers (`POST /api/offers/answer`), each offer once.

## Where the goals live

In the proactive bot's memory, topic `memory/interests.md` ("What you're working toward" under What it remembers), one
line each with its weight. The person can edit or delete lines; a line typed by hand counts at weight 1. Do it raises a
goal's weight (up to 3), skips lower it (down to 0.2), and a higher weight means it is looked at more often. Memory upkeep
never rewrites these lines. Runtime state (next pass, search terms, offers sent, links already seen) is `offers.json` in
the data folder.

## What to tell me about

The proactive bot's memory also holds `memory/proactive.md` ("What to tell me about" under What it remembers): lines under
Tell me about, Never tell me about, and one Quiet hours line (`21:30 to 08:00`). Its quiet hours replace the 21:00 to
09:00 above, and a goal or find that names a Never line is not offered. The day watch makes no proactive check in quiet
hours, new frequent routines are shaped to the hours outside them, and every routine run reads the file's lines. Bots
write it with `memory_update` action `notify` (rule tell, never or quiet) from the person's own words; Stop sending me
these on a routine's message pauses that routine and adds its name under Never (`POST /api/proactive/stop`).

## The pass

Every 5 minutes a check in plain code; a pass runs only when it is due (10 minutes after start, then every 6 hours, each
with up to 90 minutes of jitter) and every guard passes:

- Suggestions on (Settings, Notifications, Suggestions; `features.suggestions`), and the proactive bot's own
  Suggestions switch on, with memory on. A bot whose switch is off is never handed work, never posts one, and its chats
  are not read for goals.
- Not between 21:00 and 09:00 in the person's time zone.
- No bot working and nothing written by the person in the last 20 minutes.
- At most `features.suggestionsPerDay` (default 2) a day, and 3 hours apart.
- Never on a Team Cloud or hosted team workspace, nor on a computer whose bots moved to My Cloud.

A pass makes at most two background model calls on the proactive bot's engine (side job `suggestions`), both with no
tools:

1. **Spot**, only when the person wrote something since the last one: reads their recent one-to-one chats and About me
   and updates the goals. A goal stands only on the person's own words, quoted.
2. **Judge**, only when a goal is due and web search (the person's treg key or the plan's research) found links not
   seen before, or a deadline of theirs is within a week: picks at most one find, the bot to prepare the next step, and
   the words. A link must be one the search returned; the bot must be on the roster.

Nothing new, nothing posted. Web content is escaped in the message and reaches the bot doing the work only as
unchecked material.

## Checking a change

```sh
pnpm vitest run server/host/offers.test.ts server/host/offer-interests.test.ts
```

`DUSK_SUGGESTIONS_FAST=1` on a fixture server shortens the timings (15 s ticks, a pass a minute, no boot wait, 30 s idle, offers a minute apart) for a live run.
