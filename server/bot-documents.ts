// Each bot's documents (shared/documents.ts) under DATA_DIR/bot-documents/<botId>/<id>.json, one file per document
// holding its text and up to DOCUMENT_VERSIONS_KEPT earlier versions.
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  DOCUMENT_ID, DOCUMENT_MAX_BYTES, DOCUMENT_TITLE_MAX, DOCUMENT_VERSIONS_KEPT, DOCUMENTS_PER_BOT, documentShape, isDocumentKind,
  type DocumentAuthor, type DocumentKind, type DocumentMeta, type DocumentWithContent,
} from "../shared/documents.ts";
import { writeFileAtomic } from "./atomic.ts";

const BOT_ID = /^[\w-]{1,128}$/;

interface StoredVersion { version: number; at: number; by: DocumentAuthor; content: string }
interface StoredDocument extends DocumentMeta { content: string; history: StoredVersion[] }

export type DocumentResult = { ok: true; document: DocumentWithContent } | { ok: false; status: 400 | 404 | 409 | 413; error: string };

const fail = (status: 400 | 404 | 409 | 413, error: string): DocumentResult => ({ ok: false, status, error });

function cleanTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.replace(/\s+/g, " ").trim();
  return title && title.length <= DOCUMENT_TITLE_MAX ? title : null;
}

function contentProblem(content: unknown): DocumentResult | null {
  if (typeof content !== "string") return fail(400, "content must be the document's whole text, as a string.");
  if (Buffer.byteLength(content) > DOCUMENT_MAX_BYTES) return fail(413, `A document holds at most ${DOCUMENT_MAX_BYTES / 1024} KB of text; split it.`);
  return null;
}

function view(stored: StoredDocument): DocumentWithContent {
  const { history, ...rest } = stored;
  return {
    ...rest,
    versions: [...history].reverse().map(({ version, at, by, content }) => ({ version, at, by, bytes: Buffer.byteLength(content) })),
  };
}

export const MANUAL_REFUSAL = "This is the person's manual: you read it and follow it, and only they change it. Tell them what you would change and why; they edit it in your Files.";

export class BotDocuments {
  private readonly dir: string;
  private readonly now: () => number;

  constructor(dir: string, now: () => number = Date.now) {
    this.dir = dir;
    this.now = now;
  }

  private folder(botId: string): string | null {
    return BOT_ID.test(botId) ? join(this.dir, botId) : null;
  }

  private read(botId: string, id: string): StoredDocument | null {
    const folder = this.folder(botId);
    if (!folder || !DOCUMENT_ID.test(id)) return null;
    try {
      const stored = JSON.parse(readFileSync(join(folder, `${id}.json`), "utf8")) as StoredDocument;
      return stored.id === id && stored.botId === botId && isDocumentKind(stored.kind) ? stored : null;
    } catch {
      return null;
    }
  }

  private write(stored: StoredDocument): void {
    const folder = this.folder(stored.botId)!;
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileAtomic(join(folder, `${stored.id}.json`), JSON.stringify(stored), { mode: 0o600 });
  }

  private ids(botId: string): string[] {
    const folder = this.folder(botId);
    if (!folder) return [];
    try {
      return readdirSync(folder).flatMap((name) => {
        const id = name.replace(/\.json$/, "");
        return name.endsWith(".json") && DOCUMENT_ID.test(id) ? [id] : [];
      });
    } catch {
      return [];
    }
  }

  /** Newest change first. */
  list(botId: string): DocumentMeta[] {
    return this.ids(botId).flatMap((id) => {
      const stored = this.read(botId, id);
      if (!stored) return [];
      const { content: _content, history: _history, ...meta } = stored;
      return [meta];
    }).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(botId: string, id: string): DocumentWithContent | null {
    const stored = this.read(botId, id);
    return stored ? view(stored) : null;
  }

  create(botId: string, input: { title: unknown; kind: unknown; content: unknown; manual?: boolean }, by: DocumentAuthor): DocumentResult {
    if (!this.folder(botId)) return fail(404, "No such bot.");
    const title = cleanTitle(input.title);
    if (!title) return fail(400, `title is a short name for the document, at most ${DOCUMENT_TITLE_MAX} characters.`);
    if (!isDocumentKind(input.kind)) return fail(400, "kind is markdown, sheet or html.");
    const problem = contentProblem(input.content);
    if (problem) return problem;
    if (this.ids(botId).length >= DOCUMENTS_PER_BOT) return fail(409, `This bot already keeps ${DOCUMENTS_PER_BOT} documents: update one, or ask the person to delete some.`);
    const at = this.now();
    const kind: DocumentKind = input.kind;
    const content = input.content as string;
    const stored: StoredDocument = {
      id: `d_${randomBytes(6).toString("hex")}`, botId, title, kind, ...documentShape(kind, content),
      createdAt: at, updatedAt: at, version: 1, by, content, history: [], ...(input.manual === true ? { manual: true as const } : {}),
    };
    this.write(stored);
    return { ok: true, document: view(stored) };
  }

  /** A new version: the text it replaces is kept among the earlier versions. `expectedVersion`, when given, refuses a
   * change made over a newer one. */
  update(botId: string, id: string, change: { title?: unknown; content?: unknown; expectedVersion?: unknown }, by: DocumentAuthor): DocumentResult {
    const stored = this.read(botId, id);
    if (!stored) return fail(404, "No such document. list_documents shows the ones this bot keeps.");
    // Security: a manual is the person's rules for the bot; a bot (or a page it read) must never rewrite them.
    if (stored.manual && by !== "person") return fail(409, MANUAL_REFUSAL);
    if (typeof change.expectedVersion === "number" && change.expectedVersion !== stored.version) {
      return fail(409, "This document changed since it was opened.");
    }
    const title = change.title === undefined ? stored.title : cleanTitle(change.title);
    if (!title) return fail(400, `title is a short name for the document, at most ${DOCUMENT_TITLE_MAX} characters.`);
    if (change.content !== undefined) {
      const problem = contentProblem(change.content);
      if (problem) return problem;
    }
    const content = change.content === undefined ? stored.content : change.content as string;
    if (content === stored.content) {
      if (title === stored.title) return { ok: true, document: view(stored) };
      const renamed = { ...stored, title, updatedAt: this.now() };
      this.write(renamed);
      return { ok: true, document: view(renamed) };
    }
    const history = [...stored.history, { version: stored.version, at: stored.updatedAt, by: stored.by, content: stored.content }].slice(-DOCUMENT_VERSIONS_KEPT);
    const next: StoredDocument = {
      ...stored, title, ...documentShape(stored.kind, content), content, history,
      updatedAt: this.now(), version: stored.version + 1, by,
    };
    this.write(next);
    return { ok: true, document: view(next) };
  }

  /** Brings an earlier version back as a new version, so the one it replaces can be brought back too. */
  restore(botId: string, id: string, version: number, by: DocumentAuthor): DocumentResult {
    const stored = this.read(botId, id);
    if (!stored) return fail(404, "No such document.");
    const earlier = stored.history.find((entry) => entry.version === version);
    if (!earlier) return fail(404, "That version is no longer kept.");
    return this.update(botId, id, { content: earlier.content }, by);
  }

  remove(botId: string, id: string): boolean {
    const folder = this.folder(botId);
    if (!folder || !this.read(botId, id)) return false;
    rmSync(join(folder, `${id}.json`), { force: true });
    return true;
  }
}
