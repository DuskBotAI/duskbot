// Port eval for the nightly dream's missed and declined lists: the real prompt and parser over fixed chats, against the
// gateway model, with plain checks on what came back.
//   node --experimental-strip-types scripts/behaviour-eval/port-dream.ts [--model gpt-6.2-sol] [--runs 3]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { dreamNoticedEvidenced, dreamPrompt, parseDream, type DreamConversation } from "../../server/memory-dream.ts";
import { gatewayFromEnv } from "../memory-eval/sandbox.ts";

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: { model: { type: "string", default: "gpt-6.2-sol" }, runs: { type: "string", default: "3" } } });
const model = values.model!;

const chats: DreamConversation[] = [
  { threadId: "a", lines: [
    { by: "person", text: "Can you find me a dentist near Indiranagar that's open on Saturdays?" },
    { by: "bot", text: "Sure, I'll look into it and get back to you." },
    { by: "person", text: "Thanks. Also what's the weather tomorrow?" },
    { by: "bot", text: "Tomorrow in Bangalore: 27°C and sunny." },
  ] },
  { threadId: "b", lines: [
    { by: "person", text: "Summarise the Lumen contract for me." },
    { by: "bot", text: "Here is the summary: 12 months, 30 days notice, net 45 payment." },
    { by: "bot", text: "Want me to send you a summary of every new contract each Monday?" },
    { by: "person", text: "No thanks, I'll ask when I need one." },
  ] },
  { threadId: "c", lines: [
    { by: "person", text: "Draft a reply to Raj about the invoice." },
    { by: "bot", text: "Here's a draft: Hi Raj, the invoice is attached..." },
    { by: "bot", text: "Should I also set up a reminder to check if Raj paid?" },
    { by: "person", text: "Not now." },
    { by: "person", text: "Book a table for two at Toit on Friday, 8pm." },
    { by: "bot", text: "Done: Toit, Friday 8pm, table for two. Confirmation TT-4471." },
  ] },
];

const runs: Array<{ missed: string[]; declined: string[]; checks: Array<[string, boolean]>; raw: string }> = [];
const gateway = gatewayFromEnv(model);
for (let i = 0; i < Number(values.runs); i++) {
  const res = await fetch(`${gateway.url}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${gateway.key}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: dreamPrompt({ botName: "Sage", today: "2026-11-21", conversations: chats, notebook: [] }) }] }),
    signal: AbortSignal.timeout(180_000),
  });
  const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const raw = json.choices?.[0]?.message?.content ?? JSON.stringify(json).slice(0, 500);
  const answer = parseDream(raw, chats.length, 0);
  const missed = answer.missed.filter((item) => dreamNoticedEvidenced(item, chats)).map((item) => item.text);
  const declined = answer.declined.filter((item) => dreamNoticedEvidenced(item, chats)).map((item) => item.text);
  const checks: Array<[string, boolean]> = [
    ["the dentist search is missed", missed.some((text) => /dentist/i.test(text))],
    ["the finished booking is not missed", !missed.some((text) => /toit|table/i.test(text))],
    ["the Monday contract summary is declined", declined.some((text) => /contract|monday|summar/i.test(text))],
    ["\"not now\" is not a refusal", !declined.some((text) => /remind|raj|paid/i.test(text))],
  ];
  runs.push({ missed, declined, checks, raw: raw.slice(0, 2_000) });
  console.log(`run ${i + 1}:`, checks.map(([name, ok]) => `${ok ? "ok" : "MISSING"}: ${name}`).join("; "));
}
mkdirSync(join(here, "results"), { recursive: true });
writeFileSync(join(here, "results", "port-dream.json"), JSON.stringify({ at: new Date().toISOString(), model, runs }, null, 2));
console.log(`${runs.filter((run) => run.checks.every(([, ok]) => ok)).length}/${runs.length} runs passed every check`);
