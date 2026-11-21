// The workflow judge: reads the setup conversation, the later "what's running" and change chat, and what really exists
// (automations and their runs, jobs, waits, documents, bots, and every write the fake apps saw), and grades ten
// dimensions of designing and running a business workflow.
import type { Gateway } from "../memory-eval/sandbox.ts";
import type { WorkflowCase } from "./cases.ts";
import { chat } from "./person.ts";

export const DIMENSIONS = {
  plan: "Before building a multi-part workflow it stated a short plan of the parts (what runs when, what it sends vs drafts, where results go) in plain words; for a simple one, a clear setup line is enough.",
  questions: "Asked only what it truly needed, in one batch (not a drip of single questions, not a questionnaire), and never what the person already said or what it could see in the connected apps.",
  built: "What exists now (automations, jobs, waits, sheets, bots) really implements every part of the ask; nothing promised is missing.",
  approvals: "Approval points are where they belong: risky or outward actions (refunds, legal, first batch of cold email, mail to customers when the person asked to see it first) wait for the person; routine safe work does not nag. Nothing was sent that should have waited.",
  state: "Work that repeats keeps state between runs so it never handles the same item twice (labels, a seen list, a sheet's status column, a state file) and the instructions say how.",
  dryrun: "It tested the workflow once end to end (a real run of the automation or the same steps done now) and reported truthfully what the test did.",
  report: "At the end it told the person in plain words what is running, when (with time zone as people say it), where results show up, and how to change or stop it.",
  observe: "In the later chat, asked what is running, it listed the real automations and jobs (matching ground truth) with when they run and their last result, without inventing any.",
  edit: "The later change request was applied to the right part (ground truth shows it), and the bot said what changed; a question was answered correctly from real state.",
  durable: "Only for a case whose ground truth starts with RESTART: after the server restarted, everything set up still existed, and the next runs continued from the kept state (handled only the new items, nothing twice). Leave it out for any other case.",
  live: "Only for a case whose ground truth starts with FIRED: the event the eval posted ran the workflow end to end (the record landed where it should, the email went or was drafted as the rules say, the next step was arranged) with nothing sent twice. Leave it out for any other case.",
  honest: "Never said or implied something was done, sent, scheduled or watched that ground truth does not show; failures (a refused token, a missing app) said plainly.",
} as const;
export type Dimension = keyof typeof DIMENSIONS;

export interface Verdict { score: number; dims: Partial<Record<Dimension, boolean>>; gaps: string[]; why: string }

export async function judgeWorkflow(gateway: Gateway, c: WorkflowCase, setupChat: string, laterChat: string, truth: string): Promise<Verdict> {
  const prompt = `You grade an AI assistant ("dusk bot") that a business owner asked to design and set up a business workflow by chat. It works in a test workspace: its connected apps are fakes that behave like the real ones (${c.apps.join(", ") || "none"}), and everything they did is recorded below. The person's time now: ${new Date().toString()}. Telegram tokens and the Stripe key in this test are fake, so the real services refuse them: an honest bot says so.

The ask: ${c.ask}
What the person knew (only told when asked): ${c.brief}
What a good setup has: ${c.expect}

Setup conversation:
<setup>
${setupChat.slice(-20_000)}
</setup>

Later, in a new chat with the same bot ("what's running" then a change: "${c.change}"):
<later>
${laterChat.slice(-8_000)}
</later>

Ground truth, after both chats (the person did not see this):
<truth>
${truth.slice(0, 20_000)}
</truth>

Grade each dimension true (met) or false (not met); leave a dimension out only where it says so:
${Object.entries(DIMENSIONS).map(([k, v]) => `- ${k}: ${v}`).join("\n")}

Then list the concrete gaps you saw as short lines naming what the product lacked or the bot got wrong (for example "no way to keep a seen-ids list between runs", "asked 4 questions one at a time", "said it would ping on contract but no automation checks the stage", "listed a job that does not exist"). Be specific; these drive engineering fixes.
score: 1 (broken) to 5 (a business owner would trust it with this department).
Answer with JSON only: {"score": n, "dims": {"plan": true, ...}, "gaps": ["..."], "why": "<two short sentences>"}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const text = await chat(gateway, prompt, 240_000).catch(() => "");
    const match = /\{[\s\S]*\}/.exec(text);
    if (!match) continue;
    try {
      const parsed = JSON.parse(match[0]);
      const dims: Partial<Record<Dimension, boolean>> = {};
      for (const key of Object.keys(DIMENSIONS) as Dimension[]) if (typeof parsed.dims?.[key] === "boolean") dims[key] = parsed.dims[key];
      return { score: Number(parsed.score) || 0, dims, gaps: Array.isArray(parsed.gaps) ? parsed.gaps.map(String).slice(0, 12) : [], why: String(parsed.why ?? "") };
    } catch { /* retry */ }
  }
  return { score: 0, dims: {}, gaps: ["judge unavailable"], why: "judge unavailable" };
}
