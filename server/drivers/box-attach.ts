// attach_file from inside a bot box: the box's /tmp and /var/tmp are its own, so the server,
// which reads the file to attach it, finds nothing at a path there. The tool's proxy runs in the same box and can still
// read it, so it copies such a file into the turn's working folder, which the server can read, and attaches that copy.
import { copyFileSync, existsSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";

import { BOX_HOSTNAME, under } from "../bot-box/plan.ts";

const BOX_PRIVATE = ["/tmp", "/var/tmp"];

export interface StageOptions { host?: string; cwd?: string }

/** The path to hand the server: `path` itself, or the copy of a box-private file in the working folder. */
export function attachablePath(path: unknown, options: StageOptions = {}): unknown {
  const host = options.host ?? hostname();
  if (host !== BOX_HOSTNAME || typeof path !== "string" || !isAbsolute(path)) return path;
  const source = resolve(path);
  const cwd = resolve(options.cwd ?? process.cwd());
  if (!BOX_PRIVATE.some((root) => under(source, root)) || under(cwd, "/tmp") || under(cwd, "/var/tmp")) return path;
  try {
    if (!statSync(source).isFile()) return path;
    const ext = extname(source), stem = basename(source, ext);
    let target = join(cwd, basename(source));
    for (let n = 1; existsSync(target); n += 1) target = join(cwd, `${stem}-${n}${ext}`);
    copyFileSync(source, target);
    return target;
  } catch {
    return path;
  }
}
