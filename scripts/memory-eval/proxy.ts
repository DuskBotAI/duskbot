// A loopback OpenAI-compatible endpoint the sandbox's engine talks to. It records every request, so the eval sees
// exactly what memory reached the model, and either answers itself (echo, script) or passes the call on to the real
// gateway (forward). Replies are plain JSON completions, which the openai-compat driver accepts for streamed turns too.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Gateway } from "./sandbox.ts";

export type ProxyMode = "echo" | "forward" | "script";

/** What one request was for: a chat turn (it carries tools or a system prompt) or a one-shot helper call, named by
 * the step marker its prompt opens with (capture, consolidate, organize, ...). */
export type CallKind = "chat" | string;

export interface Recorded {
  at: number;
  kind: CallKind;
  model: string;
  system: string;
  /** The last user message's text: the turn's message with whatever the harness put in front of it. */
  user: string;
  /** Every message's text, joined: what the model read in all. */
  chars: number;
  tools: string[];
  /** Tool results the harness sent back in this request, newest last. */
  toolResults: string[];
  usage?: { prompt?: number; completion?: number };
  reply?: string;
  toolCall?: { name: string; args: unknown };
  /** forward mode: the tools the real model called in this reply, a bridged call as use_tool:<name> */
  toolCalls?: string[];
}

function forwardedCalls(calls: unknown): string[] {
  if (!Array.isArray(calls)) return [];
  return calls.map((call) => {
    const name = String(call?.function?.name ?? "");
    let args: { name?: unknown } = {};
    try { args = JSON.parse(String(call?.function?.arguments ?? "{}")) ?? {}; } catch { args = {}; }
    return name.endsWith("use_tool") && typeof args.name === "string" ? `use_tool:${args.name}` : name;
  });
}

/** One scripted tool call: when a chat request's user text contains `trigger` (and no tool result has come back for it
 * yet), the model "calls" the first tool whose name matches `tool`. `bridged` tools go through use_tool. */
export interface ScriptRule {
  trigger: string;
  steps: Array<{ tool: RegExp; args: (tools: string[]) => Record<string, unknown> }>;
  /** The final text once every step ran. */
  reply?: string;
}

type Message = { role: string; content?: unknown; tool_calls?: unknown[]; tool_call_id?: string };

const text = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("");
  return "";
};

const STEP = /You are the ([A-Z][A-Z -]+?) step of a memory system/;

export function callKind(body: { messages?: Message[]; tools?: unknown[] }): CallKind {
  const messages = body.messages ?? [];
  const first = text(messages.find((m) => m.role === "user")?.content);
  const step = STEP.exec(first);
  if (step) return step[1]!.toLowerCase().trim();
  if ((body.tools?.length ?? 0) > 0 || messages.some((m) => m.role === "system")) return "chat";
  return "oneshot";
}

/** A canned answer for a helper call: an empty answer every memory step can parse, else a short title. */
function oneshotAnswer(kind: CallKind): string {
  if (kind === "consolidate") return '{"same": [], "replaced": []}';
  if (kind === "chat" || kind === "oneshot") return "Chat";
  return "[]";
}

const completion = (model: string, message: Record<string, unknown>, finish: string) => ({
  id: `eval-${Date.now()}`,
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }],
  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
});

export interface Proxy {
  url: string;
  mode: ProxyMode;
  setMode(mode: ProxyMode): void;
  records: Recorded[];
  /** Rules for script mode, tried in order; a rule is used once per turn's user text. */
  script: ScriptRule[];
  /** Calls and tokens per kind, for the cost report. */
  totals(): Record<string, { calls: number; prompt: number; completion: number }>;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startProxy(opts: { mode: ProxyMode; gateway?: Gateway; port: number; models?: string[] }): Promise<Proxy> {
  const records: Recorded[] = [];
  const script: ScriptRule[] = [];
  let mode = opts.mode;

  async function forward(body: Record<string, unknown>): Promise<{ status: number; json: any }> {
    if (!opts.gateway) throw new Error("forward mode needs a gateway");
    let last: { status: number; json: any } = { status: 502, json: { error: { message: "gateway unreachable" } } };
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`${opts.gateway.url}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.gateway.key}` },
        body: JSON.stringify({ ...body, model: opts.gateway.model, stream: false, stream_options: undefined }),
        signal: AbortSignal.timeout(240_000),
      }).catch(() => null);
      if (!res) continue;
      const json = await res.json().catch(() => null);
      last = { status: res.status, json: json ?? { error: { message: "unparsable gateway reply" } } };
      if (res.ok && json?.choices?.length) return last;
      if (res.status < 500 && res.status !== 429) return last;
      await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
    }
    return last;
  }

  function scripted(rec: Recorded, messages: Message[]): { message: Record<string, unknown>; finish: string } {
    const rule = script.find((r) => rec.user.includes(r.trigger));
    if (!rule) return { message: { content: "ok" }, finish: "stop" };
    // the steps already taken in this turn are the assistant tool calls since the last user message
    const lastUser = messages.map((m) => m.role).lastIndexOf("user");
    const done = messages.slice(lastUser + 1).filter((m) => m.role === "assistant" && m.tool_calls?.length).length;
    const step = rule.steps[done];
    if (!step) return { message: { content: rule.reply ?? "Done." }, finish: "stop" };
    const direct = rec.tools.find((name) => step.tool.test(name));
    const args = step.args(rec.tools);
    let name = direct;
    let callArgs: Record<string, unknown> = args;
    if (!direct && rec.tools.includes("use_tool")) {
      name = "use_tool";
      callArgs = { name: String(step.tool.source).replace(/[\\^$]/g, ""), arguments: args };
    }
    if (!name) return { message: { content: `(no tool matching ${step.tool} was offered)` }, finish: "stop" };
    rec.toolCall = { name, args: callArgs };
    return {
      message: { content: null, tool_calls: [{ id: `call_${records.length}_${done}`, type: "function", function: { name, arguments: JSON.stringify(callArgs) } }] },
      finish: "tool_calls",
    };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    const path = (req.url ?? "").replace(/\?.*$/, "");
    if (req.method === "GET" && path.endsWith("/models")) {
      send(200, { object: "list", data: (opts.models ?? [opts.gateway?.model ?? "eval-model"]).map((id) => ({ id, object: "model" })) });
      return;
    }
    if (req.method !== "POST" || !path.endsWith("/chat/completions")) {
      send(404, { error: { message: "not here" } });
      return;
    }
    const body = JSON.parse(await readBody(req)) as { model?: string; messages?: Message[]; tools?: Array<{ function?: { name?: string } }> };
    const messages = body.messages ?? [];
    const kind = callKind(body);
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const lastUserAt = messages.lastIndexOf(lastUser as Message);
    const rec: Recorded = {
      at: Date.now(),
      kind,
      model: body.model ?? "",
      system: messages.filter((m) => m.role === "system").map((m) => text(m.content)).join("\n"),
      user: text(lastUser?.content),
      chars: messages.reduce((sum, m) => sum + text(m.content).length, 0),
      tools: (body.tools ?? []).map((t) => t.function?.name ?? "").filter(Boolean),
      toolResults: messages.slice(lastUserAt + 1).filter((m) => m.role === "tool").map((m) => text(m.content)),
    };
    records.push(rec);
    if (mode === "forward") {
      const { status, json } = await forward(body as Record<string, unknown>);
      rec.usage = { prompt: json?.usage?.prompt_tokens, completion: json?.usage?.completion_tokens };
      rec.reply = text(json?.choices?.[0]?.message?.content);
      rec.toolCalls = forwardedCalls(json?.choices?.[0]?.message?.tool_calls);
      send(status, json);
      return;
    }
    const model = body.model ?? "eval-model";
    if (kind !== "chat") {
      rec.reply = oneshotAnswer(kind);
      send(200, completion(model, { content: rec.reply }, "stop"));
      return;
    }
    const { message, finish } = mode === "script" ? scripted(rec, messages) : { message: { content: "ok" }, finish: "stop" };
    rec.reply = typeof message.content === "string" ? message.content : "";
    send(200, completion(model, message, finish));
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: (error as Error).message } }));
    });
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(opts.port, "127.0.0.1", () => resolve()));
  return {
    url: `http://127.0.0.1:${opts.port}/v1`,
    get mode() { return mode; },
    setMode(next) { mode = next; },
    records,
    script,
    totals() {
      const out: Record<string, { calls: number; prompt: number; completion: number }> = {};
      for (const rec of records) {
        const row = (out[rec.kind] ??= { calls: 0, prompt: 0, completion: 0 });
        row.calls += 1;
        row.prompt += rec.usage?.prompt ?? 0;
        row.completion += rec.usage?.completion ?? 0;
      }
      return out;
    },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
