import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";

import { guestWorkspaceToHost } from "../bot-attachment.ts";
import { VM_WORKSPACE_GUEST } from "../container-computer.ts";
import { openMessageFile, type OpenedMessageFile } from "../message-file.ts";
import type { VpsCommandRunner } from "../vps-computer.ts";
import { NO_EXEC_COMPUTER, pushVpsFile } from "../vps-exec.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const COPY_TO_COMPUTER = "/api/internal/copy-to-computer";

export type CopyTarget = { localVm: string } | { vps: { alias: string; containerId: string } };

function statusError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** Where the copy lands on the computer: `to` when it is a path in the workspace (a folder when it ends in "/"), else the
 * workspace itself, under the file's own name. */
export function copyDestination(to: unknown, name: string): string {
  if (to === undefined || to === null || to === "") return posix.join(VM_WORKSPACE_GUEST, name);
  if (typeof to !== "string") throw statusError(400, "to must be a path in /home/cua/workspace");
  const value = to.trim();
  const full = value.startsWith("/") ? value : posix.join(VM_WORKSPACE_GUEST, value);
  const guest = value.endsWith("/") ? posix.join(full, name) : posix.normalize(full);
  if (!guestWorkspaceToHost(guest, VM_WORKSPACE_GUEST, "/")) throw statusError(400, "to must be a path in /home/cua/workspace");
  return guest;
}

/** Copies into a Local VM's bind-mounted workspace. Every folder on the way is a real folder inside it, never a link the VM
 * left there, so the write cannot land elsewhere on the host. */
async function copyIntoWorkspace(file: OpenedMessageFile, workspaceDir: string, guest: string): Promise<number> {
  const outside = () => statusError(400, "to must be a path in /home/cua/workspace, through folders rather than links");
  const root = await realpath(workspaceDir);
  const host = guestWorkspaceToHost(guest, VM_WORKSPACE_GUEST, root)!;
  let dir = root;
  for (const part of relative(root, dirname(host)).split(sep).filter(Boolean)) {
    dir = join(dir, part);
    await mkdir(dir).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) throw outside();
  }
  const parent = await realpath(dir);
  if (!inside(root, parent)) throw outside();
  const temp = join(parent, `.${basename(host)}.${randomBytes(6).toString("hex")}.dusk-part`);
  const out = await open(temp, "wx", 0o644);
  try {
    await pipeline(file.handle.createReadStream({ start: 0, autoClose: false }), out.createWriteStream());
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  await rename(temp, join(parent, basename(host)));
  return file.bytes;
}

/** Only dispatch inside the internal capability gate. copy_to_computer: one file from the bot's working folder onto the
 * computer this turn works on, in one call. */
export function createComputerCopyRoutes(deps: {
  /** Whether the calling conversation still belongs to the calling bot. */
  owns(): boolean;
  /** Host folders the bot may read from. */
  roots(): readonly string[];
  target(): Promise<CopyTarget | undefined>;
  requireActive(): void;
  /** The request body, read through the internal gate's own reader. */
  body(): Promise<Record<string, unknown>>;
  runner?: VpsCommandRunner;
}): RouteHandler {
  return async ({ method, path, res, json }) => {
    if (method !== "POST" || path !== COPY_TO_COMPUTER) return PASS;
    if (!deps.owns()) return json(res, 403, { error: "source conversation does not belong to sender" });
    let source = "";
    try {
      const body = await deps.body();
      source = typeof body.path === "string" ? body.path.trim() : "";
      if (!source) return json(res, 400, { error: "path is required: the file in your working folder to copy" });
      const target = await deps.target();
      if (!target) return json(res, 409, { error: NO_EXEC_COMPUTER });
      const file = await openMessageFile(source, deps.roots());
      try {
        const guest = copyDestination(body.to, file.name);
        deps.requireActive();
        const bytes = "localVm" in target
          ? await copyIntoWorkspace(file, target.localVm, guest)
          : await pushVpsFile(target.vps.alias, target.vps.containerId, guest, await file.handle.readFile(), deps.runner);
        return json(res, 200, { ok: true, path: guest, bytes });
      } finally {
        await file.handle.close().catch(() => undefined);
      }
    } catch (error) {
      const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 500;
      const message = (error as { code?: unknown }).code === "outside_workspace"
        ? `${source} isn't in your working folder: only files you saved there can be copied.`
        : status === 404 ? `No file was found at ${source} in your working folder. Pass the exact path of a file you saved there.`
          : error instanceof Error ? error.message : "could not copy that file";
      return json(res, status, { error: message });
    }
  };
}
