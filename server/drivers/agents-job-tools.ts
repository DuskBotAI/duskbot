import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

export const JOB_TOOL = "background_job";

export async function callJobTool(args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const { ok, body } = await context.client.apiResponse("/api/internal/jobs", { method: "POST", body: JSON.stringify(args) });
  return ok ? { text: String(body.text ?? "") } : { text: String(body.error ?? "The background job did not go through. Try again shortly."), isError: true };
}

export const JOB_TOOL_DEFINITION = {
  name: JOB_TOOL,
  // Rides every turn: the start answer carries the rest (dusk-notify, the Telegram fixes).
  description:
    "Your program that keeps running after this turn (a chat poller, a watcher); its dusk-notify \"<text>\" wakes you. start: template telegram_watch (secret: Vault label of the bot token; optional chats, keywords) or command; secrets: ENV_NAME to Vault label. logs, stop: id.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["start", "list", "logs", "stop"] },
      id: { type: "string" },
      label: { type: "string", maxLength: 80 },
      template: { type: "string", enum: ["telegram_watch"] },
      secret: { type: "string" },
      chats: { type: "array", items: { type: "string" } },
      keywords: { type: "array", items: { type: "string" } },
      command: { type: "string", description: "One shell line, e.g. python3 watch.py." },
      cwd: { type: "string" },
      env: { type: "object", additionalProperties: { type: "string" } },
      secrets: { type: "object", additionalProperties: { type: "string" } },
      on_notify: { type: "string", maxLength: 2000, description: "What to do when woken; that run won't see this chat. Use only what a wake carries (telegram_watch: chat, sender, time, id, text). Alert them on Telegram or Discord with chat_app_bots send." },
      bytes: { type: "integer", minimum: 200, maximum: 16000 },
    },
    required: ["action"],
  },
};
