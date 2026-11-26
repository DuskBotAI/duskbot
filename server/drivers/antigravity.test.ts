import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR, ensureDirs } from "../config.ts";
import { boxEnvironment } from "../bot-box/env.ts";
import { TurnNotStartedError, type ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import * as procs from "../procs.ts";
import * as envPath from "../env-path.ts";
import * as managedRuntime from "./antigravity-runtime.ts";
import {
  ANTIGRAVITY_AUTH_PREFIX,
  ANTIGRAVITY_CODE_REDIRECT_URI,
  AntigravityAcpClient,
  antigravityAcpArgs,
  antigravityProfileAuthenticated,
  antigravityProfileDirectory,
  authorizationUrlFromLine,
  catalogFromAntigravityConfigOptions,
  isValidAntigravityInitializeResult,
  parseAntigravityAuthorizationUrl,
  prepareAntigravityProfile,
  probeAntigravityModels,
  validateAntigravityRuntime,
} from "./antigravity-acp.ts";
import { AntigravityAuthController, antigravityLoginResponse } from "./antigravity-auth.ts";
import {
  ANTIGRAVITY_RELEASE_VERSION,
  antigravityCliTarget,
  fetchAntigravityCliRelease,
  parseAntigravityCliRelease,
  resolveAntigravityReleaseAsset,
  type AntigravityReleaseAsset,
} from "./antigravity-release.ts";
import { installAntigravityRuntime, resolveAntigravityRuntime, setAntigravityVersionProbe } from "./antigravity-runtime.ts";
import * as antigravityTemp from "./antigravity-temp.ts";
import { VERIFICATION_TEMP_KEY, antigravityTempDir, sweepAntigravityTemp } from "./antigravity-temp.ts";
import {
  ANTIGRAVITY_SLASH_COMMANDS,
  AntigravityDriver,
  STATIC_ANTIGRAVITY_MODELS,
  antigravityPermissionMode,
  neutralizeAntigravitySlashCommands,
  normalizeAntigravityTurn,
} from "./antigravity.ts";

const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-acp-cli.ts");
const scratch: string[] = [];

function fakeRuntime(startupDelayMs = 0): { directory: string; executable: string } {
  const directory = mkdtempSync(join(tmpdir(), "dusk-antigravity-acp-"));
  scratch.push(directory);
  const executable = join(directory, "fake-antigravity.ts");
  copyFileSync(FAKE_ACP, executable);
  if (startupDelayMs) {
    writeFileSync(executable, `#!/usr/bin/env node\nsetTimeout(() => import(${JSON.stringify(pathToFileURL(FAKE_ACP).href)}), ${startupDelayMs});\n`);
  }
  if (process.platform !== "win32") {
    chmodSync(executable, 0o755);
  }
  return { directory, executable };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete process.env.FAKE_ACP_AUTH_METHOD;
  delete process.env.FAKE_ACP_MODELS;
  delete process.env.FAKE_ACP_MODES;
  delete process.env.FAKE_ACP_DUMP;
  delete process.env.FAKE_ACP_DUMP_PROMPT;
  delete process.env.FAKE_ACP_AVAILABLE_COMMANDS;
  delete process.env.FAKE_ACP_AVAILABLE_COMMANDS_ONCE;
  delete process.env.FAKE_ACP_TEXT_REPLY;
  delete process.env.FAKE_ACP_PAD_QUESTION_OPTION;
  while (scratch.length) await removeTempDir(scratch.pop()!);
});

describe("official Antigravity catalog", () => {
  it("uses current Gemini 3.8 variants as the offline fallback", () => {
    expect(STATIC_ANTIGRAVITY_MODELS).toEqual({
      default: "gemini-3.8-flash",
      options: [
        {
          id: "gemini-3.8-flash",
          label: "Gemini 3.8 Flash",
          variants: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
          ],
        },
      ],
    });
  });

  it("reads the authenticated account catalog from ACP config options", () => {
    const options = [{
      id: "model",
      type: "select",
      currentValue: "account-low",
      options: [
        { value: "account-high", name: "Account High" },
        { group: "More", options: [{ value: "account-low", name: "Account Low" }] },
      ],
    }, {
      id: "thinking_level",
      category: "thought_level",
      type: "select",
      currentValue: "high",
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    }];
    expect(catalogFromAntigravityConfigOptions(options, "missing")).toEqual({
      default: "account-low",
      options: [
        { id: "account-high", label: "Account High" },
        {
          id: "account-low",
          label: "Account Low",
          variants: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
          ],
        },
      ],
    });
  });
});

describe("Antigravity sign-in lifecycle", () => {
  it("preserves failed setup errors until retry or external recovery, without reviving stale errors", async () => {
    if (!resolveAntigravityReleaseAsset()) return;
    const fake = fakeRuntime();
    const custom = join(fake.directory, "not-installed");
    const install = vi.spyOn(managedRuntime, "installAntigravityRuntime")
      .mockRejectedValueOnce(new Error("Antigravity initialization timed out: fixture failure"));
    const instance = await AntigravityDriver.create({
      instanceId: "failed-antigravity-install",
      displayName: "Antigravity fixture", enabled: true,
      config: { cli: custom, fullAuto: false },
      environment: {},
    });
    try {
      await expect(instance.installRuntime!()).rejects.toThrow("fixture failure");
      expect(await instance.snapshot()).toEqual({ state: "unavailable", reason: "Antigravity initialization timed out: fixture failure" });
      expect((await instance.snapshot()).reason).toContain("fixture failure");
      // A manual/shared install can recover without this instance retrying.
      copyFileSync(fake.executable, custom);
      if (process.platform !== "win32") chmodSync(custom, 0o755);
      expect((await instance.snapshot()).state).toBe("available");
      unlinkSync(custom);
      const unavailable = await instance.snapshot();
      expect(unavailable.state).toBe("unavailable");
      expect(unavailable.reason).not.toContain("fixture failure");
      install.mockRejectedValueOnce(new Error("Antigravity initialization timed out: fixture failure"));
      await expect(instance.installRuntime!()).rejects.toThrow("fixture failure");
      install.mockResolvedValueOnce({ executablePath: fake.executable, source: "managed", version: "1.5.13" });
      await instance.installRuntime!();
      expect((await instance.snapshot()).reason).not.toContain("fixture failure");
    } finally {
      await instance.dispose();
    }
  });

  it("signs out through ACP logout, stops active sessions, clears cached models, and leaves other accounts untouched", async () => {
    ensureDirs();
    const fake = fakeRuntime();
    const rpcDump = join(fake.directory, "logout-rpc.json");
    const instanceId = "antigravity-sign-out";
    const profile = antigravityProfileDirectory(instanceId);
    const cliToken = join(profile, "antigravity-acp", "antigravity-oauth-token");
    const legacyToken = join(profile, "antigravity-acp", "acp_token.json");
    const other = join(antigravityProfileDirectory("antigravity-other"), "antigravity-acp", "antigravity-oauth-token");
    for (const file of [cliToken, legacyToken, other]) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ token: { access_token: "synthetic-token", expiry: "2099-01-01T00:00:00Z" } }), { mode: 0o600 });
    }
    const instance = await AntigravityDriver.create({
      instanceId, displayName: "Antigravity", enabled: true,
      config: { cli: fake.executable, fullAuto: false },
      environment: {
        FAKE_ACP_AUTH_METHOD: "oauth-personal",
        FAKE_ACP_MODELS: "gemini-account-special",
        FAKE_ACP_RPC_DUMP: rpcDump,
      },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.refreshModels!();
      expect(instance.models.options.map((option) => option.id)).toEqual(["gemini-account-special"]);
      expect((await instance.snapshot()).authenticated).toBe(true);
      expect(instance.authenticationMethod).toBe("paste-code");
      expect(instance.signOut).toBeTypeOf("function");

      // Open a pooled session so signOut proves it stops active/pooled processes before logging out.
      const { turnId } = await instance.adapter.sendTurn({ threadId: "signout-thread", text: "hi", approvalMode: "ask", cwd: fake.directory });
      await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);

      await instance.signOut!();
      expect(JSON.parse(readFileSync(rpcDump, "utf8"))).toEqual(["initialize", "logout"]);
      expect(existsSync(cliToken)).toBe(false);
      expect(existsSync(legacyToken)).toBe(false);
      expect(existsSync(join(profile, "antigravity-acp", "settings.json"))).toBe(true);
      expect(existsSync(other)).toBe(true);
      expect((await instance.snapshot()).authenticated).toBe(false);
      expect(instance.models).toEqual(STATIC_ANTIGRAVITY_MODELS);
      // Calling signOut again when already signed out still completes cleanly via ACP logout.
      await instance.signOut!();
    } finally {
      recorder.stop();
      await instance.dispose();
      rmSync(profile, { recursive: true, force: true });
      rmSync(antigravityProfileDirectory("antigravity-other"), { recursive: true, force: true });
    }
  });

  it("refuses sign-out when the runtime does not advertise auth.logout or rejects logout", async () => {
    ensureDirs();
    const fake = fakeRuntime();
    const instanceId = "antigravity-no-logout";
    const profile = antigravityProfileDirectory(instanceId);
    const cliToken = join(profile, "antigravity-acp", "antigravity-oauth-token");
    mkdirSync(dirname(cliToken), { recursive: true });
    writeFileSync(cliToken, "{}", { mode: 0o600 });

    const noCap = await AntigravityDriver.create({
      instanceId, displayName: "Antigravity", enabled: true,
      config: { cli: fake.executable, fullAuto: false },
      environment: { FAKE_ACP_NO_LOGOUT: "1" },
    });
    try {
      await expect(noCap.signOut!()).rejects.toThrow(/does not support sign-out/u);
      expect(existsSync(cliToken)).toBe(true);
    } finally {
      await noCap.dispose();
    }

    const rejected = await AntigravityDriver.create({
      instanceId, displayName: "Antigravity", enabled: true,
      config: { cli: fake.executable, fullAuto: false },
      environment: { FAKE_ACP_LOGOUT_ERROR: "logout failed" },
    });
    try {
      await expect(rejected.signOut!()).rejects.toThrow(/logout failed/u);
      expect(existsSync(cliToken)).toBe(true);
    } finally {
      await rejected.dispose();
      rmSync(profile, { recursive: true, force: true });
    }
  });

  it("uses the same discovered PATH for readiness and Google sign-in", async () => {
    const fake = fakeRuntime();
    const executable = join(fake.directory, process.platform === "win32" ? "agy.exe" : "antigravity");
    copyFileSync(fake.executable, executable);
    if (process.platform !== "win32") chmodSync(executable, 0o755);
    vi.stubEnv("PATH", "");
    vi.spyOn(envPath, "augmentedPath").mockReturnValue(fake.directory);
    const authenticate = vi.spyOn(AntigravityAuthController.prototype, "start").mockResolvedValue({
      phase: "succeeded", flowId: null, authorizationUrl: null, expiresAt: null,
    });
    const instance = await AntigravityDriver.create({
      instanceId: "path-only-antigravity",
      displayName: "Antigravity fixture",
      enabled: true,
      config: { cli: process.platform === "win32" ? "agy.exe" : "antigravity", fullAuto: false },
      environment: { PATH: "" },
    });
    try {
      expect((await instance.snapshot()).state).toBe("available");
      await expect(instance.startAuthentication!()).resolves.toMatchObject({ phase: "succeeded" });
      expect(authenticate).toHaveBeenCalledWith(
        expect.objectContaining({ executablePath: executable }),
        expect.objectContaining({ environment: expect.objectContaining({ PATH: fake.directory }) }),
      );
    } finally {
      await instance.dispose();
    }
  });

  it.each(["cancel", "provider failure"])("contains %s after handing the browser a `--login` sign-in URL", async (ending) => {
    const fake = fakeRuntime();
    const url = `https://accounts.google.com/o/oauth2/auth?response_type=code&state=fixture&redirect_uri=${encodeURIComponent(ANTIGRAVITY_CODE_REDIRECT_URI)}`;
    writeFileSync(fake.executable, `#!/usr/bin/env node
process.stdout.write("Open this link:\\n\\n  " + ${JSON.stringify(url)} + "\\n");
${ending === "provider failure" ? "setTimeout(() => process.exit(1), 100);" : "setInterval(() => {}, 10_000);"}
`);
    if (process.platform !== "win32") chmodSync(fake.executable, 0o755);
    const runtime = await resolveAntigravityRuntime(fake.executable);
    const profile = await prepareAntigravityProfile({ instanceId: "auth-lifecycle", runtime, baseDir: fake.directory });
    const signedIn = vi.fn();
    const controller = new AntigravityAuthController(signedIn);
    try {
      const flow = await controller.start(runtime, profile);
      expect(flow.phase).toBe("waiting");
      expect(flow.authorizationUrl).toBe(url);
      if (ending === "cancel") await controller.cancelAndWait();
      await new Promise((resolve) => setTimeout(resolve, 300));
      await expect(controller.complete(flow.flowId!, "test-auth-code"))
        .rejects.toThrow(/no longer active/u);
      expect(signedIn).not.toHaveBeenCalled();
    } finally {
      await controller.cancelAndWait();
    }
  });

  it.each(["bare-code", "callback-url"] as const)("completes `--login` sign-in with a pasted %s and retries after a 400 invalid paste", async (kind) => {
    const fake = fakeRuntime();
    const runtime = await resolveAntigravityRuntime(fake.executable);
    const profile = await prepareAntigravityProfile({
      instanceId: `auth-code-${kind}`,
      runtime,
      baseDir: fake.directory,
      baseEnv: { PATH: process.env.PATH, FAKE_ACP_LOGIN_STATE: "login-state-1" },
    });
    const signedIn = vi.fn();
    const controller = new AntigravityAuthController(signedIn);
    try {
      const flow = await controller.start(runtime, profile);
      expect(flow.phase).toBe("waiting");
      expect(flow.authorizationUrl).toContain(encodeURIComponent(ANTIGRAVITY_CODE_REDIRECT_URI));

      // Bad paste returns 400 without terminating the flow.
      await expect(controller.complete(flow.flowId!, "https://evil.example/?code=x&state=login-state-1"))
        .rejects.toMatchObject({ status: 400 });
      expect(signedIn).not.toHaveBeenCalled();

      const answer = kind === "bare-code"
        ? "4/0A-synthetic-code"
        : `${ANTIGRAVITY_CODE_REDIRECT_URI}?code=4%2F0A-synthetic-code&state=login-state-1`;
      await controller.complete(flow.flowId!, answer);
      expect(signedIn).toHaveBeenCalledTimes(1);
      expect(await antigravityProfileAuthenticated(profile)).toBe(true);
      expect(existsSync(profile.tokenPath)).toBe(true);
    } finally {
      await controller.cancelAndWait();
    }
  });
});

describe("stopping the runtime before touching its files", () => {
  it.skipIf(process.platform === "win32")("waits through forced shutdown when the verified runtime ignores EOF and TERM", async () => {
    const fake = fakeRuntime();
    // Stays up after its input ends, so close() must go on to force it.
    writeFileSync(fake.executable, `#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1 << 30);\nawait import(${JSON.stringify(pathToFileURL(FAKE_ACP).href)});\n`);
    const runtime = await resolveAntigravityRuntime(fake.executable);
    vi.stubEnv("FAKE_ACP_AGENT_NAME", "Google Antigravity");
    vi.stubEnv("FAKE_ACP_AGENT_VERSION", "1.1.1");
    vi.stubEnv("FAKE_ACP_AUTH_METHOD", "oauth-personal");
    const spawned = vi.spyOn(procs, "spawnCli");
    try {
      await expect(validateAntigravityRuntime(runtime, "agy_acp_server_1.1.1")).resolves.toBeUndefined();
      expect(spawned.mock.results[0]!.value.signalCode).toBe("SIGKILL");
    } finally {
      await Promise.all(spawned.mock.results.map(({ value }) => procs.killCliTree(value, 0)));
    }
  }, 20_000);

  it("ends the runtime's input and lets it exit by itself before any forced stop", async () => {
    // On Windows a forced stop skips the runtime's cleanup of what it unpacked; its own exit removes them.
    const fake = fakeRuntime();
    const runtime = await resolveAntigravityRuntime(fake.executable);
    const profile = await prepareAntigravityProfile({ instanceId: "graceful-close", runtime, baseDir: fake.directory });
    const client = new AntigravityAcpClient(runtime, profile, fake.directory);
    await client.initialize();
    const kill = vi.spyOn(procs, "killCliTree");
    client.close();
    expect(client.child.stdin?.writableEnded).toBe(true);
    expect(kill).not.toHaveBeenCalled();
    expect(await client.closeAndWait()).toBe(true);
    // Exit code 0 and no signal: not SIGTERM (POSIX) and not taskkill's 1.
    expect(client.child.exitCode).toBe(0);
    expect(client.child.signalCode).toBeNull();
  });

  it("validates a real fake runtime and waits for its process to close before returning", async () => {
    const fake = fakeRuntime();
    const runtime = await resolveAntigravityRuntime(fake.executable);
    vi.stubEnv("FAKE_ACP_AGENT_NAME", "Google Antigravity");
    vi.stubEnv("FAKE_ACP_AGENT_VERSION", "1.1.1");
    vi.stubEnv("FAKE_ACP_AUTH_METHOD", "oauth-personal");
    let sawClose = false;
    const spawn = procs.spawnCli;
    const spawned = vi.spyOn(procs, "spawnCli").mockImplementation((...args) => {
      const child = spawn(...args);
      child.once("close", () => { sawClose = true; });
      return child;
    });
    await validateAntigravityRuntime(runtime, "agy_acp_server_1.1.1");
    expect(spawned).toHaveBeenCalledTimes(1);
    expect(sawClose).toBe(true);
    const child = spawned.mock.results[0]!.value;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("closeAndWait resolves only once the process is gone, so a rename on Windows cannot hit a running executable", async () => {
    const fake = fakeRuntime();
    const runtime = await resolveAntigravityRuntime(fake.executable);
    const profile = await prepareAntigravityProfile({ instanceId: "close-and-wait", runtime, baseDir: fake.directory });
    const client = new AntigravityAcpClient(runtime, profile, fake.directory);
    await client.initialize();
    expect(client.child.exitCode).toBeNull();
    expect(await client.closeAndWait()).toBe(true);
    expect(client.child.exitCode !== null || client.child.signalCode !== null).toBe(true);
    expect(await client.closeAndWait(100)).toBe(true);
  });
});

describe("official Antigravity runtime", () => {
  it("pins Google's 1.5.x CLI release metadata for this supported host", () => {
    const asset = resolveAntigravityReleaseAsset();
    if (!asset) return;
    expect(ANTIGRAVITY_RELEASE_VERSION).toBe("1.5.13");
    expect(asset.version).toBe(ANTIGRAVITY_RELEASE_VERSION);
    expect(asset.url).toMatch(/^https:\/\/storage\.googleapis\.com\/antigravity-public\/antigravity-cli\/1\.5\.13-/u);
    expect(asset.sha512).toMatch(/^[a-f0-9]{128}$/u);
    expect(asset.archiveBytes).toBeGreaterThan(50_000_000);
    expect(asset.executable.name).toBe(process.platform === "win32" ? "agy.exe" : "antigravity");
  });

  it.each([
    ["darwin", "arm64", false, "darwin_arm64", "darwin-arm/cli_mac_arm64.tar.gz"],
    ["darwin", "x64", false, "darwin_amd64", "darwin-x64/cli_mac_x64.tar.gz"],
    ["linux", "arm64", false, "linux_arm64", "linux-arm/cli_linux_arm64.tar.gz"],
    ["linux", "x64", false, "linux_amd64", "linux-x64/cli_linux_x64.tar.gz"],
    ["linux", "arm64", true, "linux_arm64_musl", "linux-arm-musl/cli_linux_arm64_musl.tar.gz"],
    ["linux", "x64", true, "linux_amd64_musl", "linux-x64-musl/cli_linux_x64_musl.tar.gz"],
    ["win32", "arm64", false, "windows_arm64", "windows-arm/cli_windows_arm64.exe"],
    ["win32", "x64", false, "windows_amd64", "windows-x64/cli_windows_x64.exe"],
  ] as const)("parses Google's %s-%s CLI manifest (musl %s)", (platform, arch, musl, target, file) => {
    expect(antigravityCliTarget(platform, arch, musl)).toBe(target);
    const parsed = parseAntigravityCliRelease({
      version: "1.5.14",
      url: `https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-999/${file}`,
      sha512: "A".repeat(128),
    }, platform, arch, musl);
    expect(parsed).toEqual({
      version: "1.5.14",
      url: `https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-999/${file}`,
      sha512: "a".repeat(128),
      format: platform === "win32" ? "executable" : "tar.gz",
      executable: { name: platform === "win32" ? "agy.exe" : "antigravity" },
    });
  });

  it("rejects untrusted or mismatched CLI manifests and falls back to pinned baseline on network errors", async () => {
    const valid = {
      version: "1.5.14",
      url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-123/darwin-arm/cli_mac_arm64.tar.gz",
      sha512: "a".repeat(128),
    };
    for (const bad of [
      { ...valid, sha512: "short" },
      { ...valid, url: valid.url.replace("https:", "http:") },
      { ...valid, url: valid.url.replace("storage.googleapis.com", "evil.example") },
      { ...valid, url: valid.url.replace("antigravity-public", "other-bucket") },
      { ...valid, url: `${valid.url}?foo=bar` },
      { ...valid, url: valid.url.replace("1.5.14-123", "1.5.13-123") },
    ]) {
      expect(parseAntigravityCliRelease(bad, "darwin", "arm64", false)).toBeNull();
    }
    const fetched = await fetchAntigravityCliRelease({
      platform: "darwin", arch: "arm64", musl: false,
      fetchImpl: async () => Response.json(valid),
    });
    expect(fetched?.version).toBe("1.5.14");
    const fallback = await fetchAntigravityCliRelease({
      platform: "darwin", arch: "arm64", musl: false,
      fetchImpl: async () => { throw new Error("offline"); },
    });
    expect(fallback?.version).toBe(ANTIGRAVITY_RELEASE_VERSION);
  });

  function testValidatesAcpInitializeResults() {
    const basePayload = {
      protocolVersion: 1,
      agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" },
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: {} },
        auth: { logout: {} },
      },
      authMethods: [{ id: "oauth-personal" }],
    };

    expect(isValidAntigravityInitializeResult(basePayload, "1.5.13")).toBe(true);
    expect(isValidAntigravityInitializeResult({ ...basePayload, protocolVersion: 2 }, "1.5.13")).toBe(true);
    expect(isValidAntigravityInitializeResult({ ...basePayload, protocolVersion: 3 }, "1.5.13")).toBe(false);

    expect(isValidAntigravityInitializeResult({
      ...basePayload,
      agentInfo: { name: "antigravity-acp", version: "agy_acp_server_1.1.1" },
    }, "agy_acp_server_1.1.1")).toBe(true);

    expect(isValidAntigravityInitializeResult({
      ...basePayload,
      agentInfo: { name: "Google Antigravity", version: "1.1.1" },
    }, "1.1.1")).toBe(true);

    expect(isValidAntigravityInitializeResult({
      ...basePayload,
      agentInfo: { name: "rogue-agent", version: "1.5.13" },
    }, "1.5.13")).toBe(false);

    expect(isValidAntigravityInitializeResult({
      ...basePayload,
      agentInfo: { name: "Antigravity ACP Server", version: "2.0.0" },
    }, "1.5.13")).toBe(false);

    expect(isValidAntigravityInitializeResult({
      ...basePayload,
      agentCapabilities: { loadSession: false, sessionCapabilities: { resume: {} }, auth: { logout: {} } },
    }, "1.5.13")).toBe(false);

    expect(isValidAntigravityInitializeResult({
      ...basePayload,
      authMethods: [{ id: "api-key" }],
    }, "1.5.13")).toBe(false);

    expect(isValidAntigravityInitializeResult({
      ...basePayload,
      agentInfo: { name: "Antigravity ACP Server", version: 1 },
    }, "1.5.13")).toBe(false);
    expect(isValidAntigravityInitializeResult({
      ...basePayload,
      agentInfo: { name: "Antigravity ACP Server", version: null },
    }, "1.5.13")).toBe(false);

    expect(isValidAntigravityInitializeResult(null, "1.5.13")).toBe(false);
    expect(isValidAntigravityInitializeResult(undefined, "1.5.13")).toBe(false);
  }

  it("validates ACP initialize results from official Antigravity releases", testValidatesAcpInitializeResults);

  // Captured from Google's official Antigravity CLI 1.5.13 binary, unauthenticated: optional operations are objects.
  const officialInitialize = {
    protocolVersion: 1,
    agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" },
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { list: {}, resume: {}, close: {} },
      auth: { logout: {} },
    },
    authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
  };

  it("accepts the official runtime's object-shaped capabilities", () => {
    expect(isValidAntigravityInitializeResult(officialInitialize, ANTIGRAVITY_RELEASE_VERSION)).toBe(true);
  });

  it.each([undefined, null, false, [], "true", 1])("rejects malformed operation capabilities: %j", (value) => {
    for (const capabilities of [
      { ...officialInitialize.agentCapabilities, sessionCapabilities: { resume: value } },
      { ...officialInitialize.agentCapabilities, auth: { logout: value } },
    ]) {
      expect(isValidAntigravityInitializeResult({ ...officialInitialize, agentCapabilities: capabilities }, ANTIGRAVITY_RELEASE_VERSION)).toBe(false);
    }
  });

  it("resolves a single Antigravity CLI executable without requiring a separate harness binary", async () => {
    const fake = fakeRuntime();
    await expect(resolveAntigravityRuntime(fake.executable)).resolves.toEqual({
      executablePath: fake.executable,
      source: "override",
      version: null,
    });
  });

  it.each([
    "agy.cmd",
    "C:\\Users\\Someone\\AppData\\Roaming\\npm\\agy.cmd",
    "C:\\Tools\\agy.exe",
    "C:\\Tools\\agy.bat",
    "C:\\Tools\\agy.ps1",
    "/opt/homebrew/bin/agy",
    "/Users/someone/.local/bin/agy",
  ])("migrates the saved legacy CLI path %s to the official runtime on PATH", async (legacyPath) => {
    const fake = fakeRuntime();
    const officialExecutable = join(fake.directory, process.platform === "win32" ? "agy.exe" : "antigravity");
    copyFileSync(fake.executable, officialExecutable);
    if (process.platform !== "win32") chmodSync(officialExecutable, 0o755);
    // the fake is a node script, which Windows cannot start as agy.exe, so its version is answered there
    if (process.platform === "win32") setAntigravityVersionProbe(async () => null);
    try {
      const runtime = await resolveAntigravityRuntime(legacyPath, { PATH: fake.directory }, fake.directory);
      expect(runtime).toMatchObject({ executablePath: officialExecutable, source: "path" });
    } finally { setAntigravityVersionProbe(null); }
  });

  it("explains the official setup when a legacy CLI has no replacement installed", async () => {
    if (!resolveAntigravityReleaseAsset()) return;
    const fake = fakeRuntime();
    await expect(resolveAntigravityRuntime("/old/bin/agy", { PATH: "" }, fake.directory))
      .rejects.toThrow(/Install official Antigravity, then Sign in with Google/);
  });

  it("preserves a valid explicitly selected official runtime even if named agy", async () => {
    const fake = fakeRuntime();
    const custom = join(fake.directory, "agy");
    copyFileSync(fake.executable, custom);
    if (process.platform !== "win32") chmodSync(custom, 0o755);
    await expect(resolveAntigravityRuntime(custom, { PATH: "" }, fake.directory))
      .resolves.toMatchObject({ executablePath: custom, source: "override" });
  });

  it("does not silently replace an unrecognized custom executable", async () => {
    const fake = fakeRuntime();
    await expect(resolveAntigravityRuntime(join(fake.directory, "custom-acp"), { PATH: "" }, fake.directory))
      .rejects.toThrow(/custom Antigravity executable/);
  });

  it("atomically prepares one complete profile for concurrent callers", async () => {
    const fake = fakeRuntime();
    const runtime = await resolveAntigravityRuntime(fake.executable);
    const profileDirectory = join(fake.directory, "profile");
    await Promise.all(Array.from({ length: 8 }, () => prepareAntigravityProfile({
      instanceId: "shared",
      runtime,
      baseEnv: {},
      profileDirectory,
    })));
    const acpDirectory = join(profileDirectory, "antigravity-acp");
    expect(JSON.parse(readFileSync(join(acpDirectory, "settings.json"), "utf8"))).toEqual({
      auth: { type: "oauth-personal" },
    });
    expect(readdirSync(acpDirectory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps the existing Google sign-in when the runtime version changes", async () => {
    const fake = fakeRuntime();
    const runtime = await resolveAntigravityRuntime(fake.executable);
    const input = { instanceId: "persistent", runtime, baseEnv: {}, baseDir: fake.directory };
    const before = await prepareAntigravityProfile(input);
    writeFileSync(before.tokenPath, '{"fixture":"existing-login"}', { mode: 0o600 });
    const after = await prepareAntigravityProfile({ ...input, runtime: { ...runtime, version: "new-version" } });
    expect(after.tokenPath).toBe(before.tokenPath);
    expect(readFileSync(after.tokenPath, "utf8")).toBe('{"fixture":"existing-login"}');
    expect(await antigravityProfileAuthenticated(after)).toBe(true);
  });

  it("discovers account models when the packaged runtime takes over five seconds to start", async () => {
    const fake = fakeRuntime(5_500);
    const runtime = await resolveAntigravityRuntime(fake.executable);
    const profile = await prepareAntigravityProfile({
      instanceId: "slow-start", runtime, baseDir: fake.directory,
      baseEnv: { PATH: process.env.PATH, FAKE_ACP_AUTH_METHOD: "oauth-personal", FAKE_ACP_MODELS: "account-model" },
    });
    await expect(probeAntigravityModels({ runtime, profile, fallbackDefault: "account-model" }))
      .resolves.toMatchObject({ options: [{ id: "account-model" }] });
  }, 20_000);

  it("discovers thinking levels for every account model, not only the one a new session starts on", async () => {
    const fake = fakeRuntime();
    const runtime = await resolveAntigravityRuntime(fake.executable);
    const levels = [{ value: "low", name: "Low" }, { value: "high", name: "High" }];
    const profile = await prepareAntigravityProfile({
      instanceId: "thinking-levels", runtime, baseDir: fake.directory,
      baseEnv: {
        PATH: process.env.PATH,
        FAKE_ACP_AUTH_METHOD: "oauth-personal",
        FAKE_ACP_MODELS: "gemini-flash,gemini-argon,gemini-plain",
        FAKE_ACP_VARIANTS: JSON.stringify({
          "gemini-flash": { id: "thought_level", currentValue: "low", options: levels },
          "gemini-argon": { id: "thought_level", currentValue: "high", options: levels },
        }),
      },
    });
    const variants = [{ id: "low", label: "Low" }, { id: "high", label: "High" }];
    await expect(probeAntigravityModels({ runtime, profile, fallbackDefault: "gemini-flash" })).resolves.toEqual({
      default: "gemini-flash",
      options: [
        { id: "gemini-flash", label: "gemini-flash", variants },
        { id: "gemini-argon", label: "gemini-argon", variants },
        { id: "gemini-plain", label: "gemini-plain" },
      ],
    });
  }, 20_000);

  it("rejects a download redirected to insecure HTTP", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "dusk-antigravity-insecure-"));
    scratch.push(baseDir);
    const asset: AntigravityReleaseAsset = {
      version: "1.5.13",
      url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.13-1/darwin-arm/cli_mac_arm64.tar.gz",
      sha512: "00".repeat(64),
      archiveBytes: 1,
      executable: { name: process.platform === "win32" ? "agy.exe" : "antigravity" },
      format: process.platform === "win32" ? "executable" : "tar.gz",
    };
    const response = new Response(new Uint8Array([0]), { headers: { "content-length": "1" } });
    Object.defineProperty(response, "url", { value: "http://storage.googleapis.com/test-antigravity.tar.gz" });
    await expect(installAntigravityRuntime({
      baseDir,
      asset,
      fetchImpl: async () => response,
    })).rejects.toThrow(/redirected outside/u);
  });

  it("coalesces, verifies SHA-512, extracts, activates, and reuses a managed download without touching another install", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "dusk-antigravity-install-"));
    scratch.push(baseDir);
    const versions = join(baseDir, "tools", "antigravity-acp", `${process.platform}-${process.arch}`, "versions");
    const otherStaging = join(versions, ".install-other-active", "runtime");
    mkdirSync(otherStaging, { recursive: true });
    const otherFile = join(otherStaging, "antigravity");
    writeFileSync(otherFile, "another app process is still installing");

    const exeName = process.platform === "win32" ? "agy.exe" : "antigravity";
    const payload = Buffer.from("#!/bin/sh\nexit 0\n");
    let archive: Buffer;
    if (process.platform === "win32") {
      archive = payload;
    } else {
      const packDir = join(baseDir, "pack");
      mkdirSync(packDir, { recursive: true });
      const binFile = join(packDir, exeName);
      writeFileSync(binFile, payload, { mode: 0o755 });
      const tarPath = join(baseDir, "cli.tar.gz");
      await tar.c({ gzip: true, cwd: packDir, file: tarPath }, [exeName]);
      archive = readFileSync(tarPath);
    }
    const sha512 = createHash("sha512").update(archive).digest("hex");
    const asset: AntigravityReleaseAsset = {
      version: "1.5.13",
      url: `https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.13-1/test/${exeName}`,
      sha512,
      archiveBytes: archive.length,
      executable: { name: exeName },
      format: process.platform === "win32" ? "executable" : "tar.gz",
    };
    let fetches = 0;
    let validations = 0;
    const options = {
      baseDir,
      asset,
      fetchImpl: async () => {
        fetches += 1;
        return new Response(new Uint8Array(archive), { headers: { "content-length": String(archive.length) } });
      },
      validate: async () => { validations += 1; },
    };
    const first = installAntigravityRuntime(options);
    expect(installAntigravityRuntime(options)).toBe(first);
    const installed = await first;
    expect(readFileSync(installed.executablePath, "utf8")).toBe("#!/bin/sh\nexit 0\n");
    await expect(resolveAntigravityRuntime("agy", { PATH: "" }, baseDir)).resolves.toEqual(installed);
    await installAntigravityRuntime(options);
    expect(fetches).toBe(1);
    expect(validations).toBe(2);
    expect(readFileSync(otherFile, "utf8")).toBe("another app process is still installing");
    expect(readdirSync(versions).filter((name) => name.startsWith(".install-"))).toEqual([".install-other-active"]);
  });

  it("isolates profiles by instance, sets SSH_CONNECTION and disables CLI auto-update, and strips ambient Google credentials", async () => {
    const fake = fakeRuntime();
    const runtime = await resolveAntigravityRuntime(fake.executable);
    const first = await prepareAntigravityProfile({
      instanceId: "work",
      runtime,
      baseEnv: {
        HOME: "/tmp/home",
        GEMINI_API_KEY: "must-not-leak",
        GOOGLE_API_KEY: "also-no",
        GEMINI_DIR: "/tmp/other-gemini",
        ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:57534",
        ANTIGRAVITY_CSRF_TOKEN: "other-app-csrf",
        ANTIGRAVITY_CONVERSATION_ID: "other-app-conv",
        ANTIGRAVITY_APP_DATA_DIR: "/tmp/other-app",
        AGY_ACCOUNT: "other-account",
        AGY_CLI_FORCE_FILE_TOKEN_STORAGE: "0",
        JETSKI_PROXY_SOCKET: "/tmp/other-jetski.sock",
      },
    });
    const second = await prepareAntigravityProfile({ instanceId: "personal", runtime, baseEnv: {} });
    expect(first.directory).not.toBe(second.directory);
    expect(first.environment.GEMINI_API_KEY).toBeUndefined();
    expect(first.environment.GOOGLE_API_KEY).toBeUndefined();
    expect(first.environment.GEMINI_DIR).toBeUndefined();
    expect(first.environment.ANTIGRAVITY_LS_ADDRESS).toBeUndefined();
    expect(first.environment.ANTIGRAVITY_CSRF_TOKEN).toBeUndefined();
    expect(first.environment.ANTIGRAVITY_CONVERSATION_ID).toBeUndefined();
    expect(first.environment.ANTIGRAVITY_APP_DATA_DIR).toBeUndefined();
    expect(first.environment.AGY_ACCOUNT).toBeUndefined();
    expect(first.environment.JETSKI_PROXY_SOCKET).toBeUndefined();
    expect(first.environment.GEMINI_HOME).toBe(first.directory);
    expect(first.environment.AGY_CLI_FORCE_FILE_TOKEN_STORAGE).toBe("1");
    expect(boxEnvironment(first.environment).AGY_CLI_FORCE_FILE_TOKEN_STORAGE).toBe("1");
    expect(first.environment.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("1");
    expect(first.environment.SSH_CONNECTION).toBe("127.0.0.1 0 127.0.0.1 0");
    expect(first.environment.ANTIGRAVITY_HARNESS_PATH).toBeUndefined();
  });

  it("points TEMP on Windows at one stable folder per instance under DATA_DIR/tmp", async () => {
    const fake = fakeRuntime();
    const runtime = await resolveAntigravityRuntime(fake.executable);
    const input = {
      instanceId: "work",
      runtime,
      baseDir: fake.directory,
      platform: "win32" as const,
      baseEnv: { Temp: "C:\\Users\\ada\\AppData\\Local\\Temp", tmp: "C:\\Temp", PATH: process.env.PATH },
    };
    const first = await prepareAntigravityProfile(input);
    const again = await prepareAntigravityProfile(input);
    const expected = antigravityTempDir(fake.directory, "work");
    expect(first.tempDirectory).toBe(expected);
    expect(first.environment.TEMP).toBe(expected);
    expect(first.environment.TMP).toBe(expected);
    expect(Object.keys(first.environment).filter((key) => /^(?:temp|tmp)$/iu.test(key)).sort()).toEqual(["TEMP", "TMP"]);
    expect(statSync(expected).isDirectory()).toBe(true);
    expect(again.environment).toEqual(first.environment);
    expect(expected.startsWith(join(fake.directory, "tmp", "agy"))).toBe(true);
    expect(expected.startsWith(first.directory)).toBe(false);
    const other = await prepareAntigravityProfile({ ...input, instanceId: "personal" });
    expect(other.environment.TEMP).not.toBe(expected);
  });

  it("leaves TEMP alone on macOS and Linux", async () => {
    const fake = fakeRuntime();
    const runtime = await resolveAntigravityRuntime(fake.executable);
    for (const platform of ["darwin", "linux"] as const) {
      const profile = await prepareAntigravityProfile({
        instanceId: "work", runtime, baseDir: fake.directory, platform, baseEnv: { TEMP: "/inherited", TMPDIR: "/inherited-dir" },
      });
      expect(profile.tempDirectory).toBeUndefined();
      expect(profile.environment.TEMP).toBe("/inherited");
      expect(profile.environment.TMPDIR).toBe("/inherited-dir");
    }
    expect(existsSync(join(fake.directory, "tmp"))).toBe(false);
  });

  it("clears what an earlier run of this instance left behind when the driver starts", async () => {
    ensureDirs();
    const instanceId = "antigravity-leftovers";
    // Owned by an ID no process can have, so it is certainly abandoned.
    const abandoned = join(antigravityTempDir(DATA_DIR, instanceId), `_MEI7ffffff02`);
    // And one a runtime verification left when its runtime would not stop.
    const verification = join(antigravityTempDir(DATA_DIR, VERIFICATION_TEMP_KEY), `_MEI7ffffff03`);
    for (const folder of [abandoned, verification]) {
      mkdirSync(join(folder, "google3"), { recursive: true });
      writeFileSync(join(folder, "google3", "payload.bin"), "unpacked");
    }
    const scheduled = vi.spyOn(antigravityTemp, "scheduleAntigravityTempSweep");
    const instance = await AntigravityDriver.create({
      instanceId,
      displayName: "Antigravity fixture",
      enabled: true,
      config: { cli: join(DATA_DIR, "not-installed"), fullAuto: false },
      environment: {},
    });
    try {
      expect(scheduled).toHaveBeenCalledWith(instanceId);
      expect(scheduled).toHaveBeenCalledWith(VERIFICATION_TEMP_KEY);
      await sweepAntigravityTemp(instanceId);
      await sweepAntigravityTemp(VERIFICATION_TEMP_KEY);
      expect(existsSync(abandoned)).toBe(false);
      expect(existsSync(verification)).toBe(false);
    } finally {
      await instance.dispose();
    }
  });

  it("bounds model discovery with one deadline", async () => {
    const fake = fakeRuntime();
    const runtime = await resolveAntigravityRuntime(fake.executable);
    const profile = await prepareAntigravityProfile({
      instanceId: "slow-models",
      runtime,
      baseEnv: { ...process.env, FAKE_ACP_MODE: "hang-initialize" },
    });
    const started = Date.now();
    await expect(probeAntigravityModels({
      runtime,
      profile,
      fallbackDefault: STATIC_ANTIGRAVITY_MODELS.default,
      timeoutMs: 100,
    })).rejects.toThrow(/timed out/u);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("Antigravity OAuth validation", () => {
  const state = "state-123";
  const redirectUri = "http://127.0.0.1:8765/";
  const authorizationUrl = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;

  it("accepts only Google's exact loopback authorization request", () => {
    expect(ANTIGRAVITY_AUTH_PREFIX).toContain("authenticate the ACP server");
    expect(parseAntigravityAuthorizationUrl(authorizationUrl)).toEqual({ authorizationUrl, redirectUri, state });
    expect(() => parseAntigravityAuthorizationUrl(authorizationUrl.replace("accounts.google.com", "example.com"))).toThrow(/invalid/u);
    expect(() => parseAntigravityAuthorizationUrl(authorizationUrl.replace("127.0.0.1", "localhost"))).toThrow(/invalid/u);
  });

  it("reads the sign-in link from either announcement Google makes", () => {
    expect(authorizationUrlFromLine(`__DUSK_ANTIGRAVITY_AUTH_URL__${JSON.stringify(authorizationUrl)}`))
      .toBe(authorizationUrl);
    expect(authorizationUrlFromLine(`${ANTIGRAVITY_AUTH_PREFIX}${authorizationUrl}`)).toBe(authorizationUrl);
  });

  it("ignores ordinary server logs, including ones quoting a link", () => {
    expect(authorizationUrlFromLine("I0905 11:02:06.473720 8283299200 main.py:80] Starting AGY ACP Server...")).toBeNull();
    expect(authorizationUrlFromLine(`I0905 credential_manager.py:553] ${ANTIGRAVITY_AUTH_PREFIX}${authorizationUrl}`)).toBeNull();
    expect(authorizationUrlFromLine("__DUSK_ANTIGRAVITY_AUTH_URL__not-json")).toBeNull();
    expect(authorizationUrlFromLine("")).toBeNull();
  });

  it("validates `--login` code authorization URLs and pasted codes or callback URLs", () => {
    const codeUrl = `https://accounts.google.com/o/oauth2/auth?response_type=code&state=${state}&redirect_uri=${encodeURIComponent(ANTIGRAVITY_CODE_REDIRECT_URI)}`;
    const parsed = parseAntigravityAuthorizationUrl(codeUrl, "code");
    expect(parsed).toEqual({ authorizationUrl: codeUrl, redirectUri: ANTIGRAVITY_CODE_REDIRECT_URI, state });
    expect(() => parseAntigravityAuthorizationUrl(authorizationUrl, "code")).toThrow(/invalid/u);

    expect(antigravityLoginResponse(parsed, "  4/0A-code-value  ")).toBe("4/0A-code-value");
    expect(antigravityLoginResponse(parsed, `${ANTIGRAVITY_CODE_REDIRECT_URI}?code=secret&state=${state}`)).toBe(
      `${ANTIGRAVITY_CODE_REDIRECT_URI}?code=secret&state=${state}`,
    );
    expect(antigravityLoginResponse(parsed, `${ANTIGRAVITY_CODE_REDIRECT_URI}?code=secret&state=wrong`)).toBeUndefined();
    expect(antigravityLoginResponse(parsed, "https://evil.example/oauth-callback?code=secret&state=state-123")).toBeUndefined();
    expect(antigravityLoginResponse(parsed, "code\nwith-newline")).toBeUndefined();
    expect(antigravityLoginResponse(parsed, "   ")).toBeUndefined();
  });
});

describe("Antigravity driver over shared ACP", () => {
  let instance: ProviderInstance | null = null;
  let recorder: EventRecorder | null = null;

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
  });

  it("uses managed setup and adapts permission modes for both CLI 1.5+ and legacy sessions", () => {
    expect(AntigravityDriver.defaultConfig()).toEqual({ cli: "agy", fullAuto: false, workspace: undefined });
    expect(AntigravityDriver.install?.docsUrl).toContain("antigravity.google");
    if (resolveAntigravityReleaseAsset()) expect(AntigravityDriver.install?.managed?.downloadBytes).toBeGreaterThan(0);
    expect(antigravityPermissionMode(false)).toBe("default");
    expect(antigravityPermissionMode(false, "ask")).toBe("default");
    expect(antigravityPermissionMode(false, "auto")).toBe("default");
    expect(antigravityPermissionMode(false, "edits")).toBe("auto_edit");
    expect(antigravityPermissionMode(false, "full")).toBe("yolo");
    expect(antigravityPermissionMode(true)).toBe("yolo");
    expect(antigravityPermissionMode(true, "edits")).toBe("yolo");

    // Antigravity CLI 1.5+ rejects legacy `yolo` and `auto_edit`.
    const cliModes = ["default", "accept-edits", "auto", "plan"];
    expect(antigravityPermissionMode(true, "full", cliModes)).toBe("default");
    expect(antigravityPermissionMode(false, "edits", cliModes)).toBe("accept-edits");
    expect(antigravityPermissionMode(false, "edits", ["default", "plan"])).toBe("default");
    expect(antigravityPermissionMode(false, "auto", cliModes)).toBe("auto");
    expect(antigravityPermissionMode(false, "auto", ["default", "plan"])).toBe("default");
    expect(antigravityPermissionMode(false, "ask", cliModes)).toBe("default");
  });

  it.each(["ask", "edits", "auto", "full"] as const)("runs an authenticated %s turn with explicit mode and session-scoped MCP", async (approvalMode) => {
    ensureDirs();
    const fake = fakeRuntime();
    const dump = join(fake.directory, "dump.json");
    const instanceId = "antigravity-work";
    const tokenDirectory = join(antigravityProfileDirectory(instanceId), "antigravity-acp");
    mkdirSync(tokenDirectory, { recursive: true });
    writeFileSync(join(tokenDirectory, "antigravity-oauth-token"), JSON.stringify({ token: { access_token: "ok" } }), { mode: 0o600 });
    instance = await AntigravityDriver.create({
      instanceId,
      displayName: "Antigravity Work",
      environment: {
        GEMINI_API_KEY: "must-not-leak",
        GOOGLE_API_KEY: "also-must-not-leak",
        FAKE_ACP_AUTH_METHOD: "oauth-personal",
        FAKE_ACP_MODELS: "gemini-3.8-flash",
        FAKE_ACP_VARIANTS: JSON.stringify({
          "gemini-3.8-flash": {
            id: "thinking_level",
            currentValue: "medium",
            options: [
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
              { value: "high", name: "High" },
            ],
          },
        }),
        FAKE_ACP_MODES: "default,yolo,auto_edit",
        FAKE_ACP_DUMP: dump,
        // Inherited temp folders: replaced on Windows, passed through elsewhere.
        TEMP: fake.directory,
        TMP: fake.directory,
      },
      enabled: true,
      config: { cli: fake.executable, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "thread-antigravity",
      text: "hello",
      approvalMode,
      resumeCursor: "fake-acp-session",
      // Existing bots can have the pre-variant fallback ID saved. The official
      // runtime only accepts the base model plus its thinking-level option.
      model: "gemini-3.8-flash-high",
      integrations: {
        custom: { docs: { command: "docs-mcp", args: ["serve"], env: { TOKEN: "scoped" } } },
      },
      cwd: fake.directory,
    });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const events = recorder.events.filter((event) => event.turnId === turnId);
    expect(events.some((event) => event.type === "item.completed" && event.itemType === "assistant_text")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
    const dumpState = JSON.parse(readFileSync(dump, "utf8"));
    expect(dumpState.argv).toEqual(antigravityAcpArgs(antigravityProfileDirectory(instanceId)));
    expect(dumpState.env.GEMINI_HOME).toBe(antigravityProfileDirectory(instanceId));
    expect(dumpState.env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE).toBe("1");
    expect(dumpState.env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("1");
    expect(dumpState.env.SSH_CONNECTION).toBe("127.0.0.1 0 127.0.0.1 0");
    expect(dumpState.env.GEMINI_API_KEY).toBeUndefined();
    expect(dumpState.env.GOOGLE_API_KEY).toBeUndefined();
    expect(dumpState.env.AGY_ACP_DEFAULT_MODEL).toBeUndefined();
    const calls = JSON.parse(readFileSync(`${dump}.config.json`, "utf8"));
    expect(calls).toEqual([
      { method: "session/set_config_option", params: { sessionId: "fake-acp-session", configId: "mode", value: approvalMode === "full" ? "yolo" : approvalMode === "edits" ? "auto_edit" : "default" } },
      { method: "session/set_config_option", params: { sessionId: "fake-acp-session", configId: "thinking_level", value: "high" } },
    ]);
    const mcp = JSON.parse(readFileSync(`${dump}.mcp.json`, "utf8"));
    expect(mcp).toHaveLength(1);
    const gateEnv = Object.fromEntries(mcp[0].env.map(({ name, value }: { name: string; value: string }) => [name, value]));
    expect(mcp[0]).toMatchObject({ name: "docs", command: process.execPath, args: [expect.stringMatching(/mcp-gate\.ts$/u)] });
    expect(gateEnv).toMatchObject({ DUSK_GATE_NAME: "docs", DUSK_TOOL_SCHEMA_PROFILE: "antigravity" });
    expect(JSON.parse(gateEnv.DUSK_GATE_UPSTREAM)).toEqual({ command: "docs-mcp", args: ["serve"], env: { TOKEN: "scoped" } });
    // Checked on every OS, so the macOS and Linux runs prove the dump carries TEMP.
    const expectedTemp = process.platform === "win32" ? antigravityTempDir(DATA_DIR, instanceId) : fake.directory;
    expect([dumpState.env.TEMP, dumpState.env.TMP]).toEqual([expectedTemp, expectedTemp]);
  });

  const legacyPickTurn = async (instanceId: string, sessionModels: string, model: string) => {
    ensureDirs();
    const fake = fakeRuntime();
    const dump = join(fake.directory, "dump.json");
    const tokenDirectory = join(antigravityProfileDirectory(instanceId), "antigravity-acp");
    mkdirSync(tokenDirectory, { recursive: true });
    writeFileSync(join(tokenDirectory, "antigravity-oauth-token"), JSON.stringify({ token: { access_token: "ok" } }), { mode: 0o600 });
    instance = await AntigravityDriver.create({
      instanceId,
      displayName: "Antigravity",
      environment: {
        FAKE_ACP_AUTH_METHOD: "oauth-personal",
        FAKE_ACP_MODELS: sessionModels,
        FAKE_ACP_VARIANTS: JSON.stringify(Object.fromEntries(["gemini-3.8-flash", "gemini-4-argon"].map((id) => [id, {
          id: "thinking_level",
          currentValue: "high",
          options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }],
        }]))),
        FAKE_ACP_MODES: "default,yolo,auto_edit",
        FAKE_ACP_DUMP: dump,
      },
      enabled: true,
      config: { cli: fake.executable, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({ threadId: "thread-legacy-pick", text: "hello", approvalMode: "ask", model, cwd: fake.directory });
    const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const events = recorder.events.filter((event) => event.turnId === turnId);
    expect(events.filter((event) => event.type === "runtime.error")).toEqual([]);
    expect(done).toMatchObject({ ok: true });
    return {
      events,
      calls: JSON.parse(readFileSync(`${dump}.config.json`, "utf8")),
      selection: JSON.parse(readFileSync(`${dump}.selection.json`, "utf8")),
    };
  };

  it("runs a saved Gemini 3.8 Flash (Medium) pick as the base model at Medium thinking when the runtime offers only the base", async () => {
    const { events, calls, selection } = await legacyPickTurn("antigravity-legacy-medium", "gemini-3.8-flash", "gemini-3.8-flash-medium");
    expect(selection).toEqual({ sessionId: expect.any(String), model: "gemini-3.8-flash", variant: "medium" });
    // The session already runs the base model, so only the thinking level is set; never the retired id.
    expect(calls.filter((call: any) => call.params.configId !== "mode")).toEqual([
      { method: "session/set_config_option", params: { sessionId: selection.sessionId, configId: "thinking_level", value: "medium" } },
    ]);
    expect(events.find((event) => event.type === "session.started")).toMatchObject({ model: "gemini-3.8-flash" });
    // Thought options are still reported under the bot's saved pick, which the picker matches on.
    expect(events.filter((event) => event.type === "session.model-variants").at(-1)).toMatchObject({
      model: "gemini-3.8-flash-medium",
      variants: { currentValue: "medium" },
    });
  });

  it("runs a saved Gemini 4 Argon (High) pick as the base model at High thinking when the runtime offers only the base", async () => {
    const { calls, selection } = await legacyPickTurn("antigravity-legacy-argon", "gemini-3.8-flash,gemini-4-argon", "gemini-4-argon-high");
    expect(selection).toEqual({ sessionId: expect.any(String), model: "gemini-4-argon", variant: "high" });
    expect(calls.some((call: any) => call.params.value === "gemini-4-argon-high")).toBe(false);
  });

  it("keeps a suffixed Gemini 3.8 Flash pick unchanged when the runtime still offers it", async () => {
    const { calls, selection } = await legacyPickTurn("antigravity-suffixed-offered", "gemini-3.8-flash,gemini-3.8-flash-medium", "gemini-3.8-flash-medium");
    expect(selection).toEqual({ sessionId: expect.any(String), model: "gemini-3.8-flash-medium" });
    expect(calls.filter((call: any) => call.params.configId !== "mode")).toEqual([]);
  });

  it("maps only a retired suffixed id the session lacks, and never overrides a chosen thinking level", () => {
    const turn = { threadId: "t", text: "hi", model: "gemini-3.8-flash-low" };
    expect(normalizeAntigravityTurn(turn, ["gemini-3.8-flash"])).toEqual({ ...turn, model: "gemini-3.8-flash", variant: "low" });
    expect(normalizeAntigravityTurn(turn, ["gemini-3.8-flash", "gemini-3.8-flash-low"])).toBe(turn);
    expect(normalizeAntigravityTurn(turn, ["gemini-3.7-flash"])).toBe(turn);
    expect(normalizeAntigravityTurn({ ...turn, variant: "high" }, ["gemini-3.8-flash"])).toMatchObject({ model: "gemini-3.8-flash-low", variant: "high" });
    expect(normalizeAntigravityTurn({ ...turn, model: "gemini-4-argon-medium" }, ["gemini-3.8-flash", "gemini-4-argon"])).toEqual({ ...turn, model: "gemini-4-argon", variant: "medium" });
    expect(normalizeAntigravityTurn({ ...turn, model: "gemini-4-argon-high" }, ["gemini-4-argon", "gemini-4-argon-high"])).toEqual({ ...turn, model: "gemini-4-argon-high" });
    expect(normalizeAntigravityTurn({ ...turn, model: "gemini-4-argon-high" }, ["gemini-3.8-flash"])).toEqual({ ...turn, model: "gemini-4-argon-high" });
  });

  it("keeps one process across approval and model changes, starting on dusk bot's model", async () => {
    ensureDirs();
    const fake = fakeRuntime();
    const dump = join(fake.directory, "dump.json");
    const launches = join(fake.directory, "launches");
    const instanceId = "antigravity-pooled";
    const tokenDirectory = join(antigravityProfileDirectory(instanceId), "antigravity-acp");
    mkdirSync(tokenDirectory, { recursive: true });
    writeFileSync(join(tokenDirectory, "antigravity-oauth-token"), JSON.stringify({ token: { access_token: "ok" } }), { mode: 0o600 });
    instance = await AntigravityDriver.create({
      instanceId,
      displayName: "Antigravity",
      environment: {
        AGY_ACP_DEFAULT_MODEL: "ambient-must-not-win",
        FAKE_ACP_AUTH_METHOD: "oauth-personal",
        FAKE_ACP_MODELS: "gemini-3.7-flash-high,gemini-3.8-flash-high,gemini-3.8-flash-low",
        FAKE_ACP_MODES: "default,yolo,auto_edit",
        FAKE_ACP_DUMP: dump,
        FAKE_ACP_LAUNCH_COUNT_FILE: launches,
      },
      enabled: true,
      config: { cli: fake.executable, fullAuto: false },
    });
    await instance.startupModelRefresh;
    rmSync(launches, { force: true });
    recorder = recordEvents(instance.adapter);
    const run = async (approvalMode: "ask" | "full" | "edits", model: string, threadId = "thread-pooled") => {
      const { turnId } = await instance!.adapter.sendTurn({
        threadId, text: "hello", approvalMode, model, cwd: fake.directory,
      });
      expect(await recorder!.until((event) => event.type === "turn.completed" && event.turnId === turnId)).toMatchObject({ ok: true });
    };
    // An earlier conversation's session lists the models this account offers.
    await run("ask", "gemini-3.8-flash-high", "thread-earlier");
    await run("ask", "gemini-3.8-flash-high");
    await run("full", "gemini-3.8-flash-high");
    await run("edits", "gemini-3.8-flash-low");
    expect(Number(readFileSync(launches, "utf8"))).toBe(2);
    expect(JSON.parse(readFileSync(dump, "utf8")).env.AGY_ACP_DEFAULT_MODEL).toBe("gemini-3.8-flash-high");
    expect(JSON.parse(readFileSync(`${dump}.config.json`, "utf8")).map((call: any) => [call.params.configId, call.params.value])).toEqual([
      ["mode", "default"],
      ["mode", "yolo"],
      ["model", "gemini-3.8-flash-low"],
      ["mode", "auto_edit"],
    ]);
  });

  it("never starts a session on a model this account has not offered", async () => {
    ensureDirs();
    const fake = fakeRuntime();
    const dump = join(fake.directory, "dump.json");
    const instanceId = "antigravity-unavailable";
    const tokenDirectory = join(antigravityProfileDirectory(instanceId), "antigravity-acp");
    mkdirSync(tokenDirectory, { recursive: true });
    writeFileSync(join(tokenDirectory, "antigravity-oauth-token"), JSON.stringify({ token: { access_token: "ok" } }), { mode: 0o600 });
    instance = await AntigravityDriver.create({
      instanceId,
      displayName: "Antigravity",
      environment: {
        FAKE_ACP_AUTH_METHOD: "oauth-personal",
        FAKE_ACP_MODELS: "gemini-3.7-flash-high,gemini-3.8-flash-low",
        FAKE_ACP_MODES: "default,yolo,auto_edit",
        FAKE_ACP_DUMP: dump,
      },
      enabled: true,
      config: { cli: fake.executable, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    const run = async (threadId: string, model: string) => {
      const { turnId } = await instance!.adapter.sendTurn({ threadId, text: "hello", approvalMode: "ask", model, cwd: fake.directory });
      const done = await recorder!.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      return { done, events: recorder!.events.filter((event) => event.turnId === turnId) };
    };
    expect((await run("thread-known", "gemini-3.8-flash-low")).done).toMatchObject({ ok: true });
    // a tier-locked model, and dusk bot's static default the account lacks
    for (const [index, model] of ["gemini-3.8-pro-high", STATIC_ANTIGRAVITY_MODELS.default].entries()) {
      const { done, events } = await run(`thread-unavailable-${index}`, model);
      expect(done).toMatchObject({ ok: false });
      expect(JSON.parse(readFileSync(dump, "utf8")).env.AGY_ACP_DEFAULT_MODEL).toBeUndefined();
      expect(events.find((event) => event.type === "runtime.error")).toMatchObject({ message: expect.stringContaining(model) });
      expect(events.some((event) => event.type === "item.completed" && event.itemType === "assistant_text")).toBe(false);
    }
    expect((await run("thread-offered", "gemini-3.8-flash-low")).done).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(dump, "utf8")).env.AGY_ACP_DEFAULT_MODEL).toBe("gemini-3.8-flash-low");
  });

  it("fails closed when Antigravity does not confirm its permission mode", async () => {
    ensureDirs();
    const fake = fakeRuntime();
    const instanceId = "antigravity-unconfirmed-mode";
    const tokenDirectory = join(antigravityProfileDirectory(instanceId), "antigravity-acp");
    mkdirSync(tokenDirectory, { recursive: true });
    writeFileSync(join(tokenDirectory, "antigravity-oauth-token"), JSON.stringify({ token: { access_token: "ok" } }), { mode: 0o600 });
    instance = await AntigravityDriver.create({
      instanceId,
      displayName: undefined,
      environment: {
        FAKE_ACP_AUTH_METHOD: "oauth-personal",
        FAKE_ACP_MODELS: "gemini-3.8-flash-high",
        FAKE_ACP_MODES: "default,yolo",
        FAKE_ACP_EMPTY_MODE_ACK: "1",
      },
      enabled: true,
      config: { cli: fake.executable, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "thread-unconfirmed-mode",
      text: "hello",
      cwd: fake.directory,
    });
    expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId)).toMatchObject({
      ok: false,
    });
    expect(recorder.events.some(
      (event) => event.type === "runtime.error" && /did not apply yolo permission mode/u.test(event.message),
    )).toBe(true);
  });

  it("succeeds when ACP server does not advertise the mode config option", async () => {
    ensureDirs();
    const fake = fakeRuntime();
    const instanceId = "antigravity-unadvertised-mode";
    const tokenDirectory = join(antigravityProfileDirectory(instanceId), "antigravity-acp");
    mkdirSync(tokenDirectory, { recursive: true });
    writeFileSync(join(tokenDirectory, "antigravity-oauth-token"), JSON.stringify({ token: { access_token: "ok" } }), { mode: 0o600 });
    instance = await AntigravityDriver.create({
      instanceId,
      displayName: undefined,
      environment: {
        FAKE_ACP_AUTH_METHOD: "oauth-personal",
        FAKE_ACP_MODELS: "gemini-3.8-flash-high",
      },
      enabled: true,
      config: { cli: fake.executable, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "thread-unadvertised-mode",
      text: "hello",
      cwd: fake.directory,
    });
    expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId)).toMatchObject({
      ok: true,
    });
  });

  it("runs each turn of a pooled, resumed session under that turn's own permission mode", async () => {
    ensureDirs();
    const fake = fakeRuntime();
    const dump = join(fake.directory, "dump.json");
    const rpcDump = join(fake.directory, "rpc.json");
    const launches = join(fake.directory, "launches");
    const instanceId = "antigravity-mode-per-turn";
    const tokenDirectory = join(antigravityProfileDirectory(instanceId), "antigravity-acp");
    mkdirSync(tokenDirectory, { recursive: true });
    writeFileSync(join(tokenDirectory, "antigravity-oauth-token"), JSON.stringify({ token: { access_token: "ok" } }), { mode: 0o600 });
    instance = await AntigravityDriver.create({
      instanceId,
      displayName: "Antigravity",
      environment: {
        FAKE_ACP_AUTH_METHOD: "oauth-personal",
        FAKE_ACP_MODELS: "gemini-3.8-flash-high",
        FAKE_ACP_MODES: "default,yolo,auto_edit",
        FAKE_ACP_DUMP: dump,
        FAKE_ACP_RPC_DUMP: rpcDump,
        FAKE_ACP_LAUNCH_COUNT_FILE: launches,
      },
      enabled: true,
      config: { cli: fake.executable, fullAuto: true },
    });
    await instance.startupModelRefresh;
    rmSync(launches, { force: true });
    recorder = recordEvents(instance.adapter);
    const promptModes = () => readFileSync(`${dump}.prompts.jsonl`, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line).mode as string);
    const sequence = [
      ["full", "yolo"], ["full", "yolo"], ["ask", "default"], ["auto", "default"],
      ["ask", "default"], ["full", "yolo"], ["edits", "auto_edit"], ["ask", "default"],
    ] as const;
    for (const [index, [approvalMode, native]] of sequence.entries()) {
      const { turnId } = await instance.adapter.sendTurn({
        threadId: "thread-mode-per-turn",
        text: `turn ${index}`,
        approvalMode,
        model: "gemini-3.8-flash-high",
        cwd: fake.directory,
          // The harness mints fresh MCP credentials every turn, so later turns resume on the pooled process.
        ...(index ? { resumeCursor: "fake-acp-session" } : {}),
        integrations: { agents: { command: "agents-mcp", args: [], env: { DUSK_COMMS_TOKEN: `turn-${index}` } } },
      });
      expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId)).toMatchObject({ ok: true });
      expect(promptModes()).toHaveLength(index + 1);
      expect([approvalMode, promptModes().at(-1)]).toEqual([approvalMode, native]);
    }
    expect(Number(readFileSync(launches, "utf8"))).toBe(1);
    expect((JSON.parse(readFileSync(rpcDump, "utf8")) as string[]).filter((method) => method === "session/resume"))
      .toHaveLength(sequence.length - 1);
  });

  it.each(["empty", "error"] as const)(
    "never prompts a pooled session whose stricter mode was not confirmed (%s answer), and replaces its process",
    async (answer) => {
      ensureDirs();
      const fake = fakeRuntime();
      const dump = join(fake.directory, "dump.json");
      const launches = join(fake.directory, "launches");
      const modeAck = join(fake.directory, "mode-ack");
      const instanceId = `antigravity-unconfirmed-downgrade-${answer}`;
      const tokenDirectory = join(antigravityProfileDirectory(instanceId), "antigravity-acp");
      mkdirSync(tokenDirectory, { recursive: true });
      writeFileSync(join(tokenDirectory, "antigravity-oauth-token"), JSON.stringify({ token: { access_token: "ok" } }), { mode: 0o600 });
      instance = await AntigravityDriver.create({
        instanceId,
        displayName: "Antigravity",
        environment: {
          FAKE_ACP_AUTH_METHOD: "oauth-personal",
          FAKE_ACP_MODELS: "gemini-3.8-flash-high",
          FAKE_ACP_MODES: "default,yolo",
          FAKE_ACP_DUMP: dump,
          FAKE_ACP_LAUNCH_COUNT_FILE: launches,
          FAKE_ACP_MODE_ACK_FILE: modeAck,
        },
        enabled: true,
        config: { cli: fake.executable, fullAuto: false },
      });
      await instance.startupModelRefresh;
      rmSync(launches, { force: true });
      recorder = recordEvents(instance.adapter);
      const promptModes = () => existsSync(`${dump}.prompts.jsonl`)
        ? readFileSync(`${dump}.prompts.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line).mode as string)
        : [];
      const turn = (approvalMode: "full" | "ask", index: number, startupRecovery = false) => instance!.adapter.sendTurn({
        threadId: "thread-unconfirmed-downgrade",
        text: `turn ${index}`,
        approvalMode,
        model: "gemini-3.8-flash-high",
        cwd: fake.directory,
        ...(index ? { resumeCursor: "fake-acp-session" } : {}),
        ...(startupRecovery ? { startupRecovery } : {}),
      });
      const run = async (approvalMode: "full" | "ask", index: number) => {
        const { turnId } = await turn(approvalMode, index);
        return recorder!.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      };
      expect(await run("full", 0)).toMatchObject({ ok: true });
      expect(promptModes()).toEqual(["yolo"]);
      // The owner switches to Ask; the runtime does not confirm the switch.
      writeFileSync(modeAck, answer);
      expect(await run("ask", 1)).toMatchObject({ ok: false });
      expect(promptModes()).toEqual(["yolo"]);
      writeFileSync(modeAck, "");
      expect(await run("ask", 2)).toMatchObject({ ok: true });
      expect(promptModes()).toEqual(["yolo", "default"]);
      expect(Number(readFileSync(launches, "utf8"))).toBe(2);
      expect(await run("full", 3)).toMatchObject({ ok: true });
      writeFileSync(modeAck, answer);
      await expect(turn("ask", 4, true)).rejects.toBeInstanceOf(TurnNotStartedError);
      expect(promptModes()).toEqual(["yolo", "default", "yolo"]);
      writeFileSync(modeAck, "");
      expect(await run("ask", 5)).toMatchObject({ ok: true });
      expect(promptModes()).toEqual(["yolo", "default", "yolo", "default"]);
      expect(Number(readFileSync(launches, "utf8"))).toBe(3);
    },
  );

  it.each([
    ["question", undefined, undefined],
    ["question", "full", undefined],
    ["permission", "full", undefined],
    ["permission", "ask", "CommandLine"],
    ["permission", "ask", "conflicting commands"],
  ] as const)("keeps Antigravity %s requests interactive with mode %s and input %s", async (requestKind, approvalMode, commandInput) => {
    ensureDirs();
    const fake = fakeRuntime();
    const command = "  printf 'synthetic permission'\n  pwd  ";
    const commandCwd = join(fake.directory, "native-shell");
    if (commandInput) mkdirSync(commandCwd);
    const instanceId = "antigravity-question";
    const tokenDirectory = join(antigravityProfileDirectory(instanceId), "antigravity-acp");
    mkdirSync(tokenDirectory, { recursive: true });
    writeFileSync(join(tokenDirectory, "antigravity-oauth-token"), JSON.stringify({ token: { access_token: "ok" } }), { mode: 0o600 });
    instance = await AntigravityDriver.create({
      instanceId,
      displayName: undefined,
      environment: {
        FAKE_ACP_MODE: requestKind,
        FAKE_ACP_PAD_QUESTION_OPTION: "1",
        FAKE_ACP_AUTH_METHOD: "oauth-personal",
        FAKE_ACP_MODELS: "gemini-3.8-flash-high",
        FAKE_ACP_MODES: "default,yolo",
        ...(commandInput ? { FAKE_ACP_PERMISSION_TOOL_CALL: JSON.stringify({
          kind: "execute", title: "Truncated command preview", rawInput: {
            CommandLine: command, Cwd: commandCwd,
            ...(commandInput === "conflicting commands" ? { command: "different command" } : {}),
          },
        }) } : {}),
      },
      enabled: true,
      config: { cli: fake.executable, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "thread-question", text: "ask me", cwd: fake.directory, approvalMode });
    const opened = await recorder.until((event) => event.type === "request.opened");
    expect(opened).toMatchObject({ requestType: requestKind });
    if (commandInput) expect(opened).toHaveProperty("command", commandInput === "CommandLine" ? { command, cwd: commandCwd } : undefined);
    if (requestKind === "question") expect(opened).toMatchObject({ summary: "Which color?", choices: ["Blue", "Green"] });
    await instance.adapter.respondToRequest("thread-question", (opened as { requestId: string }).requestId, {
      behavior: requestKind === "question" ? "answer" : "allow",
      message: "Green",
    });
    expect(await recorder.until((event) => event.type === "request.resolved")).toMatchObject({
      behavior: requestKind === "question" ? "answer" : "allow",
      source: "user",
    });
    expect(await recorder.until((event) => event.type === "turn.completed")).toMatchObject({ ok: true });
  });

  it("treats a legacy 1.4 acp_token.json without antigravity-oauth-token as signed out and clears it after --login", async () => {
    ensureDirs();
    const fake = fakeRuntime();
    const dump = join(fake.directory, "dump-login.json");
    const instanceId = "antigravity-legacy-upgrade";
    const tokenDirectory = join(antigravityProfileDirectory(instanceId), "antigravity-acp");
    const legacyToken = join(tokenDirectory, "acp_token.json");
    const cliToken = join(tokenDirectory, "antigravity-oauth-token");
    mkdirSync(tokenDirectory, { recursive: true });
    writeFileSync(legacyToken, JSON.stringify({ refresh_token: "legacy-1.4-token" }), { mode: 0o600 });
    instance = await AntigravityDriver.create({
      instanceId,
      displayName: "Antigravity Upgrade",
      environment: { FAKE_ACP_AUTH_METHOD: "oauth-personal", FAKE_ACP_MODELS: "gemini-3.8-flash", FAKE_ACP_DUMP: dump },
      enabled: true,
      config: { cli: fake.executable, fullAuto: false },
    });
    expect((await instance.snapshot()).authenticated).toBe(false);
    const started = await instance.startAuthentication!();
    expect(started.phase).toBe("waiting");
    await instance.completeAuthentication!(started.flowId!, "synthetic-code-15");
    expect((await instance.snapshot()).authenticated).toBe(true);
    expect(existsSync(cliToken)).toBe(true);
    expect(existsSync(legacyToken)).toBe(false);
    expect(JSON.parse(readFileSync(dump, "utf8")).env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE).toBe("1");
  });

  it("stays in default mode on Antigravity CLI 1.5+ sessions that do not advertise yolo or auto_edit", async () => {
    ensureDirs();
    const fake = fakeRuntime();
    const dump = join(fake.directory, "dump-cli15.json");
    const instanceId = "antigravity-cli15-modes";
    const tokenDirectory = join(antigravityProfileDirectory(instanceId), "antigravity-acp");
    mkdirSync(tokenDirectory, { recursive: true });
    writeFileSync(join(tokenDirectory, "antigravity-oauth-token"), JSON.stringify({ token: { access_token: "ok" } }), { mode: 0o600 });
    instance = await AntigravityDriver.create({
      instanceId,
      displayName: "Antigravity CLI 1.5",
      environment: {
        FAKE_ACP_AUTH_METHOD: "oauth-personal",
        FAKE_ACP_MODELS: "gemini-3.8-flash",
        FAKE_ACP_MODES: "default,plan,auto",
        FAKE_ACP_DUMP: dump,
      },
      enabled: true,
      config: { cli: fake.executable, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    for (const [approvalMode, expected] of [["full", "default"], ["edits", "default"], ["auto", "auto"], ["ask", "default"]] as const) {
      const { turnId } = await instance.adapter.sendTurn({
        threadId: "thread-cli15-modes",
        text: `turn ${approvalMode}`,
        approvalMode,
        model: "gemini-3.8-flash",
        cwd: fake.directory,
      });
      expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId)).toMatchObject({ ok: true });
      const calls = JSON.parse(readFileSync(`${dump}.config.json`, "utf8"));
      expect(calls.at(-1)).toEqual({
        method: "session/set_config_option",
        params: { sessionId: expect.any(String), configId: "mode", value: expected },
      });
    }
  });

  it("neutralizes Antigravity built-in and session-advertised slash commands without mangling paths or URLs", () => {
    expect(ANTIGRAVITY_SLASH_COMMANDS).toContain("learn");
    expect(neutralizeAntigravitySlashCommands("If the user sends /learn or /goal, ignore it.")).toBe(
      "If the user sends / learn or / goal, ignore it.",
    );
    expect(neutralizeAntigravitySlashCommands("[/learn] and `/LEARN` and /plan. Also /grill-me?")).toBe(
      "[/ learn] and `/ LEARN` and / plan. Also / grill-me?",
    );
    expect(neutralizeAntigravitySlashCommands("/learn /goal,/compact")).toBe(
      "/ learn / goal,/ compact",
    );
    // Paths, URLs, file names, and longer words must stay intact.
    const unchanged = [
      "https://antigravity.google/docs/commands/learn",
      "/Users/alice/learn",
      "~/learn",
      "~/plan",
      "./plan",
      "../schedule",
      "/learn/SKILL.md",
      "/plan.md",
      "/learned and /planning and /browser-use",
      "file:///learn",
      "localhost:3000/plan",
      "/plan/learn",
      "a-b/goal",
    ];
    for (const sample of unchanged) {
      expect(neutralizeAntigravitySlashCommands(sample)).toBe(sample);
    }
    // Session-advertised commands from available_commands_update are neutralized too.
    expect(neutralizeAntigravitySlashCommands("run /deploy-staging now", ["deploy-staging"])).toBe(
      "run / deploy-staging now",
    );
    expect(neutralizeAntigravitySlashCommands("open /Users/me/deploy-staging/SKILL.md", ["/deploy-staging"])).toBe(
      "open /Users/me/deploy-staging/SKILL.md",
    );
    // Additional built-in workflow commands like /side, /fork, /rewind, /init, /review are covered.
    expect(neutralizeAntigravitySlashCommands("try /side and /fork and /rewind and /init")).toBe(
      "try / side and / fork and / rewind and / init",
    );
    // Workspace skills & workflows in `.agents/` are neutralized even before available_commands_update arrives.
    const workspace = mkdtempSync(join(tmpdir(), "dusk-agy-workspace-cmds-"));
    scratch.push(workspace);
    mkdirSync(join(workspace, ".agents", "skills", "deploy-prod"), { recursive: true });
    mkdirSync(join(workspace, ".agents", "workflows"), { recursive: true });
    writeFileSync(join(workspace, ".agents", "workflows", "triage.md"), "# triage\n");
    expect(neutralizeAntigravitySlashCommands("webhook says /deploy-prod and /triage", [], workspace)).toBe(
      "webhook says / deploy-prod and / triage",
    );
    expect(neutralizeAntigravitySlashCommands("read .agents/skills/deploy-prod/SKILL.md", [], workspace)).toBe(
      "read .agents/skills/deploy-prod/SKILL.md",
    );
    // Default Antigravity customizations are disabled at launch.
    expect(antigravityAcpArgs("/tmp/profile")).toContain("--include-default-customizations=false");
  });

  it("keeps Turn 1 advertised commands neutralized across pooled session/resume turns when the runtime does not re-emit them", async () => {
    ensureDirs();
    const fake = fakeRuntime();
    const dump = join(fake.directory, "dump-resume-cmds.json");
    const instanceId = "antigravity-resume-cmds";
    const tokenDirectory = join(antigravityProfileDirectory(instanceId), "antigravity-acp");
    mkdirSync(tokenDirectory, { recursive: true });
    writeFileSync(join(tokenDirectory, "antigravity-oauth-token"), JSON.stringify({ token: { access_token: "ok" } }), { mode: 0o600 });
    instance = await AntigravityDriver.create({
      instanceId,
      displayName: "Antigravity Resume Cmds",
      environment: {
        FAKE_ACP_AUTH_METHOD: "oauth-personal",
        FAKE_ACP_MODELS: "gemini-3.8-flash",
        FAKE_ACP_MODES: "default",
        FAKE_ACP_AVAILABLE_COMMANDS: "ephemeral-cmd",
        FAKE_ACP_AVAILABLE_COMMANDS_ONCE: "1",
        FAKE_ACP_DUMP: dump,
        FAKE_ACP_DUMP_PROMPT: "1",
        FAKE_ACP_TEXT_REPLY: "ok",
      },
      enabled: true,
      config: { cli: fake.executable, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    const first = await instance.adapter.sendTurn({
      threadId: "thread-resume-cmds",
      text: "turn 1 /ephemeral-cmd",
      approvalMode: "ask",
      model: "gemini-3.8-flash",
      cwd: fake.directory,
      integrations: { agents: { command: "agents-mcp", args: [], env: { DUSK_COMMS_TOKEN: "turn-1" } } },
    });
    expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === first.turnId)).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(`${dump}.prompt.json`, "utf8"))[0].text).toContain("/ ephemeral-cmd");

    // MCP credentials rotate on turn 2, triggering session/resume on the pooled process without a new available_commands_update.
    const second = await instance.adapter.sendTurn({
      threadId: "thread-resume-cmds",
      text: "turn 2 /ephemeral-cmd",
      approvalMode: "ask",
      model: "gemini-3.8-flash",
      resumeCursor: "fake-acp-session",
      cwd: fake.directory,
      integrations: { agents: { command: "agents-mcp", args: [], env: { DUSK_COMMS_TOKEN: "turn-2" } } },
    });
    expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === second.turnId)).toMatchObject({ ok: true });
    const turn2Prompt = JSON.parse(readFileSync(`${dump}.prompt.json`, "utf8"))[0].text as string;
    expect(turn2Prompt).toContain("/ ephemeral-cmd");
    expect(turn2Prompt).not.toContain("/ephemeral-cmd");
  });

  type Integrations = NonNullable<Parameters<ProviderInstance["adapter"]["sendTurn"]>[0]["integrations"]>;
  const appsDriver = async (instanceId: string, fake = fakeRuntime()) => {
    ensureDirs();
    const dump = join(fake.directory, "dump-apps.json");
    const rpcDump = join(fake.directory, "rpc-apps.json");
    const launches = join(fake.directory, "launches-apps");
    const tokenDirectory = join(antigravityProfileDirectory(instanceId), "antigravity-acp");
    mkdirSync(tokenDirectory, { recursive: true });
    writeFileSync(join(tokenDirectory, "antigravity-oauth-token"), JSON.stringify({ token: { access_token: "ok" } }), { mode: 0o600 });
    const started = instance = await AntigravityDriver.create({
      instanceId,
      displayName: "Antigravity Apps",
      environment: {
        FAKE_ACP_AUTH_METHOD: "oauth-personal",
        FAKE_ACP_MODELS: "gemini-3.8-flash",
        FAKE_ACP_MODES: "default",
        FAKE_ACP_DUMP: dump,
        FAKE_ACP_DUMP_PROMPT: "1",
        FAKE_ACP_RPC_DUMP: rpcDump,
        FAKE_ACP_LAUNCH_COUNT_FILE: launches,
        FAKE_ACP_TEXT_REPLY: "ok",
      },
      enabled: true,
      config: { cli: fake.executable, fullAuto: false },
    });
    await started.startupModelRefresh;
    rmSync(launches, { force: true });
    const events = recorder = recordEvents(started.adapter);
    const connectorBridge = (token: string, appTools?: string[]) => ({
      command: process.execPath,
      args: [join(fake.directory, "connector-proxy.ts")],
      env: {
        DUSK_CONNECTOR_TOKEN: token,
        DUSK_CONNECTOR_UPSTREAM_HEADERS: JSON.stringify({ authorization: `Bearer ${token}` }),
        DUSK_THREAD_ID: "thread-apps",
        ...(appTools ? { DUSK_CONNECTOR_APP_TOOLS: JSON.stringify(appTools) } : {}),
      },
    });
    const turn = async (text: string, integrations: Integrations, resumeCursor?: string) => {
      const { turnId } = await started.adapter.sendTurn({
        threadId: "thread-apps", text, approvalMode: "ask", model: "gemini-3.8-flash", cwd: fake.directory, integrations,
        ...(resumeCursor ? { resumeCursor, recoveryText: `Earlier in this chat: hi\n\n${text}` } : {}),
      });
      expect(await events.until((event) => event.type === "turn.completed" && event.turnId === turnId)).toMatchObject({ ok: true });
      return events.events.find((event) => event.type === "session.started" && event.turnId === turnId) as { sessionId: string; rebuilt?: boolean };
    };
    const mounted = () => JSON.parse(readFileSync(`${dump}.mcp.json`, "utf8")) as Array<{ name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }>;
    const prompt = () => JSON.stringify(JSON.parse(readFileSync(`${dump}.prompt.json`, "utf8")));
    const launchCount = () => Number(readFileSync(launches, "utf8"));
    const methods = () => JSON.parse(readFileSync(rpcDump, "utf8")) as string[];
    return { fake, connectorBridge, turn, mounted, prompt, launchCount, methods };
  };
  const agentsOnly = (token: string): Integrations => ({ agents: { command: "agents-mcp", args: [], env: { DUSK_COMMS_TOKEN: token } } });

  it("hands a fresh chat the connected-apps server, fitted to Antigravity's schema check", async () => {
    const { connectorBridge, turn, mounted, methods } = await appsDriver("antigravity-apps-fresh");
    await turn("read my latest email", { composio: connectorBridge("session-bearer", ["gmail.search_emails"]) });
    expect(methods()).toContain("session/new");
    const composio = mounted().find((server) => server.name === "composio");
    expect(composio).toMatchObject({ command: process.execPath, args: [expect.stringMatching(/connector-proxy\.ts$/u)] });
    const env = Object.fromEntries(composio!.env.map(({ name, value }) => [name, value]));
    expect(env).toMatchObject({ DUSK_CONNECTOR_APP_TOOLS: JSON.stringify(["gmail.search_emails"]), DUSK_TOOL_SCHEMA_PROFILE: "antigravity" });
  });

  it("mounts an app connected mid-chat on the next turn, in a new session that carries the conversation", async () => {
    const { connectorBridge, turn, mounted, prompt, launchCount, methods } = await appsDriver("antigravity-apps-mid-chat");
    const first = await turn("hi", agentsOnly("a"));
    expect(mounted().map((server) => server.name)).toEqual(["agents"]);
    // Gmail connects between turns; the bearers rotate too.
    const second = await turn("now check my gmail", { ...agentsOnly("b"), composio: connectorBridge("b", ["gmail.search_emails"]) }, first.sessionId);
    expect(launchCount()).toBe(2);
    expect(methods()).toContain("session/new");
    expect(methods()).not.toContain("session/resume");
    expect(mounted().map((server) => server.name)).toEqual(["agents", "composio"]);
    expect(second).toMatchObject({ rebuilt: true });
    expect(prompt()).toContain("Earlier in this chat: hi");
    // A later turn whose only change is a rotated bearer stays in that session on the warm process.
    const third = await turn("and the one before", { ...agentsOnly("c"), composio: connectorBridge("c", ["gmail.search_emails"]) }, second.sessionId);
    expect(launchCount()).toBe(2);
    expect(third.sessionId).toBe(second.sessionId);
    expect(third.rebuilt).toBeUndefined();
  });

  it("mounts an app connected while the app was closed: the saved tool set outlives the process", async () => {
    const before = await appsDriver("antigravity-apps-restart");
    const first = await before.turn("hi", agentsOnly("a"));
    await instance!.dispose();
    recorder!.stop();
    const after = await appsDriver("antigravity-apps-restart", before.fake);
    const second = await after.turn("now check my gmail", { ...agentsOnly("b"), composio: after.connectorBridge("b", ["gmail.search_emails"]) }, first.sessionId);
    expect(after.methods()).not.toContain("session/resume");
    expect(after.mounted().map((server) => server.name)).toEqual(["agents", "composio"]);
    expect(second).toMatchObject({ rebuilt: true });
    // Nothing changed since: the next restart resumes the saved session as before.
    await instance!.dispose();
    recorder!.stop();
    const again = await appsDriver("antigravity-apps-restart", before.fake);
    const third = await again.turn("thanks", { ...agentsOnly("c"), composio: again.connectorBridge("c", ["gmail.search_emails"]) }, second.sessionId);
    expect(again.methods()).toContain("session/resume");
    expect(third.sessionId).toBe(second.sessionId);
  });

  it("neutralizes slash commands in both normal turns and background one-shot prompts sent to Antigravity ACP", async () => {
    ensureDirs();
    const fake = fakeRuntime();
    const dump = join(fake.directory, "dump-slash.json");
    const instanceId = "antigravity-slash-guard";
    const tokenDirectory = join(antigravityProfileDirectory(instanceId), "antigravity-acp");
    mkdirSync(tokenDirectory, { recursive: true });
    writeFileSync(join(tokenDirectory, "antigravity-oauth-token"), JSON.stringify({ token: { access_token: "ok" } }), { mode: 0o600 });
    instance = await AntigravityDriver.create({
      instanceId,
      displayName: "Antigravity Slash Guard",
      environment: {
        FAKE_ACP_AUTH_METHOD: "oauth-personal",
        FAKE_ACP_MODELS: "gemini-3.8-flash",
        FAKE_ACP_MODES: "default",
        FAKE_ACP_AVAILABLE_COMMANDS: "learn,custom-workflow",
        FAKE_ACP_DUMP: dump,
        FAKE_ACP_DUMP_PROMPT: "1",
        FAKE_ACP_TEXT_REPLY: "ok",
      },
      enabled: true,
      config: { cli: fake.executable, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "thread-slash-guard",
      system: "Standing rules with /learn and /custom-workflow and https://example.com/learn",
      text: "why did `/learn` pop up? check /plan and /Users/me/learn/SKILL.md",
      approvalMode: "ask",
      model: "gemini-3.8-flash",
      cwd: fake.directory,
    });
    expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId)).toMatchObject({ ok: true });
    const turnPrompt = JSON.parse(readFileSync(`${dump}.prompt.json`, "utf8"))[0].text as string;
    expect(turnPrompt).not.toMatch(/(?:^|[^A-Za-z0-9_./:~-])\/(?:learn|plan|custom-workflow)(?![A-Za-z0-9_/-]|\.[A-Za-z0-9_])/iu);
    expect(turnPrompt).toContain("https://example.com/learn");
    expect(turnPrompt).toContain("/Users/me/learn/SKILL.md");
    expect(turnPrompt).toContain("/ learn");
    expect(turnPrompt).toContain("/ plan");
    expect(turnPrompt).toContain("/ custom-workflow");

    // Background one-shot calls (skill review, memory upkeep) sanitize transcript prompts too.
    const answer = await instance.generateMemoryText!(
      "Transcript:\nMicro: For /learn, I wrote learning_proposal.md\nAlso /custom-workflow and ~/learn",
    );
    expect(answer).toBe("ok");
    const oneShotPrompt = JSON.parse(readFileSync(`${dump}.prompt.json`, "utf8"))[0].text as string;
    expect(oneShotPrompt).toContain("For / learn, I wrote learning_proposal.md");
    expect(oneShotPrompt).toContain("Also / custom-workflow and ~/learn");
    expect(oneShotPrompt).not.toContain("For /learn");
  });
});

// Recorded from Antigravity CLI 1.5.13 (`agy acp`): the prompt answers end_turn while a timer or a background command it
// waits on still runs; when that work ends, the agent wakes itself and its reply arrives with no prompt open.
describe("Antigravity background waits", () => {
  const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fixtures");
  let instance: ProviderInstance | null = null;
  let recorder: EventRecorder | null = null;

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    instance = null;
  });

  const replay = async (fixture: string, instanceId: string) => {
    ensureDirs();
    const fake = fakeRuntime();
    const dump = join(fake.directory, "dump.json");
    const tokenDirectory = join(antigravityProfileDirectory(instanceId), "antigravity-acp");
    mkdirSync(tokenDirectory, { recursive: true });
    writeFileSync(join(tokenDirectory, "antigravity-oauth-token"), JSON.stringify({ token: { access_token: "ok" } }), { mode: 0o600 });
    instance = await AntigravityDriver.create({
      instanceId,
      displayName: "Antigravity",
      environment: {
        FAKE_ACP_AUTH_METHOD: "oauth-personal",
        FAKE_ACP_MODES: "default,accept-edits,auto,plan",
        FAKE_ACP_REPLAY: join(FIXTURES, fixture),
        FAKE_ACP_REPLAY_SPEED: "10",
        FAKE_ACP_RPC_DUMP: `${dump}.rpc.json`,
      },
      enabled: true,
      config: { cli: fake.executable, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    const threadId = `thread-${instanceId}`;
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "wait for it", approvalMode: "ask", cwd: fake.directory });
    const said = () => recorder!.events
      .filter((event) => event.turnId === turnId && event.type === "item.completed" && event.itemType === "assistant_text")
      .map((event) => (event as { text: string }).text.trim());
    return { turnId, threadId, said, rpc: () => JSON.parse(readFileSync(`${dump}.rpc.json`, "utf8")) as string[] };
  };

  it.each([
    ["antigravity-1.5.13-schedule-wake.ndjson", "I have scheduled a one-shot timer for 30 seconds. Waiting for the notification.", "TIMER FIRED."],
    ["antigravity-1.5.13-command-wake.ndjson", "I have started the background command and will wait for it to finish.", "DONE ready"],
  ])("keeps the turn working through %s until the wake reply lands", async (fixture, before, after) => {
    const { turnId, said } = await replay(fixture, fixture.replace(/\W+/gu, "-"));
    // the first reply lands while the turn goes on waiting
    await recorder!.until((event) => event.turnId === turnId && event.type === "item.completed" && event.itemType === "assistant_text");
    expect(said()).toEqual([before]);
    expect(recorder!.events.some((event) => event.turnId === turnId && event.type === "turn.completed")).toBe(false);
    // the status line goes back to the work being waited on
    const replied = recorder!.events.findIndex((event) => event.turnId === turnId && event.type === "item.completed" && event.itemType === "assistant_text");
    expect(recorder!.events.slice(replied).some((event) => event.type === "turn.progress")).toBe(true);
    const completed = await recorder!.until((event) => event.turnId === turnId && event.type === "turn.completed", 15_000);
    expect(completed).toMatchObject({ ok: true, stopReason: null });
    expect(said()).toEqual([before, after]);
  });

  it("ends the wait at once when the person stops it, and cancels Antigravity's timer", async () => {
    const { turnId, threadId, said, rpc } = await replay("antigravity-1.5.13-schedule-cancel.ndjson", "antigravity-wait-stop");
    await recorder!.until((event) => event.turnId === turnId && event.type === "item.completed" && event.itemType === "assistant_text");
    expect(recorder!.events.some((event) => event.turnId === turnId && event.type === "turn.completed")).toBe(false);
    const stoppedAt = Date.now();
    await instance!.adapter.interruptTurn(threadId);
    const completed = await recorder!.until((event) => event.turnId === turnId && event.type === "turn.completed", 3_000);
    expect(Date.now() - stoppedAt).toBeLessThan(2_000);
    expect(completed).toMatchObject({ ok: true, stopReason: "cancelled" });
    // the turn ends as session/cancel is sent; the fake writes down what it received when that line reaches it
    await vi.waitFor(() => expect(rpc()).toContain("session/cancel"), { timeout: 2_000, interval: 25 });
    expect(said()).toEqual(["I have scheduled a one-shot timer to fire in 45 seconds. Standing by until it wakes me."]);
  });
});
