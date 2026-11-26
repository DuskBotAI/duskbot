import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { prepareAntigravityProfile } from "./antigravity-acp.ts";
import { AntigravityAuthController, antigravitySignInFailure } from "./antigravity-auth.ts";
import { ANTIGRAVITY_CODE_REDIRECT_URI } from "./antigravity-oauth.ts";
import { resolveAntigravityReleaseAsset } from "./antigravity-release.ts";
import { parseAntigravityVersion, resolveAntigravityRuntime, setAntigravityVersionProbe } from "./antigravity-runtime.ts";

// Antigravity CLI 1.2.17 and 1.3.5, run as `antigravity acp --gemini-dir … --login`.
const OLD_CLI_STDERR = 'Error: unexpected argument "acp".\nPrompts are read only from -p/--print, -i/--prompt-interactive, or stdin, so this argument would have been ignored.';
// Antigravity CLI 1.4.12: `acp` exists, `--login` does not.
const ACP_WITHOUT_LOGIN_STDERR = "Usage: antigravity acp [flags]\n\nError: flags provided but not defined: -login";

const TOO_OLD = "The Antigravity app on this computer is too old for dusk bot. Try again to install Google's current one.";

const scratch: string[] = [];
const platform = process.platform;

function folder(): string {
  const directory = mkdtempSync(join(tmpdir(), "dusk-antigravity-version-"));
  scratch.push(directory);
  return directory;
}

function script(directory: string, name: string, body: string): string {
  const path = join(directory, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** A CLI found on PATH by name, its probe faked so it never runs: Windows looks for the .exe. */
function onPath(directory: string, name: string): string {
  if (process.platform !== "win32") return script(directory, name, "");
  const path = join(directory, `${name}.exe`);
  writeFileSync(path, "");
  return path;
}

afterEach(async () => {
  Object.defineProperty(process, "platform", { value: platform });
  setAntigravityVersionProbe(null);
  vi.restoreAllMocks();
  while (scratch.length) await removeTempDir(scratch.pop()!);
});

describe("Antigravity CLI versions", () => {
  it("reads the version `--version` prints", () => {
    expect(parseAntigravityVersion("1.5.16\n")).toBe("1.5.16");
    expect(parseAntigravityVersion("v1.3.5")).toBe("1.3.5");
    expect(parseAntigravityVersion("fake-acp 1.0.0")).toBeNull();
    expect(parseAntigravityVersion("")).toBeNull();
  });

  it("skips an Antigravity CLI on PATH older than `agy acp`, so the official runtime gets installed instead", async () => {
    if (!resolveAntigravityReleaseAsset()) return;
    const bin = folder();
    onPath(bin, "antigravity");
    setAntigravityVersionProbe(async () => "1.3.5");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(resolveAntigravityRuntime(undefined, { PATH: bin }, folder()))
      .rejects.toMatchObject({ name: "AntigravitySetupError", message: expect.stringMatching(/Install official Antigravity/) });
  });

  it.each([["1.5.16", "1.5.16"], ["1.5.0", "1.5.0"], [null, null]])("uses a CLI on PATH that reports %s", async (reported, version) => {
    const bin = folder();
    const executable = onPath(bin, "antigravity");
    setAntigravityVersionProbe(async () => reported);
    await expect(resolveAntigravityRuntime(undefined, { PATH: bin }, folder()))
      .resolves.toEqual({ executablePath: executable, source: "path", version });
  });

  it("on Windows passes over an old agy.exe for a current antigravity.exe later on PATH", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const old = folder();
    const current = folder();
    writeFileSync(join(old, "agy.exe"), "old");
    writeFileSync(join(current, "antigravity.exe"), "current");
    setAntigravityVersionProbe(async (path) => (path.startsWith(old) ? "1.3.5" : "1.5.16"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(resolveAntigravityRuntime(undefined, { Path: [old, current].join(delimiter) }, folder()))
      .resolves.toEqual({ executablePath: join(current, "antigravity.exe"), source: "path", version: "1.5.16" });
  });

  it("asks the CLI itself with --version, auto-update off", async () => {
    const bin = folder();
    script(bin, "antigravity", 'process.stdout.write(process.argv[2] === "--version" && process.env.AGY_CLI_DISABLE_AUTO_UPDATE === "1" ? "1.3.5\\n" : "")');
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolving = resolveAntigravityRuntime(undefined, { PATH: [bin, process.env.PATH].join(delimiter) }, folder());
    if (resolveAntigravityReleaseAsset()) await expect(resolving).rejects.toMatchObject({ name: "AntigravitySetupError" });
    else await expect(resolving).rejects.toThrow();
  });
});

describe("a failed Antigravity sign-in", () => {
  it("says the CLI is too old in one plain sentence, never its raw output", () => {
    for (const stderr of [OLD_CLI_STDERR, ACP_WITHOUT_LOGIN_STDERR]) {
      const message = antigravitySignInFailure(stderr);
      expect(message).toBe(TOO_OLD);
    }
    expect(antigravitySignInFailure("panic: something else")).toBe("Antigravity couldn't start Google sign-in. Try again in a moment.");
  });

  it("shows the plain sentence when an old CLI rejects `acp --login`, and logs the raw cause", async () => {
    const bin = folder();
    const executable = script(bin, "agy-old", `process.stderr.write(${JSON.stringify(`${OLD_CLI_STDERR}\n`)}); process.exit(2);`);
    setAntigravityVersionProbe(async () => null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = await resolveAntigravityRuntime(executable, { PATH: process.env.PATH }, bin);
    const profile = await prepareAntigravityProfile({ instanceId: "old-cli", runtime, baseDir: bin });
    const controller = new AntigravityAuthController();
    try {
      const failure = await controller.start(runtime, profile).then(() => null, (error: Error) => error);
      expect(failure?.message).toBe(TOO_OLD);
      expect(failure?.message).not.toMatch(/unexpected argument|Prompts are read/);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("unexpected argument"));
    } finally {
      await controller.cancelAndWait();
    }
  }, 30_000);

  it("skips a CLI on PATH whose version could not be read once it turns `acp --login` away, so Try again installs the official runtime", async () => {
    if (!resolveAntigravityReleaseAsset()) return;
    const bin = folder();
    const data = folder();
    const executable = script(bin, "agy", `process.stderr.write(${JSON.stringify(`${ACP_WITHOUT_LOGIN_STDERR}\n`)}); process.exit(1);`);
    setAntigravityVersionProbe(async () => null);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = { PATH: [bin, dirname(process.execPath)].join(delimiter) };
    const runtime = await resolveAntigravityRuntime(undefined, env, data);
    expect(runtime).toMatchObject({ executablePath: executable, source: "path" });
    const profile = await prepareAntigravityProfile({ instanceId: "unread-old", runtime, baseDir: data });
    const controller = new AntigravityAuthController();
    try {
      await expect(controller.start(runtime, profile)).rejects.toThrow(TOO_OLD);
    } finally {
      await controller.cancelAndWait();
    }
    await expect(resolveAntigravityRuntime(undefined, env, data))
      .rejects.toMatchObject({ name: "AntigravitySetupError", message: expect.stringMatching(/Install official Antigravity/) });
  }, 30_000);

  it("names the custom path when a custom executable turns `acp --login` away", async () => {
    const bin = folder();
    const executable = script(bin, "my-antigravity", `process.stderr.write(${JSON.stringify(`${OLD_CLI_STDERR}\n`)}); process.exit(2);`);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = await resolveAntigravityRuntime(executable, { PATH: process.env.PATH }, bin);
    const profile = await prepareAntigravityProfile({ instanceId: "custom-old", runtime, baseDir: bin });
    const controller = new AntigravityAuthController();
    try {
      await expect(controller.start(runtime, profile)).rejects.toThrow(TOO_OLD);
    } finally {
      await controller.cancelAndWait();
    }
    await expect(resolveAntigravityRuntime(executable, { PATH: process.env.PATH }, bin))
      .rejects.toThrow("The custom Antigravity executable is too old for dusk bot. Clear the custom path or point it at Antigravity 1.5 or newer.");
  }, 30_000);

  it("passes over a saved absolute agy path older than `agy acp` instead of signing in with it", async () => {
    if (!resolveAntigravityReleaseAsset()) return;
    const bin = folder();
    const saved = onPath(bin, "agy");
    setAntigravityVersionProbe(async () => "1.4.11");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(resolveAntigravityRuntime(saved, { PATH: folder() }, folder()))
      .rejects.toMatchObject({ name: "AntigravitySetupError", message: expect.stringMatching(/Install official Antigravity/) });
  });

  it("says Google didn't accept the code when the CLI fails after a paste", async () => {
    const bin = folder();
    const url = `https://accounts.google.com/o/oauth2/auth?response_type=code&state=fixture&redirect_uri=${encodeURIComponent(ANTIGRAVITY_CODE_REDIRECT_URI)}`;
    const executable = script(bin, "agy-rejects", `process.stdout.write(${JSON.stringify(`Open this link:\n\n  ${url}\n`)});
process.stdin.once("data", () => { process.stderr.write("oauth2: invalid_grant\\n"); process.exit(1); });`);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = await resolveAntigravityRuntime(executable, { PATH: process.env.PATH }, bin);
    const profile = await prepareAntigravityProfile({ instanceId: "rejected-code", runtime, baseDir: bin });
    const controller = new AntigravityAuthController();
    try {
      const flow = await controller.start(runtime, profile);
      await expect(controller.complete(flow.flowId!, "4/0AbCdEfGhIjKlMnOp"))
        .rejects.toThrow("Google didn't accept that code. Start sign-in again and paste the whole code from the Antigravity page.");
    } finally {
      await controller.cancelAndWait();
    }
  }, 30_000);
});
