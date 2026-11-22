import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

export const MESSENGER_TOOL = "chat_app_bots";
export const MESSENGER_TOOL_PATH = "/api/internal/messengers";

export async function callMessengerTool(_name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const { ok, body } = await context.client.apiResponse(MESSENGER_TOOL_PATH, { method: "POST", body: JSON.stringify(args) });
  return ok ? { text: String(body.text ?? "Done.") } : { text: String(body.error ?? "That didn't work. Try again shortly."), isError: true };
}

export const MESSENGER_TOOL_DEFINITION = {
  name: MESSENGER_TOOL,
  description: "Telegram and Discord bot accounts for this bot, set up from a BotFather or Discord bot token the person pasted. status: what is connected, who may reach it, who was turned away. connect: link that token (leave token out; dusk bot takes it from what the person pasted). allow / remove_access: a person or group by name from status, or by id. disconnect: stop using that Telegram or Discord bot. send: text to the person's own chat with it once claimed; automations and job wake-ups alert them with it.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["status", "connect", "allow", "remove_access", "disconnect", "send"] },
      platform: { type: "string", enum: ["telegram", "discord"] },
      who: { type: "string", maxLength: 200, description: "allow / remove_access: a name from status, or a numeric id." },
      text: { type: "string", maxLength: 4000, description: "send: the message." },
    },
    required: ["action"],
  },
};
