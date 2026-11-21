import { describe, expect, it } from "vitest";
import { automaticBackups, recoveryCapabilityError, startupBackups } from "./automatic-recovery.ts";
import type { SelectableInstance } from "./default-model-selection.ts";

describe("automatic recovery capabilities", () => {
  const engine = { driverKind: "qwenAgent", capabilities: {
    sessionModelSwitch: "unsupported" as const, agentsMcp: true, browserMcp: true,
    customMcp: true, dataMcp: true, emailMcp: true, images: true,
  } };
  it("keeps a compatible local workspace and rejects losing a tool or attachment", () => {
    expect(recoveryCapabilityError(engine, { ...engine, driverKind: "claudeAgent" })).toBeUndefined();
    for (const key of ["agentsMcp", "browserMcp", "customMcp", "dataMcp", "emailMcp", "images"] as const) {
      expect(recoveryCapabilityError(engine, { ...engine, capabilities: { ...engine.capabilities, [key]: false } })).toMatch(/tools and attachments/);
    }
  });
  it("lets a limited Claude bot carry on with an engine that has every tool but a USB phone", () => {
    const claude = { driverKind: "claudeAgent", capabilities: { sessionModelSwitch: "in-session" as const, agentsMcp: true, customMcp: true,
      computerMcp: true, composioMcp: true, phoneMcp: true, browserMcp: true, dataMcp: true, emailMcp: true, deviceMcp: true, images: true } };
    const { phoneMcp: _phone, ...rest } = claude.capabilities;
    const opencode = { driverKind: "opencodeAgent", capabilities: { ...rest, sessionModelSwitch: "unsupported" as const, localComputerMcp: true } };
    expect(recoveryCapabilityError(claude, opencode)).toBeUndefined();
    expect(recoveryCapabilityError(claude, { ...opencode, capabilities: { ...opencode.capabilities, browserMcp: false } })).toMatch(/tools and attachments/);
  });
  it("does not silently move work to a file-less engine, but lets one with files carry a chat-only engine on", () => {
    expect(recoveryCapabilityError(engine, { ...engine, driverKind: "openai-compat" })).toMatch(/same workspace/);
    expect(recoveryCapabilityError({ ...engine, driverKind: "openai-compat" }, engine)).toBeUndefined();
  });
});

describe("startup backups", () => {
  const own = [{ instanceId: "codex", model: "gpt-5.5" }, { instanceId: "gemini", model: "gemini-3-pro" }];
  const app = { instanceId: "qwen", model: "qwen3-coder" };
  it("tries a bot's own backups in order whether or not Automatic recovery is on", () => {
    expect(startupBackups({ fallback: own }, { enabled: false })).toEqual(own);
    expect(startupBackups({ fallback: own }, { enabled: false, backup: app })).toEqual(own);
    expect(startupBackups({ fallback: own }, { enabled: true, backup: app })).toEqual(own);
    expect(startupBackups({ fallback: own })).toEqual(own);
  });
  it("uses the installation's backup only while Automatic recovery is on, for a bot with none of its own", () => {
    expect(startupBackups({ fallback: [] }, { enabled: true, backup: app })).toEqual([app]);
    expect(startupBackups({}, { enabled: true, backup: app })).toEqual([app]);
    expect(startupBackups({}, { enabled: false, backup: app })).toEqual([]);
    expect(startupBackups({}, { enabled: false })).toEqual([]);
    expect(startupBackups({})).toEqual([]);
  });
});

describe("automatic backups", () => {
  const ai = (instanceId: string, driverKind: string, snapshot: Partial<SelectableInstance["snapshot"]> = {}, extra: Partial<SelectableInstance> = {}): SelectableInstance => ({
    instanceId, driverKind, snapshot: { state: "available", authenticated: true, ...snapshot } as SelectableInstance["snapshot"],
    models: { default: `${instanceId}-default`, options: [] }, ...extra,
  });
  const engines = [
    ai("free", "opencodeGo", { freeFallback: true }), ai("grok", "grokAgent"), ai("codex", "codex"), ai("claude", "claudeAgent"),
    ai("claude-work", "claudeAgent"), ai("gemini", "geminiAgent", { authenticated: false }), ai("found", "cursorAgent", {}, { found: true }),
  ];
  it("takes the same kind of AI first, then the best of the rest, the free backup last, never one signed out or not chosen", () => {
    expect(automaticBackups({}, engines, { instanceId: "claude" }).map((pick) => pick.instanceId)).toEqual(["claude-work", "codex", "grok", "free"]);
  });
  it("leaves a bot that chose its own backups, or No backup, alone", () => {
    expect(automaticBackups({ fallback: [] }, engines, { instanceId: "claude" })).toEqual([]);
    expect(automaticBackups({ fallback: [{ instanceId: "codex", model: "x" }] }, engines, { instanceId: "claude" })).toEqual([]);
  });
});
