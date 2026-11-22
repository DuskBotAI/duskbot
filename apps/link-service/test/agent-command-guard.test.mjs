import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { runsAsCommand } from "../agent.mjs";

const agentFile = fileURLToPath(new URL("../agent.mjs", import.meta.url));

describe("agent command guard", () => {
  it("runs a command only when node was started on agent.mjs itself", () => {
    expect(runsAsCommand(agentFile, agentFile)).toBe(true);
    expect(runsAsCommand(agentFile, undefined)).toBe(false);
    expect(runsAsCommand(agentFile, "/usr/lib/openmausbot/app/dist-server/index.js")).toBe(false);
    expect(runsAsCommand("/usr/lib/openmausbot/app/dist-server/index.js", "/usr/lib/openmausbot/app/dist-server/index.js")).toBe(false);
  });

  it("stays a library inside a bundled server that loads it as its phone hub", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-guard-"));
    try {
      const entry = join(dir, "entry.mjs");
      writeFileSync(entry, `const hub = await import(${JSON.stringify(agentFile)});\nconsole.log(typeof hub.createPhoneHub);\n`);
      await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outdir: join(dir, "dist-server"), packages: "external", logLevel: "silent" });
      const out = execFileSync(process.execPath, [join(dir, "dist-server", "entry.js")], { encoding: "utf8", timeout: 20_000 });
      expect(out.trim()).toBe("function");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
