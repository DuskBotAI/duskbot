// What the behaviour eval's judge sees of a turn and how it rules on it; run.ts judges live, rejudge.ts again from saved
// transcripts, so every build in a comparison is ruled on by the same words.
import { gatewayFromEnv } from "../memory-eval/sandbox.ts";
import type { Case } from "./cases.ts";

export type Message = { id: string; role: string; kind?: string; text?: string; tool?: { name?: string; input?: string }; attachments?: Array<{ name?: string; mime?: string }>; document?: unknown };

/** what the person saw in one bot row: its words, plus the files and cards it carried, named for the judge */
export function rowText(m: Message): string {
  if (m.kind === "activity" || m.kind === "digest") return "";
  // an app card runs live in the chat; its text is only the fallback for a client that cannot show it
  if (m.kind === "app") return "[interactive app, shown working in the chat]";
  const parts = [m.text?.trim() ?? ""];
  for (const file of m.attachments ?? []) parts.push(`[file card: ${file.name ?? "file"}]`);
  if (m.document) parts.push("[document card]");
  if (m.kind && m.kind !== "text") parts.push(`[${m.kind} card]`);
  return parts.filter(Boolean).join(" ");
}

const SETUP = {
  off: "The bot runs in a test workspace: it has no connected email, social, calendar or file access, only its own memory, automations and bot-setup tools.",
  auto: "The bot runs in a test workspace with no connected apps and no computer or browser set up yet (asking for one with select_computer says what is missing). It has: automations (trigger: schedules, app events, webhooks), waits that tell the person when a page or file changes (wait_until), background jobs on builds that have them (background_job), reading web pages (read_pages), a data tool that makes csv and xlsx files (data_*), documents (create_document), interactive pages in the chat or published (show_html, publish_page), memory, credentials (request_credential), teammates and bot setup.",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function judge(model: string, item: Case, output: string, tools: string[]): Promise<{ pass: boolean; why: string }> {
  const gateway = gatewayFromEnv(model);
  const prompt = `You grade one reply of a personal assistant bot. The person asked:\n<ask>\n${item.say}\n</ask>\nEverything the bot showed the person, in order:\n<output>\n${output || "(nothing)"}\n</output>\nThe tools it called in this turn, in order (use_tool:<name> runs <name>; trigger creates or changes automations (+check: with a plain change check, no AI until something changed), trigger_info reads them, memory_update saves notes, create_bot makes a bot): ${tools.join(", ") || "none"}.\n${SETUP[item.place ?? "off"]}\nPass condition: ${item.pass}\nAlso fail it if the output only announces or describes what the bot will do next without the result, or ends mid-task.\nAnswer with JSON only: {"pass": true|false, "why": "<one short sentence>"}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${gateway.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${gateway.key}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0 }),
      signal: AbortSignal.timeout(120_000),
    }).catch(() => null);
    const json = await res?.json().catch(() => null) as { choices?: Array<{ message?: { content?: string } }> } | null;
    const text = json?.choices?.[0]?.message?.content ?? "";
    const match = /\{[\s\S]*\}/.exec(text);
    if (match) { try { const parsed = JSON.parse(match[0]); return { pass: parsed.pass === true, why: String(parsed.why ?? "") }; } catch { await sleep(1_000); } }
    await sleep(3_000 * (attempt + 1));
  }
  return { pass: false, why: "judge unavailable" };
}

/** the tools a saved turn called, from its activity rows, a bridged call as use_tool:<name> */
export function toolsOf(messages: Message[]): string[] {
  return messages.filter((m) => m.kind === "activity" && m.tool?.name).map((m) => {
    const name = m.tool!.name!;
    // a schedule with a plain change check runs no AI until something changed: the judge needs to tell it apart
    const checked = /"check"\s*:\s*\{/.test(m.tool!.input ?? "") ? "+check" : "";
    if (!name.endsWith("use_tool")) return name + checked;
    try { const inner = JSON.parse(m.tool!.input ?? "{}").name; return typeof inner === "string" ? `use_tool:${inner}${checked}` : name; } catch { return name; }
  });
}
