// The agents catalog's document tools and the internal route behind them (server/routes/bot-documents.ts).
import { DOCUMENT_TITLE_MAX } from "../../shared/documents.ts";
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

const ACTIONS: Readonly<Record<string, "create" | "update" | "list">> = {
  create_document: "create",
  update_document: "update",
  list_documents: "list",
};
export const DOCUMENT_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(ACTIONS));

export async function callDocumentTool(name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const { ok, body } = await context.client.apiResponse("/api/internal/documents", {
    method: "POST",
    body: JSON.stringify({ ...args, action: ACTIONS[name] }),
  });
  return ok ? { text: String(body.text ?? "Done.") } : { text: String(body.error ?? "The document could not be saved. Try again shortly."), isError: true };
}

const DOCUMENT_ID = { type: "string", pattern: "^d_[0-9a-f]{12}$" };
const CONTENT = "All of it: Markdown; for a sheet CSV with a header row; for html one static page, inline CSS.";

export const DOCUMENT_TOOL_DEFINITIONS = [
  {
    name: "create_document",
    description:
      "Save a long structured result (plan, report, draft, a table over ~15 rows) as a document the person can open, edit and download: a file card here, kept in your panel under Files. Then reply in a line or two, never repeating it. Short answers and small tables stay in your message.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", maxLength: DOCUMENT_TITLE_MAX },
        kind: { type: "string", enum: ["markdown", "sheet", "html"] },
        content: { type: "string", description: CONTENT },
        manual: { type: "boolean", description: "The person's standing rules for you or a workflow: you reread it, never change it." },
      },
      required: ["title", "kind", "content"],
    },
  },
  {
    name: "update_document",
    description:
      "Replace a document's text, title or both; the old text stays as a version the person can restore. Check it with list_documents first: the person may have edited it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: DOCUMENT_ID,
        title: { type: "string", maxLength: DOCUMENT_TITLE_MAX },
        content: { type: "string", description: CONTENT },
      },
      required: ["id"],
    },
  },
  {
    name: "list_documents",
    description: "Read-only: your documents, newest first; with id, its current text; with id and export_as, a file of it to attach or email.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { id: DOCUMENT_ID, export_as: { type: "string", enum: ["pdf", "xlsx", "docx", "csv", "md"] } },
    },
  },
];
