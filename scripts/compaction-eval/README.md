# Compaction eval

Does a long chat keep its thread once dusk bot folds it? `run.ts` imports `server/compaction-summary.ts` and
`server/context-rebuild.ts` from `--repo` and folds a synthetic 42-turn chat (`conversation.ts`) twice, as
`compactConversation` does:

- the first fold comes before turn 27;
- the second comes after the last turn.

Each fold keeps the two latest exchanges. The person states facts in the first 12 turns, and a six-step task runs
across both folds with side questions in between. Some tool results exist only in the folded part. The answering
model then gets the rebuilt replay plus one new message. It has `send_email`, `read_file` (which serves only the
fold's archive folder) and an offline `run_command`.

```
node --experimental-strip-types scripts/compaction-eval/run.ts --repo /path/to/checkout --label after [--reps 5] [--model gpt-6.2-sol] [--full]
```

- **Recall:** 14 questions, scored by matching the expected answer in the reply. There are 11 facts from the first 12
  turns, 2 from the middle of the task and 1 tool result that only the archive file holds.
- **Continuation:**
  - "OK, carry on with the next step": it must act on step 4, validating the mapping with the vendor contact.
  - "Now do step 5": it must draft the driver notice, keeping the person's 40-word and DD/MM/YYYY rules.

  Judged by the same model.
- **Model:** the summary helper and the answering model are both `--model` on the gateway. The helper's timeout is
  150 s, not the product's 20 s. `--full` sends the whole chat without folding, as a ceiling.

## Results, 2026-11-20 (gpt-6.2-sol, 5 runs each)

Before: dev at `2278c6cc53`. After: the checkpoint commit.

| | before | after | no fold |
| --- | --- | --- | --- |
| early facts recalled | 55/55 | 55/55 | 11/11 |
| facts from the middle of the task | 10/10 | 10/10 | 2/2 |
| tool result held only in the folded part | 0/5 | 5/5 | 0/1 |
| task continuation (both asks) | 3/10 | 10/10 | 2/2 |
| "carry on with the next step" | 1/5 | 5/5 | 1/1 |
| "now do step 5" | 2/5 | 5/5 | 1/1 |

The plain facts survive either summary on this model, so recall shows no gain here; a smaller helper model has not
been measured. The old summary cut its 2,600-byte model part through the middle. That lost the six-step list and the
zone map, so the bot asked "what is step 5?" or stopped for a file it could not read. The second fold also took
20 to 24 s on the old prompt, past the product's 20 s helper timeout, against about 16 s on the new one. Raw replies and
summaries are in `results/`.
