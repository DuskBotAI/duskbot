import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BOX_HOSTNAME } from "../bot-box/plan.ts";
import { attachablePath } from "./box-attach.ts";

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const work = mkdtempSync(join(homedir(), ".box-attach-test-"));
  const tmp = join("/tmp", `box-attach-${process.pid}-${made.length}`);
  mkdirSync(tmp, { recursive: true });
  made.push(work, tmp);
  return { work, tmp };
}

describe.skipIf(process.platform === "win32")("attachablePath", () => {
  it("copies a file from the box's private /tmp into the working folder, keeping an existing file of that name", () => {
    const { work, tmp } = fixture();
    writeFileSync(join(tmp, "report.pdf"), "new");
    writeFileSync(join(work, "report.pdf"), "old");
    const staged = attachablePath(join(tmp, "report.pdf"), { host: BOX_HOSTNAME, cwd: work });
    expect(staged).toBe(join(work, "report-1.pdf"));
    expect(readFileSync(staged as string, "utf8")).toBe("new");
    expect(readFileSync(join(work, "report.pdf"), "utf8")).toBe("old");
  });

  it("leaves every other path as it was: outside a box, outside /tmp, a missing file, a folder", () => {
    const { work, tmp } = fixture();
    writeFileSync(join(tmp, "a.png"), "x");
    expect(attachablePath(join(tmp, "a.png"), { host: "my-laptop", cwd: work })).toBe(join(tmp, "a.png"));
    expect(attachablePath(join(work, "b.png"), { host: BOX_HOSTNAME, cwd: work })).toBe(join(work, "b.png"));
    expect(attachablePath(join(tmp, "missing.png"), { host: BOX_HOSTNAME, cwd: work })).toBe(join(tmp, "missing.png"));
    expect(attachablePath(tmp, { host: BOX_HOSTNAME, cwd: work })).toBe(tmp);
    expect(attachablePath("relative.png", { host: BOX_HOSTNAME, cwd: work })).toBe("relative.png");
    expect(attachablePath(undefined, { host: BOX_HOSTNAME, cwd: work })).toBeUndefined();
  });
});
