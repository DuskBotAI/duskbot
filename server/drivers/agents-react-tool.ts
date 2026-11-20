import { BOT_REACTIONS } from "../../shared/reactions.ts";
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";

export const REACT_TOOL = "react";
const BOT_REACT_PATH = "/api/internal/react";

export async function callReactTool(args: Record<string, unknown>, context: ToolCallContext): Promise<ToolCallResult> {
  const { ok, body } = await context.client.apiResponse(BOT_REACT_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ emoji: args.emoji, ...(args.message_id !== undefined ? { message_id: args.message_id } : {}) }),
  });
  return ok ? { text: String(body.text ?? "") } : { text: String(body.error ?? "The reaction did not go through."), isError: true };
}

export const REACT_TOOL_DEFINITION = {
  name: REACT_TOOL,
  description:
    "React with one emoji to the person's latest message, as a person would. Sparingly, only when it fits (thanks, good news, a joke), never instead of a reply, at most once per message; a new emoji replaces yours.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      emoji: { type: "string", enum: [...BOT_REACTIONS] },
      message_id: { type: "string", description: "Only for an earlier message of theirs in this chat." },
    },
    required: ["emoji"],
  },
};
