import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("./check-skin-contrast.mjs", import.meta.url));

describe("check:contrast", () => {
  const run = spawnSync(process.execPath, [script], { encoding: "utf8" });

  it("passes on the shipped skins", () => {
    expect(run.stdout).not.toMatch(/^✗/m);
    expect(run.status).toBe(0);
  });

  it("measures a skin with a second block by its own tokens, not the base's", () => {
    expect(run.stdout).toMatch(/^✓ pop — /m);
  });
});
