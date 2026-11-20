// The bot's documents over HTTP: the internal call behind create_document, update_document and list_documents (after
// index.ts checks the capability bearer, so a bot only ever reaches its own), and the panel's routes for the person.
import { mkdirSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";

import { redactSecretsInText } from "../../shared/redact.ts";
import { DOCUMENT_MAX_BYTES, documentCard, type ChatDocumentCard, type DocumentMeta, type DocumentWithContent } from "../../shared/documents.ts";
import type { BotDocuments, DocumentResult } from "../bot-documents.ts";
import { EXPORT_FORMATS, exportFileName, isExportFormat, renderDocument } from "../doc-render/index.ts";
import type { json as sendJson } from "../harness/http.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const DOCUMENTS_INTERNAL = "/api/internal/documents";
const LISTED = 50;
/** Room for the largest document's text once escaped in JSON. */
const BODY_LIMIT = DOCUMENT_MAX_BYTES * 3;

export interface DocumentRouteDeps {
  documents: BotDocuments;
  bot(id: string): unknown;
  /** Puts the card in the conversation the call came from; the message id, or null when there is none to post in. */
  post(botId: string, threadId: string, text: string, card: ChatDocumentCard): string | null;
  /** Where a document exported as a file is written: a folder of the bot's own that attach_file and mail can send from. */
  exportDir?(botId: string): string;
}

export interface DocumentInternalContext {
  method: string;
  path: string;
  res: ServerResponse;
  json: typeof sendJson;
  botId: string;
  threadId: string;
  readBody: () => Promise<unknown>;
}

const KIND_WORD = { markdown: "document", sheet: "sheet", html: "web page" } as const;

function cardText(card: ChatDocumentCard): string {
  return `${card.change === "created" ? "Made" : "Updated"} the ${KIND_WORD[card.kind]} "${card.title}".`;
}

function listLine(meta: DocumentMeta): string {
  const shape = meta.kind === "sheet" ? `, ${meta.rows} rows x ${meta.columns} columns` : `, ${meta.bytes} bytes`;
  return `${meta.id} | ${meta.kind} | ${meta.title} | v${meta.version}${shape} | updated ${new Date(meta.updatedAt).toISOString()}${meta.by === "person" ? " by the person" : ""}${meta.manual ? " | the person's manual: read it, never change it" : ""}`;
}

/** Text a bot wrote goes through the same secret masking as its messages; `masked` says whether anything changed. */
function masked(value: unknown): { value: unknown; masked: boolean } {
  if (typeof value !== "string") return { value, masked: false };
  const clean = redactSecretsInText(value);
  return { value: clean, masked: clean !== value };
}

const MASKED_NOTE = " Something in it read as a secret and was masked before it was stored. Never put secrets in a document.";

export function createDocumentRoutes(deps: DocumentRouteDeps) {
  const { documents } = deps;

  const internal = async (ctx: DocumentInternalContext): Promise<typeof PASS | void> => {
    if (ctx.method !== "POST" || ctx.path !== DOCUMENTS_INTERNAL) return PASS;
    const refuse = (error: string, status = 400) => void ctx.json(ctx.res, status, { error });
    const body = await ctx.readBody().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return refuse("Send a JSON object with an action.");

    if (body.action === "list") {
      if (typeof body.id === "string") {
        const document = documents.get(ctx.botId, body.id);
        if (!document) return refuse("No such document. Call list_documents without an id to see the ones you keep.", 404);
        if (body.export_as !== undefined) return exportFile(ctx, document, body.export_as);
        return void ctx.json(ctx.res, 200, { text: `${listLine(document)}\n--- content ---\n${document.content}` });
      }
      const all = documents.list(ctx.botId);
      if (!all.length) return void ctx.json(ctx.res, 200, { text: "You keep no documents yet." });
      const more = all.length > LISTED ? `\nand ${all.length - LISTED} older` : "";
      return void ctx.json(ctx.res, 200, { text: `Newest first (id | kind | title | version | updated):\n${all.slice(0, LISTED).map(listLine).join("\n")}${more}` });
    }

    if (body.action !== "create" && body.action !== "update") return refuse("action is one of create, update, list.");
    const title = masked(body.title);
    const content = masked(body.content);
    let result: DocumentResult;
    if (body.action === "create") {
      result = documents.create(ctx.botId, { title: title.value, kind: body.kind, content: content.value, manual: body.manual === true }, "bot");
    } else {
      if (typeof body.id !== "string") return refuse("id is the document's id, from create_document or list_documents.");
      if (body.title === undefined && body.content === undefined) return refuse("Send content (the whole new text), title, or both.");
      result = documents.update(ctx.botId, body.id, {
        ...(body.title === undefined ? {} : { title: title.value }),
        ...(body.content === undefined ? {} : { content: content.value }),
      }, "bot");
    }
    if (!result.ok) return refuse(result.error, result.status);
    const document = result.document;
    const card = documentCard(document, document.content, body.action === "create" ? "created" : "updated");
    const messageId = ctx.threadId ? deps.post(ctx.botId, ctx.threadId, cardText(card), card) : null;
    const shown = messageId ? " It shows in the chat as a file card the person can open, edit and download, and it stays in your panel under Files." : "";
    const note = title.masked || content.masked ? MASKED_NOTE : "";
    const verb = body.action === "create" ? "Saved" : "Updated";
    return void ctx.json(ctx.res, 200, {
      text: `${verb} "${document.title}" (id ${document.id}, version ${document.version}).${shown} Keep your reply to a line or two about it; never paste its contents into the chat.${note}`,
      id: document.id,
      ...(messageId ? { messageId } : {}),
    });
  };

  function exportFile(ctx: DocumentInternalContext, document: DocumentWithContent, format: unknown): void {
    if (!isExportFormat(format)) return void ctx.json(ctx.res, 400, { error: `export_as is one of ${EXPORT_FORMATS.join(", ")}.` });
    if (!deps.exportDir) return void ctx.json(ctx.res, 409, { error: "Files can't be made here." });
    const made = renderDocument(document, format);
    if ("error" in made) return void ctx.json(ctx.res, 400, { error: made.error });
    const dir = deps.exportDir(ctx.botId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, exportFileName(document.title, made.extension));
    writeFileSync(path, made.bytes, { mode: 0o600 });
    return void ctx.json(ctx.res, 200, { path, text: `Made ${path} (${made.bytes.length} bytes) from "${document.title}" version ${document.version}. To show it here, attach_file with that path; to send it, pass the path as an attachment of the email.` });
  }

  const routes: RouteHandler = async ({ req, res, path, method, json, readBody }) => {
    const match = /^\/api\/bots\/([\w-]+)\/documents(?:\/(d_[0-9a-f]{12})(\/restore)?)?$/.exec(path);
    if (!match) return PASS;
    const [, botId, id, restore] = match as unknown as [string, string, string | undefined, string | undefined];
    if (!deps.bot(botId)) return json(res, 404, { error: "No such bot." });
    const answer = (result: DocumentResult) => result.ok ? json(res, 200, result.document) : json(res, result.status, { error: result.error });

    if (!id) return method === "GET" ? json(res, 200, { documents: documents.list(botId) }) : PASS;
    if (restore) {
      if (method !== "POST") return PASS;
      const body = await readBody(req, BODY_LIMIT).catch(() => null) as { version?: unknown } | null;
      if (typeof body?.version !== "number") return json(res, 400, { error: "version is the number of the version to bring back." });
      return answer(documents.restore(botId, id, body.version, "person"));
    }
    if (method === "GET") {
      const document = documents.get(botId, id);
      return document ? json(res, 200, document) : json(res, 404, { error: "This file was deleted." });
    }
    if (method === "PATCH") {
      const body = await readBody(req, BODY_LIMIT).catch(() => null) as Record<string, unknown> | null;
      if (!body || typeof body !== "object") return json(res, 400, { error: "Send the new title, content, or both." });
      return answer(documents.update(botId, id, { title: body.title, content: body.content, expectedVersion: body.expectedVersion }, "person"));
    }
    if (method === "DELETE") return documents.remove(botId, id) ? json(res, 200, { ok: true }) : json(res, 404, { error: "This file was deleted." });
    return PASS;
  };

  return { internal, routes };
}
