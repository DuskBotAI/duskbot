// The simulated business owner: answers the bot from the case brief only, approves a sensible plan, and says when the
// setup conversation is over. One gateway call per turn.
import type { Gateway } from "../memory-eval/sandbox.ts";
import type { WorkflowCase } from "./cases.ts";

export const DONE = "<<DONE>>";

export async function chat(gateway: Gateway, prompt: string, timeoutMs = 180_000): Promise<string> {
  let last = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(`${gateway.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${gateway.key}` },
      body: JSON.stringify({ model: gateway.model, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(() => null);
    const json = await res?.json().catch(() => null) as { choices?: Array<{ message?: { content?: string } }> } | null;
    const text = json?.choices?.[0]?.message?.content?.trim();
    if (text) return text;
    last = `${res?.status ?? "no response"} ${JSON.stringify(json)?.slice(0, 200)}`;
    await new Promise((r) => setTimeout(r, 10_000 * (attempt + 1)));
  }
  throw new Error(`gateway gave no answer: ${last}`);
}

export async function personReply(gateway: Gateway, c: WorkflowCase, transcript: string): Promise<string> {
  const prompt = `You play a busy small-business owner talking to your AI assistant ("dusk bot") in a chat app. You asked it to set up a workflow. Stay in character.

What you know (answer from this only when asked; never volunteer it all at once; if asked something not covered, give a quick plausible answer or say "you decide"):
<brief>${c.brief}</brief>

The chat so far:
<chat>
${transcript.slice(-12_000)}
</chat>

Write your next message, as you would type it: short, casual, no pleasantries.
- If the bot asked questions, answer them.
- If it proposed a plan and asked to go ahead, approve it (correct anything that contradicts your brief).
- If it shows something for your approval (a batch of emails, a top-5 list), approve it unless it clearly contradicts your brief.
- If it asks you to connect an app that your brief says is connected, say it's already connected.
- If it asks for a key or token your brief gives you (a secure card counts), send that key alone as your whole message; you cannot fill in cards here. If your brief has none, say you don't have one.
- If it says the setup is finished and running and asks nothing more, or it keeps asking nothing new, reply exactly ${DONE}.
- If it seems stuck, only narrated what it will do, or stopped halfway, nudge once ("go ahead and set it up").
- Once you have pasted a link or code it gave you into another app, take it as working: never make up errors, status codes or results from that app.
Reply with the message text only.`;
  return chat(gateway, prompt, 120_000);
}
