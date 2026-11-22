import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hasNativeAutoReview, supportsApprovalMode } from "../../../shared/approval-mode.ts";
import { assertToolScopeSupported } from "../../../shared/tool-scope-support.ts";
import { ensureDirs, instanceConfigs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { BUILT_IN_DRIVERS } from "../builtIn.ts";
import {
  FX_AGENT_DEFAULT,
  FX_SIGN_IN_FILES,
  FX_SYSTEM_PROMPT_MAX_BYTES,
  FxAgentDriver,
  ensureFxInjectProvider,
  fxApprovalMode,
  fxConfigureSession,
  fxHomeDir,
  fxPromptText,
  fxProviderId,
  fxSessionNewParams,
  fxSpawnArgs,
  shareFxSignIns,
  writeFxProvider,
} from "./fx.ts";

// Minimal stock fx ACP server: verifies `acp` argv, accepts only `systemPromptMode: "append"`
// (<= 64 KiB, matching stock fx's client_instructions.zig), advertises model/effort options,
// and records every session request for contract assertions.
const FAKE_STOCK_FX_SOURCE = `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("fx 0.0.17\\n");
  process.exit(0);
}
if (argv[0] !== "acp") {
  process.stderr.write("unexpected argv: " + JSON.stringify(argv) + "\\n");
  process.exit(2);
}

const dumpPath = process.env.FAKE_FX_DUMP || "";
const logPath = process.env.FAKE_FX_LOG || "";
if (dumpPath) {
  writeFileSync(dumpPath, JSON.stringify({
    pid: process.pid,
    argv,
    env: {
      FX_HOME: process.env.FX_HOME,
      AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY,
      DUSK_LICENSE_KEY: process.env.DUSK_LICENSE_KEY,
      BOX_TOKEN: process.env.BOX_TOKEN,
    },
  }));
}
const record = (entry) => {
  if (logPath) appendFileSync(logPath, JSON.stringify({ pid: process.pid, ...entry }) + "\\n");
};

let currentModel = "anthropic/claude-sonnet-4.6";
let currentEffort = "medium";
const configOptions = () => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: currentModel,
    options: [
      { value: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
      { value: "openai/gpt-5.4", name: "GPT-5.4" },
    ],
  },
  {
    id: "reasoning_effort",
    name: "Reasoning Effort",
    category: "thought_level",
    type: "select",
    currentValue: currentEffort,
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
  },
];

const send = (payload) => process.stdout.write(JSON.stringify(payload) + "\\n");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += String(chunk);
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "fx", version: "0.0.17" },
          agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
        },
      });
    } else if (msg.method === "session/new") {
      record({ method: msg.method, params: msg.params });
      const mode = msg.params?.systemPromptMode;
      if (mode !== undefined && mode !== "append") {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "UnsupportedSystemPromptMode" } });
        continue;
      }
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { sessionId: "fx-session-1", configOptions: configOptions() },
      });
    } else if (msg.method === "session/set_mode") {
      record({ method: msg.method, params: msg.params });
      const allowed = new Set(["ask", "auto", "full-access"]);
      if (!allowed.has(msg.params?.modeId)) {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "invalid mode" } });
        continue;
      }
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
    } else if (msg.method === "session/set_config_option") {
      record({ method: msg.method, params: msg.params });
      if (msg.params?.configId === "model") currentModel = msg.params.value;
      if (msg.params?.configId === "reasoning_effort") currentEffort = msg.params.value;
      send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: configOptions() } });
    } else if (msg.method === "session/prompt") {
      record({ method: msg.method, params: msg.params });
      const promptText = (msg.params?.prompt ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\\n");
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: msg.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "fx reply: " + promptText },
          },
        },
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    } else if (msg.id !== undefined) {
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  }
});
`;

describe("fx engine helpers", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "dusk-fx-helpers-"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await removeTempDir(scratch);
  });

  it("registers fx in default and custom fleets with MCP-only tool scoping and native auto review", () => {
    expect(BUILT_IN_DRIVERS.some((driver) => driver.driverKind === "fxAgent")).toBe(true);
    expect(instanceConfigs({}).fx?.driver).toBe("fxAgent");
    expect(instanceConfigs({ instances: { claude: { driver: "claudeAgent" } } }).fx?.driver).toBe("fxAgent");
    expect(instanceConfigs({ instances: { fixture: { driver: "fake" } } }).fx).toBeUndefined();
    expect(supportsApprovalMode("fxAgent", "full")).toBe(true);
    expect(supportsApprovalMode("fxAgent", "auto")).toBe(true);
    expect(supportsApprovalMode("fxAgent", "ask")).toBe(true);
    expect(supportsApprovalMode("fxAgent", "edits")).toBe(false);
    expect(hasNativeAutoReview("fxAgent")).toBe(true);
    expect(assertToolScopeSupported("fxAgent", { allow: ["native:*", "mcp:agents:*"] })).toBeDefined();
    expect(() => assertToolScopeSupported("fxAgent", { allow: ["mcp:agents:*"] })).toThrow(/native tool selection/);
  });

  it("resolves isolated FX_HOME and ignores invalid values that stock fx rejects", () => {
    const home = join(scratch, "home");
    const data = join(scratch, "data");
    const custom = join(scratch, "custom-fx");

    expect(fxHomeDir({ HOME: home }, data)).toBe(join(data, "engines", "fx"));
    expect(fxHomeDir({ HOME: home, FX_HOME: custom }, data)).toBe(custom);
    expect(fxHomeDir({ HOME: home, FX_HOME: "relative/fx" }, data)).toBe(join(data, "engines", "fx"));
    expect(fxHomeDir({ HOME: home, FX_HOME: "/" }, data)).toBe(join(data, "engines", "fx"));
    expect(fxHomeDir({ HOME: home, FX_HOME: home }, data)).toBe(join(data, "engines", "fx"));
  });

  it("shares all stock fx sign-in files from ~/.fx into isolated FX_HOME", () => {
    const home = join(scratch, "home");
    const userFx = join(home, ".fx");
    const isolated = join(scratch, "data", "engines", "fx");
    mkdirSync(userFx, { recursive: true });
    mkdirSync(isolated, { recursive: true });
    for (const file of FX_SIGN_IN_FILES) {
      writeFileSync(join(userFx, file), `fixture-${file}`);
    }

    shareFxSignIns(isolated, home);

    for (const file of FX_SIGN_IN_FILES) {
      expect(readFileSync(join(isolated, file), "utf8")).toBe(`fixture-${file}`);
    }
  });

  it("maps local host ids to valid non-reserved stock fx provider ids", () => {
    expect(fxProviderId("ollama")).toBe("ollama");
    expect(fxProviderId("LM Studio")).toBe("lm-studio");
    expect(fxProviderId("123host")).toBe("dusk-123host");
    expect(fxProviderId("gateway")).toBe("dusk-gateway");
    expect(fxProviderId("codex")).toBe("dusk-codex");
    expect(fxProviderId("grok")).toBe("dusk-grok");
    expect(fxProviderId("a".repeat(80)).length).toBe(64);
  });

  it("writes stock-compatible provider entries while preserving existing settings and refusing corrupt JSON", () => {
    const fxHome = join(scratch, "fx-home");
    mkdirSync(fxHome, { recursive: true });
    writeFileSync(join(fxHome, "settings.json"), JSON.stringify({
      providers: {
        existing: { protocol: "openai-chat-completions", base_url: "http://127.0.0.1:9999/v1", auth: { type: "none" } },
      },
      models: { existing: "llama3" },
    }));

    expect(writeFxProvider(fxHome, "ollama", {
      protocol: "openai-chat-completions",
      base_url: "http://127.0.0.1:11434/v1",
      auth: { type: "bearer", env: "FX_DUSK_PROVIDER_OLLAMA_KEY" },
      model_metadata: { "qwen3:32b": { context_window: 65536 } },
    }, { model: "qwen3:32b", mergeModelMetadata: true })).toBe(true);

    const saved = JSON.parse(readFileSync(join(fxHome, "settings.json"), "utf8"));
    expect(saved.providers.existing.base_url).toBe("http://127.0.0.1:9999/v1");
    expect(saved.providers.ollama).toEqual({
      protocol: "openai-chat-completions",
      base_url: "http://127.0.0.1:11434/v1",
      auth: { type: "bearer", env: "FX_DUSK_PROVIDER_OLLAMA_KEY" },
      model_metadata: { "qwen3:32b": { context_window: 65536 } },
    });
    expect(saved.models.ollama).toBe("qwen3:32b");

    writeFileSync(join(fxHome, "settings.json"), "{not-json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(writeFxProvider(fxHome, "ollama", { protocol: "openai-chat-completions" })).toBe(false);
      expect(readFileSync(join(fxHome, "settings.json"), "utf8")).toBe("{not-json");
    } finally {
      warn.mockRestore();
    }
  });

  it("injects local host providers with env-referenced auth and never writes the API key to disk", () => {
    const fxHome = join(scratch, "fx-home");
    const binding = ensureFxInjectProvider("unsloth::qwen3", {
      FX_HOME: fxHome,
      UNSLOTH_STUDIO_AUTH_TOKEN: "local-fixture-key",
    }, scratch);

    expect(binding).toEqual({
      providerId: "unsloth",
      modelId: "qwen3",
      envKey: "FX_DUSK_PROVIDER_UNSLOTH_KEY",
      apiKey: "local-fixture-key",
    });
    const raw = readFileSync(join(fxHome, "settings.json"), "utf8");
    expect(raw).not.toContain("local-fixture-key");
    const parsed = JSON.parse(raw);
    expect(parsed.providers.unsloth.auth).toEqual({ type: "bearer", env: "FX_DUSK_PROVIDER_UNSLOTH_KEY" });
  });

  it("maps approval modes fail-closed and selects stock fx spawn args", () => {
    expect(fxApprovalMode("full", false)).toBe("full-access");
    expect(fxApprovalMode("auto", false)).toBe("auto");
    expect(fxApprovalMode("ask", true)).toBe("ask");
    expect(fxApprovalMode("edits", true)).toBe("ask");
    expect(fxApprovalMode("custom", true)).toBe("ask");
    expect(fxApprovalMode(undefined, false)).toBe("ask");
    expect(fxApprovalMode(undefined, true)).toBe("full-access");

    expect(fxSpawnArgs({ model: undefined })).toEqual(["acp"]);
    expect(fxSpawnArgs({ model: FX_AGENT_DEFAULT })).toEqual(["acp"]);
    expect(fxSpawnArgs({ model: "anthropic/claude-sonnet-4.6" })).toEqual(["acp"]);
    expect(fxSpawnArgs({ model: "ollama::llama3.2" })).toEqual(["acp", "--provider", "ollama", "--model", "llama3.2"]);
  });

  it("passes standing instructions in append mode up to 64 KiB and falls back inline past the cap or on NUL", () => {
    const stable = "You are a concise engineer.";
    const fitTurn = {
      threadId: "t1",
      systemStable: stable,
      system: "",
      text: `${stable}\n\nCheck the tests.`,
    };
    expect(fxSessionNewParams(fitTurn)).toEqual({
      systemPrompt: [{ type: "text", text: stable }],
      systemPromptMode: "append",
    });
    expect(fxPromptText(fitTurn)).toBe("Check the tests.");

    const directSystemTurn = {
      threadId: "t2",
      system: stable,
      text: "Check the tests.",
    };
    expect(fxSessionNewParams(directSystemTurn)).toEqual({
      systemPrompt: [{ type: "text", text: stable }],
      systemPromptMode: "append",
    });
    expect(fxPromptText(directSystemTurn)).toBe("Check the tests.");

    const huge = "x".repeat(FX_SYSTEM_PROMPT_MAX_BYTES + 1);
    const oversizedSplit = { threadId: "t3", systemStable: huge, system: "", text: `${huge}\n\nHello` };
    expect(fxSessionNewParams(oversizedSplit)).toEqual({});
    expect(fxPromptText(oversizedSplit)).toBe(`${huge}\n\nHello`);

    const oversizedDirect = { threadId: "t4", system: huge, text: "Hello" };
    expect(fxSessionNewParams(oversizedDirect)).toEqual({});
    expect(fxPromptText(oversizedDirect)).toBe(`${huge}\n\nHello`);

    const withNul = { threadId: "t5", system: "bad\0prompt", text: "Hello" };
    expect(fxSessionNewParams(withNul)).toEqual({});
    expect(fxPromptText(withNul)).toBe("bad\0prompt\n\nHello");
  });

  it("applies mode, model, and advertised effort in fxConfigureSession", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const request = async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "session/set_config_option") {
        return {
          configOptions: [
            {
              id: "reasoning_effort",
              category: "thought_level",
              type: "select",
              currentValue: "medium",
              options: [{ value: "low" }, { value: "medium" }, { value: "high" }],
            },
          ],
        };
      }
      return {};
    };

    await fxConfigureSession({
      request,
      sessionId: "s1",
      turn: { approvalMode: "auto", model: "openai/gpt-5.4", effort: "high" },
      config: { fullAuto: false },
    });

    expect(calls).toEqual([
      { method: "session/set_mode", params: { sessionId: "s1", modeId: "auto" } },
      { method: "session/set_config_option", params: { sessionId: "s1", configId: "model", value: "openai/gpt-5.4" } },
      { method: "session/set_config_option", params: { sessionId: "s1", configId: "reasoning_effort", value: "high" } },
    ]);

    calls.length = 0;
    await fxConfigureSession({
      request,
      sessionId: "s2",
      turn: { approvalMode: "full", model: FX_AGENT_DEFAULT, effort: "xhigh" },
      config: { fullAuto: false },
      configOptions: [
        {
          id: "reasoning_effort",
          category: "thought_level",
          type: "select",
          currentValue: "medium",
          options: [{ value: "low" }, { value: "high" }],
        },
      ],
    });
    expect(calls).toEqual([
      { method: "session/set_mode", params: { sessionId: "s2", modeId: "full-access" } },
    ]);
  });
});

describe("FxAgentDriver ACP contract", () => {
  let scratch: string;
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;

  beforeEach(() => {
    ensureDirs();
    scratch = mkdtempSync(join(tmpdir(), "dusk-fx-contract-"));
  });

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    recorder = undefined;
    vi.unstubAllEnvs();
    await removeTempDir(scratch);
  });

  function writeFakeStockFx(): string {
    const script = join(scratch, "fake-fx.mjs");
    writeFileSync(script, FAKE_STOCK_FX_SOURCE, { mode: 0o755 });
    return script;
  }

  it("discovers models, runs turns over stock fx ACP, and switches approval mode without respawning", async () => {
    const cli = writeFakeStockFx();
    const home = join(scratch, "user-home");
    const fxHome = join(scratch, "isolated-fx");
    mkdirSync(join(home, ".fx"), { recursive: true });
    writeFileSync(join(home, ".fx", "auth.json"), '{"token":"fixture"}');
    const dumpPath = join(scratch, "launch.json");
    const logPath = join(scratch, "rpc.jsonl");

    vi.stubEnv("AI_GATEWAY_API_KEY", "gateway-fixture-key");
    vi.stubEnv("DUSK_LICENSE_KEY", "operator-secret");
    vi.stubEnv("BOX_TOKEN", "workspace-secret");

    instance = await FxAgentDriver.create({
      instanceId: "fx-contract",
      displayName: "fx",
      enabled: true,
      environment: {
        HOME: home,
        USERPROFILE: home,
        FX_HOME: fxHome,
        DUSK_PROBE_LOCAL_INJECT: "0",
        FAKE_FX_DUMP: dumpPath,
        FAKE_FX_LOG: logPath,
      },
      config: { cli, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);

    await instance.refreshModels!();
    const catalog = instance.models;
    expect(catalog.default).toBe(FX_AGENT_DEFAULT);
    expect(catalog.options.map((option) => option.id)).toEqual([
      FX_AGENT_DEFAULT,
      "anthropic/claude-sonnet-4.6",
      "openai/gpt-5.4",
    ]);
    expect(catalog.options.every((option) => option.custom === true)).toBe(true);
    expect(readFileSync(join(fxHome, "auth.json"), "utf8")).toBe('{"token":"fixture"}');

    const stable = "You are a helpful teammate.";
    const first = await instance.adapter.sendTurn({
      threadId: "fx-thread",
      text: "First task",
      system: stable,
      systemStable: stable,
      model: "openai/gpt-5.4",
      effort: "high",
      approvalMode: "auto",
      cwd: scratch,
    });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === first.turnId);
    expect(recorder.events.every((event) => event.provider === "fxAgent")).toBe(true);
    const firstText = recorder.events
      .filter((event) => event.type === "content.delta" && event.turnId === first.turnId)
      .map((event) => (event.type === "content.delta" ? event.delta : ""))
      .join("");
    expect(firstText).toBe("fx reply: First task");

    const launch = JSON.parse(readFileSync(dumpPath, "utf8"));
    expect(launch.argv).toEqual(["acp"]);
    expect(launch.env.FX_HOME).toBe(fxHome);
    expect(launch.env.AI_GATEWAY_API_KEY).toBe("gateway-fixture-key");
    expect(launch.env.DUSK_LICENSE_KEY).toBeUndefined();
    expect(launch.env.BOX_TOKEN).toBeUndefined();

    const second = await instance.adapter.sendTurn({
      threadId: "fx-thread",
      text: "Second task",
      system: stable,
      systemStable: stable,
      model: "openai/gpt-5.4",
      effort: "low",
      approvalMode: "ask",
      cwd: scratch,
    });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === second.turnId);

    const entries = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const turnEntries = entries.filter((entry) => entry.pid === launch.pid);
    const sessionNew = turnEntries.find((entry) => entry.method === "session/new");
    expect(sessionNew.params.systemPromptMode).toBe("append");
    expect(sessionNew.params.systemPrompt).toEqual([{ type: "text", text: stable }]);
    expect(turnEntries.filter((entry) => entry.method === "session/set_mode").map((entry) => entry.params.modeId)).toEqual([
      "auto",
      "ask",
    ]);
    expect(turnEntries.filter((entry) => entry.method === "session/new")).toHaveLength(1);
    expect(JSON.parse(readFileSync(dumpPath, "utf8")).pid).toBe(launch.pid);
    expect(dirname(cli)).toBe(scratch);
  });

  it("reports a missing CLI as unavailable", async () => {
    instance = await FxAgentDriver.create({
      instanceId: "fx-missing",
      displayName: "fx",
      enabled: true,
      environment: { HOME: scratch, USERPROFILE: scratch, FX_HOME: join(scratch, "fx-home") },
      config: { cli: join(scratch, "missing-fx"), fullAuto: false },
    });
    expect(existsSync(join(scratch, "missing-fx"))).toBe(false);
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
  });
});
