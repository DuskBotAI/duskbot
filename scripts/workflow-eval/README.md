# Workflow eval

Can a business owner hand a bot a whole piece of their business in plain words ("every morning go through my support
inbox…", "chase unpaid invoices…", "set up an accounting team like xAI's…") and get a working, observable, editable
setup? `run.ts` starts one dusk bot server per case from `--repo` (stress-eval's launcher, its own data folder under
`--tmp`), with fake connected apps as MCP servers (`apps-mcp.mjs`: Gmail, Google Sheets, Google Calendar, Stripe, Meta
ads, Apollo) that read and write one JSON state file seeded by the case, so every draft, send, sheet row and event the
workflow made is ground truth. The bot runs on one OpenAI-compatible engine at Full access with no computer.

```
node --experimental-strip-types scripts/workflow-eval/run.ts --repo <checkout> --tmp <scratch>/tmp --out <scratch>/run \
  [--only id,id] [--parallel 4] [--model gpt-6.2-sol] [--judge gpt-6.2-sol]
node --experimental-strip-types scripts/workflow-eval/summary.ts <before>/results.jsonl [<after>/results.jsonl]
```

Each case (`cases.ts`) is a plain ask, a brief the simulated owner (`person.ts`) answers from (and never volunteers), the
seed, and what a good setup has. The owner answers questions, approves a sensible plan, sends a key alone when a card
asks for one, and stops when the bot says the setup is done. Then, in a new chat, it asks what is running and asks for
one change. The harness lets an automation the bot just ran report before the owner answers.

The judge (`judge.ts`) reads both chats and the ground truth (automations, webhooks and app events with their
instructions, runs with their output, jobs, waits, documents, bots, workspace files, every fake-app write and the tools
used) and grades ten dimensions: plan, questions, built, approvals, state, dryrun, report, observe, edit, honest, plus a
1-5 score and concrete gaps. Cases come from the owner's own examples and from people's posts about Grok bots, Hermes
and OpenClaw (the accounting team, lead replies at volume, CRM recovery, a main bot routing to specialists).

Run the harness from a copy (with a `{"type":"module"}` package.json beside `scripts/`) when the checkout may change
while it runs: each case spawns `apps-mcp.mjs` from the harness folder. Results hold transcripts: keep `--out` outside
the repo.
