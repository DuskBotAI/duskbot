// Files a bot attaches to a message it sends: only its own made files (a document exported as a file, an attachment it
// saved from mail), never any other path on this computer.
import { realpathSync, statSync } from "node:fs";
import { basename, sep } from "node:path";

export const ATTACHMENTS_MAX = 5;
const ATTACHMENT_BYTES_MAX = 20 * 1024 * 1024;

export type Attachment = { filename: string; path: string };

/** The files to attach, or what is wrong with the list in the bot's words. */
export function emailAttachments(paths: unknown, roots: readonly string[]): { ok: true; files: Attachment[] } | { ok: false; error: string } {
  if (paths === undefined) return { ok: true, files: [] };
  if (!Array.isArray(paths) || paths.length > ATTACHMENTS_MAX || paths.some((path) => typeof path !== "string" || !path)) {
    return { ok: false, error: `attachments is a list of at most ${ATTACHMENTS_MAX} file paths.` };
  }
  const real = roots.flatMap((root) => { try { return [realpathSync(root)]; } catch { return []; } });
  const files: Attachment[] = [];
  let total = 0;
  for (const path of paths as string[]) {
    let resolved: string;
    try { resolved = realpathSync(path); } catch { return { ok: false, error: `${basename(path)} was not found: export the document again (list_documents with export_as) and use the path it gives.` }; }
    // Security: a link or ../ out of the bot's own folders would mail any file on this computer to anyone.
    if (!real.some((root) => resolved.startsWith(`${root}${sep}`))) return { ok: false, error: `${basename(path)} is not one of your files: attach only a file you made (list_documents with export_as) or saved from mail.` };
    const stat = statSync(resolved);
    if (!stat.isFile()) return { ok: false, error: `${basename(path)} is a folder, not a file.` };
    total += stat.size;
    if (total > ATTACHMENT_BYTES_MAX) return { ok: false, error: "Attachments go up to 20 MB in all." };
    files.push({ filename: basename(resolved), path: resolved });
  }
  return { ok: true, files };
}
