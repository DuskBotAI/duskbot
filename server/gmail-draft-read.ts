// Reads a saved Gmail draft through the connected-apps relay before it is sent by id, so the review card shows the
// recipients, subject and text that will go out.
import { draftReviewOf, type EmailReview } from "../shared/email-review.ts";

/** One MCP request through the relay, answered as Composio answers it: JSON or an event stream. */
export type RelayCall = (payload: Record<string, unknown>) => Promise<{ bytes: Uint8Array; contentType: string }>;

function rpcResult(text: string): unknown {
  const lines = text.includes("data:") ? text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()) : [text];
  for (const line of lines.reverse()) {
    try {
      const parsed = JSON.parse(line) as { result?: unknown };
      if (parsed && typeof parsed === "object" && "result" in parsed) return parsed.result;
    } catch {}
  }
  return null;
}

/** Each text part of a tool result, read as JSON where it is JSON. */
function contentValues(result: unknown): unknown[] {
  const content = result && typeof result === "object" ? (result as { content?: unknown }).content : undefined;
  if (!Array.isArray(content)) return [result];
  return content.flatMap((part) => {
    const text = part && typeof part === "object" ? (part as { text?: unknown }).text : undefined;
    if (typeof text !== "string") return [];
    try { return [JSON.parse(text)]; } catch { return [text]; }
  });
}

export async function readGmailDraft(relay: RelayCall, draftId: string): Promise<EmailReview | null> {
  const answer = await relay({
    jsonrpc: "2.0", id: `draft-${draftId}`, method: "tools/call",
    params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: "GMAIL_GET_DRAFT", arguments: { user_id: "me", draft_id: draftId, format: "full" } }] } },
  });
  const result = rpcResult(new TextDecoder().decode(answer.bytes));
  if (!result || (result as { isError?: unknown }).isError === true) return null;
  for (const value of contentValues(result)) {
    const review = draftReviewOf(value);
    if (review) return review;
  }
  return null;
}
