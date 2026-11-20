// The built-in send tools as they reach the harness, for the declined-send rule (shared/declined-sends.ts): the
// email and phone servers' tool calls, the bot's Slack tools and message_person. A connected app's send is checked in
// outbound-hold.ts and an engine's approval ask where it is raised.
import { declinedSendRefusal, type SendRow } from "../../shared/declined-sends.ts";
import { EMAIL_INTERNAL_MCP_PATH } from "../email/host.ts";
import { PHONE_INTERNAL_MCP_PATH } from "../phones/rpc.ts";

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** The tool and arguments an internal request runs, when it is one of the built-in send routes. */
export function internalSend(path: string, body: unknown): { tool: string; args: unknown } | null {
  if (!isRecord(body)) return null;
  if (path === EMAIL_INTERNAL_MCP_PATH || path === PHONE_INTERNAL_MCP_PATH) {
    const params = body.method === "tools/call" && isRecord(body.params) ? body.params : null;
    return params && typeof params.name === "string" ? { tool: params.name, args: params.arguments ?? {} } : null;
  }
  const slack = /^\/api\/internal\/slack\/([a-z_]+)$/.exec(path);
  if (slack) return { tool: `slack_${slack[1]!.replace(/^slack_/, "")}`, args: body };
  if (path === "/api/internal/people/message") return { tool: "message_person", args: body };
  return null;
}

/** The refusal for an internal request that would repeat a send the person declined in this chat, or null. */
export function declinedInternalSend(path: string, body: unknown, rows: () => readonly SendRow[]): { status: number; error: string } | null {
  const send = internalSend(path, body);
  const refusal = send ? declinedSendRefusal(rows(), send.tool, send.args) : null;
  return refusal ? { status: 409, error: refusal } : null;
}
