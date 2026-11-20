import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { emailAttachments } from "./attachments.ts";

describe("files a sent message may carry", () => {
  const base = mkdtempSync(join(tmpdir(), "email-attach-"));
  const files = join(base, "workspaces", "bot-1", "files");
  mkdirSync(files, { recursive: true });
  writeFileSync(join(files, "Weekly report.pdf"), "%PDF-1.4");
  writeFileSync(join(base, "config.json"), "{\"key\":\"secret\"}");
  symlinkSync(join(base, "config.json"), join(files, "innocent.pdf"));

  it("takes the bot's own made files", () => {
    expect(emailAttachments([join(files, "Weekly report.pdf")], [files])).toMatchObject({ ok: true, files: [{ filename: "Weekly report.pdf" }] });
    expect(emailAttachments(undefined, [files])).toEqual({ ok: true, files: [] });
  });

  it("never a file elsewhere, through ../ or a link, nor a missing one or too many", () => {
    expect(emailAttachments([join(files, "..", "..", "..", "config.json")], [files])).toMatchObject({ ok: false, error: expect.stringContaining("not one of your files") });
    expect(emailAttachments([join(files, "innocent.pdf")], [files])).toMatchObject({ ok: false, error: expect.stringContaining("not one of your files") });
    expect(emailAttachments([join(files, "gone.pdf")], [files])).toMatchObject({ ok: false, error: expect.stringContaining("not found") });
    expect(emailAttachments([files], [join(base, "workspaces")])).toMatchObject({ ok: false, error: expect.stringContaining("folder") });
    expect(emailAttachments(Array(6).fill(join(files, "Weekly report.pdf")), [files])).toMatchObject({ ok: false });
  });
});
