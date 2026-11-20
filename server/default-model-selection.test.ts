import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import type { EngineAccess, ModelCatalog, ModelSelection, ProviderSnapshot } from "./contracts.ts";
import { connectedOnly, freeBackupOverConnected, leavesFreeBackup, readyToRun, selectDefaultModelSelection, withInstanceConfig, withNewBotEffort, type SelectableInstance } from "./default-model-selection.ts";
import { ManagedDesktopPolicy } from "./managed-policy.ts";

const codex = {
  instanceId: "codex",
  driverKind: "codex",
  snapshot: { state: "available", authenticated: true } satisfies ProviderSnapshot,
  models: {
    default: "codex-default",
    options: [{ id: "codex-default", label: "Default" }, { id: "selected-model", label: "Selected" }],
  } satisfies ModelCatalog,
  capabilities: { effortLevels: ["low", "high"] as const },
};
const claude = {
  instanceId: "claude",
  driverKind: "claudeAgent",
  snapshot: { state: "available", authenticated: true } satisfies ProviderSnapshot,
  models: { default: "claude-default", options: [{ id: "claude-default", label: "Claude" }] },
};

describe("new bot default model selection", () => {
  it("accepts a configured API-key provider", () => {
    const instance = { ...codex, instanceId: "mistral", driverKind: "mistral", access: "api" as const };
    const preferred = { instanceId: "mistral", model: "selected-model" };
    expect(selectDefaultModelSelection([instance], preferred)).toEqual(preferred);
  });
  it("keeps a saved custom endpoint even when its account sign-in is false", () => {
    const instance = { ...codex, access: "custom" as const, snapshot: { state: "available", authenticated: false } satisfies ProviderSnapshot };
    const preferred = { instanceId: "codex", model: "selected-model" };
    expect(selectDefaultModelSelection([claude, instance], preferred)).toEqual(preferred);
  });
  it("preserves an intentional variant for ACP validation, including variants absent from the preview catalog", () => {
    const preferred = { instanceId: "codex", model: "selected-model", variant: "default" };
    expect(selectDefaultModelSelection([{ ...codex, capabilities: { modelVariants: true } }], preferred))
      .toEqual(preferred);
    expect(selectDefaultModelSelection([codex], preferred)).toEqual({ instanceId: "", model: "" });
    expect(preferred.variant).toBe("default");
  });
  it.each(["low", "high"] as const)("honors the configured provider, model, and supported %s effort ahead of the Claude preference", (effort) => {
    const preferred = { instanceId: "codex", model: "selected-model", effort };
    const selection = selectDefaultModelSelection([claude, codex], preferred);
    expect(selection).toEqual(preferred);
    expect(selection).not.toBe(preferred);
  });

  it.each([
    { label: "missing capabilities", capabilities: undefined },
    { label: "no effort control", capabilities: {} },
    { label: "empty effort list", capabilities: { effortLevels: [] } },
    { label: "changed effort support", capabilities: { effortLevels: ["low"] as const } },
  ])("omits stale effort for $label without changing the provider, model, or saved preference", ({ capabilities }) => {
    const preferred = { instanceId: "codex", model: "selected-model", effort: "high" as const };
    const selection = selectDefaultModelSelection([
      { ...claude, capabilities: { effortLevels: ["high"] } },
      { ...codex, capabilities },
    ], preferred);
    expect(selection).toEqual({ instanceId: "codex", model: "selected-model" });
    expect(selection).not.toHaveProperty("effort");
    expect(preferred.effort).toBe("high");
  });

  it("accepts the provider default even when it is not repeated in its options", () => {
    expect(selectDefaultModelSelection(
      [{ ...codex, models: { default: "codex-default", options: [] } }],
      { instanceId: "codex", model: "codex-default" },
    )).toEqual({ instanceId: "codex", model: "codex-default" });
  });

  it.each([
    { label: "missing provider", instances: [claude] },
    { label: "unavailable provider", instances: [claude, { ...codex, snapshot: { state: "unavailable" as const } }] },
    { label: "signed-out provider", instances: [claude, { ...codex, snapshot: { state: "available" as const, authenticated: false } }] },
    { label: "disabled provider", instances: [claude, { ...codex, enabled: false }] },
    { label: "removed model", instances: [claude, { ...codex, models: { default: "new-model", options: [] } }] },
  ])("returns setup for a saved $label without changing provider", ({ instances }) => {
    expect(selectDefaultModelSelection(instances, { instanceId: "codex", model: "selected-model" }))
      .toEqual({ instanceId: "", model: "" });
  });

  it("keeps the existing Claude preference when no default was saved", () => {
    expect(selectDefaultModelSelection([codex, claude])).toEqual({ instanceId: "claude", model: "claude-default" });
    expect(selectDefaultModelSelection([codex])).toEqual({ instanceId: "codex", model: "codex-default" });
    expect(selectDefaultModelSelection([])).toEqual({ instanceId: "", model: "" });
  });

  it("treats a fully empty saved default as unset, but keeps incomplete choices intentional", () => {
    expect(selectDefaultModelSelection([codex], { instanceId: "", model: "" }))
      .toEqual({ instanceId: "codex", model: "codex-default" });
    for (const preferred of [{ instanceId: "codex", model: "" }, { instanceId: "", model: "selected-model" }]) {
      expect(selectDefaultModelSelection([claude, codex], preferred)).toEqual({ instanceId: "", model: "" });
    }
  });

  it("skips empty model catalogs instead of choosing an unusable preferred provider", () => {
    const empty = { ...claude, models: { default: "", options: [] } };
    expect(selectDefaultModelSelection([empty, codex])).toEqual({ instanceId: "codex", model: "codex-default" });
    expect(selectDefaultModelSelection([empty])).toEqual({ instanceId: "", model: "" });
    expect(selectDefaultModelSelection([{ ...empty, models: { default: " ", options: [{ id: "", label: "Empty" }] } }]))
      .toEqual({ instanceId: "", model: "" });
  });

  it("uses the first nonempty model when a configured catalog has no default", () => {
    const models = { default: "", options: [{ id: "", label: "Empty" }, { id: " ", label: "Blank" }, { id: "usable-model", label: "Usable" }] };
    expect(selectDefaultModelSelection([{ ...claude, models }, codex]))
      .toEqual({ instanceId: "claude", model: "usable-model" });
    expect(selectDefaultModelSelection([{ ...codex, models: { default: "catalog-default", options: [] } }]))
      .toEqual({ instanceId: "codex", model: "catalog-default" });
  });

  it("never automatically chooses a disabled engine, even for signed-out setup", () => {
    const disabled = { ...claude, enabled: false };
    expect(readyToRun(disabled)).toBe(false);
    expect(selectDefaultModelSelection([disabled, codex])).toEqual({ instanceId: "codex", model: "codex-default" });
    expect(selectDefaultModelSelection([disabled])).toEqual({ instanceId: "", model: "" });
    const signedOutCodex = { ...codex, snapshot: { state: "available", authenticated: false } satisfies ProviderSnapshot };
    expect(selectDefaultModelSelection([disabled, signedOutCodex])).toEqual({ instanceId: "codex", model: "codex-default" });
  });

  it("prefers an engine that can run a turn now over a signed-out Claude", () => {
    const signedOut = { ...claude, snapshot: { state: "available", authenticated: false } satisfies ProviderSnapshot };
    expect(selectDefaultModelSelection([signedOut, codex])).toEqual({ instanceId: "codex", model: "codex-default" });
    expect(selectDefaultModelSelection([codex, signedOut])).toEqual({ instanceId: "codex", model: "codex-default" });
    // Nothing can run yet: the first available engine, Claude first.
    const codexOut = { ...codex, snapshot: { state: "available", authenticated: false } satisfies ProviderSnapshot };
    expect(selectDefaultModelSelection([codexOut, signedOut])).toEqual({ instanceId: "claude", model: "claude-default" });
    const custom = { ...codexOut, instanceId: "router", access: "custom" as const };
    expect(selectDefaultModelSelection([signedOut, custom])).toEqual({ instanceId: "router", model: "codex-default" });
  });
});

describe("new bot default: one ranking with the welcome, tested AIs first", () => {
  const ready = (instanceId: string, driverKind: string, model: string, snapshot: Partial<ProviderSnapshot> = {}): SelectableInstance => ({
    instanceId, driverKind, snapshot: { state: "available", authenticated: true, ...snapshot }, models: { default: model, options: [{ id: model, label: model }] },
  });
  const grok = ready("grok", "grokAgent", "grok-default");
  const kimi = ready("kimi", "kimiAgent", "kimi-default");
  const chatgpt = ready("chatgpt", "codex", "gpt-default", { chatgptPlan: true });
  const claudeReady = ready("claude", "claudeAgent", "claude-default");
  const openCodeFree = ready("opencodeGo", "opencodeGo", "opencode/big-pickle", { freeFallback: true });
  const pick = (instances: SelectableInstance[], context = {}) => selectDefaultModelSelection(instances, undefined, context).instanceId;

  it("picks Claude over Grok even though Grok comes first in the app's list", () => {
    expect(pick([grok, kimi, claudeReady])).toBe("claude");
  });

  it("picks a ChatGPT plan over Grok", () => {
    expect(pick([grok, kimi, chatgpt])).toBe("chatgpt");
  });

  it("gives a saved free backup way to a connected AI, and keeps it while nothing else is ready", () => {
    const saved = { instanceId: "opencodeGo", model: "opencode/big-pickle" };
    expect(selectDefaultModelSelection([openCodeFree, claudeReady], saved)).toEqual({ instanceId: "claude", model: "claude-default" });
    expect(selectDefaultModelSelection([openCodeFree], saved)).toEqual(saved);
    const claudeOut = ready("claude", "claudeAgent", "claude-default", { authenticated: false });
    expect(selectDefaultModelSelection([openCodeFree, claudeOut], saved)).toEqual(saved);
    expect(freeBackupOverConnected([openCodeFree, claudeReady], saved)).toBe(true);
    expect(freeBackupOverConnected([openCodeFree, claudeReady], { instanceId: "claude", model: "claude-default" })).toBe(false);
  });

  it("keeps a free backup model the person picked as the default themselves, a connected AI notwithstanding", () => {
    const saved = { instanceId: "opencodeGo", model: "opencode/deepseek-v4-free" };
    const offered = { ...openCodeFree, models: { default: "opencode/big-pickle", options: [{ id: "opencode/big-pickle", label: "Big Pickle" }, { id: saved.model, label: "DeepSeek" }] } };
    expect(selectDefaultModelSelection([offered, claudeReady], saved, { preferredChosen: true })).toEqual(saved);
    expect(selectDefaultModelSelection([offered, claudeReady], saved).instanceId).toBe("claude");
  });

  it("moves a bot the app put on the free backup to a connected AI, never one the person put there", () => {
    const free = { instanceId: "opencodeGo", model: "opencode/deepseek-v4-free" };
    expect(leavesFreeBackup([openCodeFree, claudeReady], { modelSelection: free })).toBe(true);
    expect(leavesFreeBackup([openCodeFree, claudeReady], { modelSelection: free, modelChosen: true })).toBe(false);
    expect(leavesFreeBackup([openCodeFree, claudeReady], { modelSelection: undefined })).toBe(false);
  });

  it("moves a free pick the catalog no longer lists onto the free model there is now, not to setup", () => {
    // nothing else is ready, so a pick it no longer lists runs on the free model there is now
expect(selectDefaultModelSelection([openCodeFree], { instanceId: "opencodeGo", model: "opencode/hy4-flash-free" }))
      .toEqual({ instanceId: "opencodeGo", model: "opencode/big-pickle" });
    // any other AI with a model that vanished still sends the person to setup, never to another model
    expect(selectDefaultModelSelection([openCodeFree, claude], { instanceId: "claude", model: "claude-gone" }))
      .toEqual({ instanceId: "", model: "" });
  });

  it("keeps the free model while an added server only has a key saved, and gives way once it answers", () => {
    const saved = { instanceId: "opencodeGo", model: "opencode/big-pickle" };
    // an OpenAI-compatible server added on a cloud home with an address only the person's own computer can reach
    const server = { ...ready("openai-compat-1", "openai-compat", "meta-llama/llama-3.3-70b-instruct"), access: "api" as const };
    const untested = { answered: () => undefined };
    expect(freeBackupOverConnected([openCodeFree, server], saved, untested)).toBe(false);
    expect(selectDefaultModelSelection([openCodeFree, server], saved, untested)).toEqual(saved);
    expect(freeBackupOverConnected([openCodeFree, server], saved, { answered: (instance: SelectableInstance) => instance.instanceId === "opencodeGo" ? true : false })).toBe(false);
    expect(freeBackupOverConnected([openCodeFree, server], saved, { answered: (instance: SelectableInstance) => instance === server ? true : undefined })).toBe(true);
    // a sign-in that missed its test twice is no reason to leave the free model either
    expect(freeBackupOverConnected([openCodeFree, claudeReady], saved, { answered: (instance: SelectableInstance) => instance === claudeReady ? false : undefined })).toBe(false);
    expect(freeBackupOverConnected([openCodeFree, claudeReady], saved, untested)).toBe(true);
  });

  it("picks OpenCode on free models only after every other ready AI, and when it is the only one", () => {
    for (const other of [grok, kimi, chatgpt, claudeReady]) expect(pick([openCodeFree, other])).toBe(other.instanceId);
    expect(pick([openCodeFree])).toBe("opencodeGo");
    expect(selectDefaultModelSelection([openCodeFree])).toEqual({ instanceId: "opencodeGo", model: "opencode/big-pickle" });
  });

  it("always keeps a saved default, over the ranking and over any test (the free backup aside)", () => {
    const saved = { instanceId: "kimi", model: "kimi-default" };
    expect(selectDefaultModelSelection([claudeReady, kimi], saved, { answered: (instance) => instance.instanceId === "claude" }))
      .toEqual(saved);
    expect(selectDefaultModelSelection([claudeReady, grok], { instanceId: "grok", model: "grok-default" }, { answered: () => false }))
      .toEqual({ instanceId: "grok", model: "grok-default" });
  });

  it("moves off an AI that failed its test to the best one that answered, and keeps the ranking until a test says otherwise", () => {
    const failed = (...ids: string[]) => (instance: SelectableInstance) => ids.includes(instance.instanceId) ? false : undefined;
    expect(pick([grok, claudeReady, chatgpt], { answered: failed("claude") })).toBe("chatgpt");
    expect(pick([grok, claudeReady, chatgpt], { answered: (instance: SelectableInstance) => instance.instanceId === "claude" ? false : instance.instanceId === "grok" })).toBe("grok");
    expect(pick([grok, claudeReady], { answered: () => undefined })).toBe("claude");
    // Nothing answered: the ranking still decides, so a new bot is never left without an AI.
    expect(pick([grok, claudeReady], { answered: () => false })).toBe("claude");
    // The free backup that answered beats a real AI that didn't.
    expect(pick([claudeReady, openCodeFree], { answered: (instance: SelectableInstance) => instance.instanceId === "opencodeGo" ? true : false })).toBe("opencodeGo");
  });

  it("never prefers the free backup to a real AI that hasn't been tested yet, or can't be", () => {
    const backupAnswered = (instance: SelectableInstance) => instance.instanceId === "opencodeGo" ? true : undefined;
    expect(pick([claudeReady, openCodeFree], { answered: backupAnswered })).toBe("claude");
    expect(pick([ready("muse", "museCode", "muse-default"), openCodeFree], { answered: backupAnswered })).toBe("muse");
  });
});

describe("new bot default model selection while enrolled in an organisation", () => {
  const signedOut = { ...claude, instanceId: "personal-claude", snapshot: { state: "available", authenticated: false } satisfies ProviderSnapshot };
  const companyClaude = { ...claude, instanceId: "company.fixture.anthropic", models: { default: "company-claude", options: [{ id: "company-claude", label: "Company" }] } };
  const companyRouter = {
    instanceId: "company.fixture.openrouter", driverKind: "openai-compat",
    snapshot: { state: "available", authenticated: true } satisfies ProviderSnapshot,
    models: { default: "company/router", options: [{ id: "company/router", label: "Router" }] },
  };
  const company = (instanceId: string) => instanceId.startsWith("company.");

  it("picks a Company model that can run over an installed but signed-out personal Claude", () => {
    expect(selectDefaultModelSelection([signedOut, companyClaude], undefined, { company }))
      .toEqual({ instanceId: "company.fixture.anthropic", model: "company-claude" });
    expect(selectDefaultModelSelection([signedOut, companyRouter, companyClaude], undefined, { company }))
      .toEqual({ instanceId: "company.fixture.anthropic", model: "company-claude" });
    expect(selectDefaultModelSelection([signedOut, companyRouter], undefined, { company }))
      .toEqual({ instanceId: "company.fixture.openrouter", model: "company/router" });
  });

  it("keeps a signed-in personal engine, so billing stays the person's choice", () => {
    expect(selectDefaultModelSelection([companyClaude, claude], undefined, { company }))
      .toEqual({ instanceId: "claude", model: "claude-default" });
    expect(selectDefaultModelSelection([signedOut, companyClaude, codex], undefined, { company }))
      .toEqual({ instanceId: "codex", model: "codex-default" });
  });

  it("falls back to today's choice when nothing can run yet", () => {
    const companyMissingCli = { ...companyClaude, snapshot: { state: "unavailable", reason: "claude CLI not found" } satisfies ProviderSnapshot };
    expect(selectDefaultModelSelection([signedOut, companyMissingCli], undefined, { company }))
      .toEqual({ instanceId: "personal-claude", model: "claude-default" });
  });

  it("is the same choice as without an enrolment when no Company model exists", () => {
    for (const instances of [[signedOut, codex], [codex, signedOut], [codex], [signedOut], []]) {
      expect(selectDefaultModelSelection(instances, undefined, {})).toEqual(selectDefaultModelSelection(instances));
      expect(selectDefaultModelSelection(instances, undefined, { company, refusal: () => undefined })).toEqual(selectDefaultModelSelection(instances));
    }
    expect(selectDefaultModelSelection([codex, signedOut], undefined, { company })).toEqual({ instanceId: "codex", model: "codex-default" });
  });

  it("never picks an engine the organisation's policy refuses", () => {
    // companyModelsOnly: every personal instance is refused.
    const companyOnly = (instance: { instanceId: string }) => company(instance.instanceId) ? undefined : "Fixture Company allows only company models on this computer.";
    expect(selectDefaultModelSelection([claude, codex, companyRouter], undefined, { company, refusal: companyOnly }))
      .toEqual({ instanceId: "company.fixture.openrouter", model: "company/router" });
    expect(selectDefaultModelSelection([claude, codex], undefined, { company, refusal: companyOnly }))
      .toEqual({ instanceId: "", model: "" });
    // An allow-list without Claude skips Claude, personal or Company.
    const noClaude = (instance: { driverKind: string }) => instance.driverKind === "claudeAgent" ? "Fixture Company does not allow the Claude engine on this computer." : undefined;
    expect(selectDefaultModelSelection([claude, companyClaude, companyRouter], undefined, { company, refusal: noClaude }))
      .toEqual({ instanceId: "company.fixture.openrouter", model: "company/router" });
    expect(selectDefaultModelSelection([claude, companyRouter], { instanceId: "claude", model: "claude-default" }, { company, refusal: companyOnly }))
      .toEqual({ instanceId: "", model: "" });
  });
});

// The server's own wiring, not a copy: run index.ts's actual defaultSelection
// and policyModelRefusal against a synthetic registry, enrolment and policy.
describe("new bot default model selection wiring in index.ts", () => {
  // Windows checkouts may use CRLF; match on normalised line endings.
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const extract = (signature: string, close = "\n}\n") => {
    const start = source.indexOf(`\n${signature}`), end = source.indexOf(close, start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    return source.slice(start + 1, end + close.length - 1);
  };
  const code = ts.transpileModule(`${extract("function policyModelRefusal(")}\n${extract("function selectableInstances<")}\n${extract("function providersInUse(")}\n${extract("async function defaultSelection(")}\n${extract("const selectionContext = {", "\n};\n")}`,
    { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
  const companyRouter = {
    instanceId: "company.fixture.openrouter", driverKind: "openai-compat",
    snapshot: { state: "available", authenticated: true } satisfies ProviderSnapshot,
    models: { default: "company/router", options: [{ id: "company/router", label: "Router" }] },
  };
  const companyClaude = { ...claude, instanceId: "company.fixture.anthropic", models: { default: "company-claude", options: [{ id: "company-claude", label: "Company" }] } };
  const signedOut = { ...claude, snapshot: { state: "available", authenticated: false } satisfies ProviderSnapshot };
  /** every provider here was chosen by the person unless named in `found` */
  const withChosen = (instances: unknown[], configs: Record<string, object>, found: readonly string[]) => ({ ...configs, ...Object.fromEntries((instances as SelectableInstance[]).map((instance) =>
    [instance.instanceId, { driver: instance.driverKind, ...(found.includes(instance.instanceId) ? {} : { chosen: true }), ...configs[instance.instanceId] }])) });
  function server(instances: unknown[], { enrolled = false, companyModelsOnly = false, saved, configs = {}, answered, bots = [], found = [] }: { found?: string[]; enrolled?: boolean; companyModelsOnly?: boolean; saved?: ModelSelection; configs?: Record<string, { enabled?: boolean; access?: EngineAccess; chosen?: boolean }>; answered?: (instance: SelectableInstance) => boolean | undefined; bots?: Array<{ id: string; modelSelection: ModelSelection }> } = {}) {
    const managedPolicy = new ManagedDesktopPolicy();
    if (companyModelsOnly) managedPolicy.apply({ organizationId: "11111111-1111-4111-8111-111111111111", organizationName: "Fixture Company", expiresAt: Date.now() + 60_000,
      version: 1, companyModelsOnly: true, allowedEngines: "all", mcp: { allowCustom: true, allowlist: [] },
      computers: { thisComputer: true, localVm: true, box: true, vps: true }, remoteAccess: true });
    const managedDesktop = { owns: (instanceId: string) => enrolled && instanceId.startsWith("company.") };
    const describe = vi.fn(async () => instances);
    const defaultSelection = new Function("cfg", "registry", "managedDesktop", "managedPolicy", "BUILT_IN_DRIVERS", "selectDefaultModelSelection", "instanceConfigs", "withInstanceConfig", "testedAi", "store",
      `${code}; return defaultSelection;`)({ defaultModelSelection: saved }, { describe }, managedDesktop, managedPolicy,
      [{ driverKind: "claudeAgent", metadata: { displayName: "Claude" } }], selectDefaultModelSelection, () => withChosen(instances, configs, found), withInstanceConfig,
      { answered: answered ?? (() => undefined) }, { bots, tasks: () => [] }) as (saved?: ModelSelection | null, instances?: readonly SelectableInstance[]) => Promise<ModelSelection>;
    return { defaultSelection, describe, close: () => managedPolicy.close() };
  }

  const freeBackup = { ...codex, instanceId: "opencodeGo", driverKind: "opencodeGo", snapshot: { state: "available", authenticated: false, freeFallback: true } satisfies ProviderSnapshot,
    models: { default: "big-pickle", options: [{ id: "big-pickle", label: "Big Pickle" }] } };
  it("counts as chosen on the server once a bot uses it", async () => {
    const lone = server([claude, freeBackup], { found: ["claude"] });
    await expect(lone.defaultSelection(null)).resolves.toEqual({ instanceId: "opencodeGo", model: "big-pickle" });
    lone.close();
    const used = server([claude, freeBackup], { found: ["claude"], bots: [{ id: "pen", modelSelection: { instanceId: "claude", model: "claude-default" } }] });
    await expect(used.defaultSelection(null)).resolves.toEqual({ instanceId: "claude", model: "claude-default" });
    used.close();
  });

  it("honors a disabled configured provider in both automatic and saved selection", async () => {
    const fixture = server([claude, codex], { configs: { claude: { enabled: false } } });
    await expect(fixture.defaultSelection()).resolves.toEqual({ instanceId: "codex", model: "codex-default" });
    await expect(fixture.defaultSelection({ instanceId: "claude", model: "claude-default" })).resolves.toEqual({ instanceId: "", model: "" });
    fixture.close();
  });

  it("uses configured custom credentials instead of an unrelated account's sign-in state", async () => {
    const fixture = server([signedOut], { configs: { claude: { access: "custom" } } });
    await expect(fixture.defaultSelection({ instanceId: "claude", model: "claude-default" })).resolves.toEqual({ instanceId: "claude", model: "claude-default" });
    fixture.close();
  });

  it("uses a supplied inventory without probing the provider a second time", async () => {
    const fixture = server([claude], { configs: { codex: { chosen: true } } });
    await expect(fixture.defaultSelection(null, [codex])).resolves.toEqual({ instanceId: "codex", model: "codex-default" });
    expect(fixture.describe).not.toHaveBeenCalled();
    fixture.close();
  });

  it("passes the enrolment into the choice, and is the plain choice without one", async () => {
    // Not enrolled, the Company id is an ordinary engine that can run.
    const notEnrolled = server([signedOut, companyClaude]);
    await expect(notEnrolled.defaultSelection()).resolves.toEqual({ instanceId: "company.fixture.anthropic", model: "company-claude" });
    const nothingReady = server([signedOut]);
    await expect(nothingReady.defaultSelection()).resolves.toEqual({ instanceId: "claude", model: "claude-default" });
    const enrolled = server([signedOut, companyClaude], { enrolled: true });
    await expect(enrolled.defaultSelection()).resolves.toEqual({ instanceId: "company.fixture.anthropic", model: "company-claude" });
  });

  it("leaves the saved default out only when asked, for a bot moved off a removed engine", async () => {
    const saved = server([claude, codex], { saved: { instanceId: "computer", model: "claude-fable-5" } });
    await expect(saved.defaultSelection()).resolves.toEqual({ instanceId: "", model: "" });
    await expect(saved.defaultSelection(null)).resolves.toEqual({ instanceId: "claude", model: "claude-default" });
    saved.close();
  });

  it("passes what each AI's test message showed into the choice, and never past a saved default", async () => {
    const claudeSilent = (instance: SelectableInstance) => instance.instanceId === "claude" ? false : undefined;
    await expect(server([claude, codex], { answered: claudeSilent }).defaultSelection()).resolves.toEqual({ instanceId: "codex", model: "codex-default" });
    await expect(server([claude, codex], { answered: claudeSilent, saved: { instanceId: "claude", model: "claude-default" } }).defaultSelection())
      .resolves.toEqual({ instanceId: "claude", model: "claude-default" });
  });

  it("passes the organisation's policy into the choice", async () => {
    const policy = server([claude, companyRouter], { enrolled: true, companyModelsOnly: true });
    await expect(policy.defaultSelection()).resolves.toEqual({ instanceId: "company.fixture.openrouter", model: "company/router" });
    const saved = server([claude, companyRouter], { enrolled: true, companyModelsOnly: true, saved: { instanceId: "claude", model: "claude-default" } });
    await expect(saved.defaultSelection()).resolves.toEqual({ instanceId: "", model: "" });
    policy.close(); saved.close();
  });
});

describe("new bot effort default", () => {
  const selection: ModelSelection = { instanceId: "codex", model: "codex-default" };

  it("adds the workspace effort when the engine offers it", () => {
    expect(withNewBotEffort(selection, "high", ["low", "high"])).toEqual({ ...selection, effort: "high" });
  });

  it("keeps the caller's explicit effort or model variant", () => {
    expect(withNewBotEffort({ ...selection, effort: "low" }, "high", ["low", "high"])).toEqual({ ...selection, effort: "low" });
    const variant = { instanceId: "opencodeGo", model: "provider/model", variant: "minimal" };
    expect(withNewBotEffort(variant, "high", ["high"])).toEqual(variant);
  });

  it("sends no level when none is configured or the engine does not offer it", () => {
    expect(withNewBotEffort(selection, undefined, ["high"])).toEqual(selection);
    expect(withNewBotEffort(selection, "max", ["low", "high"])).toEqual(selection);
    expect(withNewBotEffort(selection, "high", undefined)).toEqual(selection);
  });
});

describe("a hidden provider", () => {
  it("drops out of every selectable list, and an unhidden one comes back", () => {
    const instances = [{ instanceId: "claude" }, { instanceId: "hermes" }] as unknown as SelectableInstance[];
    expect(withInstanceConfig(instances, { hermes: { driver: "fake", hidden: true } }).map((instance) => instance.instanceId)).toEqual(["claude"]);
    expect(withInstanceConfig(instances, { hermes: { driver: "fake" } }).map((instance) => instance.instanceId)).toEqual(["claude", "hermes"]);
  });

  it("is never an automatic pick that reads the registry itself, the free backup and a limit switch included", () => {
    const engines = [{ instanceId: "opencodeGo", driverKind: "opencodeGo" }, { instanceId: "grok", driverKind: "grok" }];
    expect(connectedOnly(engines, { opencodeGo: { driver: "opencodeGo", hidden: true } })).toEqual([engines[1]]);
    expect(connectedOnly(engines, {})).toEqual(engines);
  });
});

describe("a provider found on this computer", () => {
  const free = { ...codex, instanceId: "opencodeGo", driverKind: "opencodeGo", snapshot: { state: "available", authenticated: false, freeFallback: true } satisfies ProviderSnapshot,
    models: { default: "big-pickle", options: [{ id: "big-pickle", label: "Big Pickle" }] } };
  const unused = (_instanceId: string) => false;

  it("is marked found until the person chooses it or something uses it", () => {
    const marked = (configs: Parameters<typeof withInstanceConfig>[1], inUse = unused) =>
      withInstanceConfig([claude, free, { ...codex, access: "api" as const }] as SelectableInstance[], configs, inUse).filter((instance) => instance.found).map((instance) => instance.instanceId);
    expect(marked({})).toEqual(["claude"]);
    expect(marked({ claude: { driver: "claudeAgent", chosen: true } })).toEqual([]);
    expect(marked({}, (id) => id === "claude")).toEqual([]);
    expect(marked({ claude: { driver: "claudeAgent", config: { cli: "/opt/claude" } } })).toEqual([]);
    expect(withInstanceConfig([claude] as SelectableInstance[], {}).some((instance) => instance.found)).toBe(false);
  });

  it("is never picked on its own: new bots stay on the free model and nothing moves off it", () => {
    const found = { ...claude, found: true as const };
    expect(selectDefaultModelSelection([found, free])).toEqual({ instanceId: "opencodeGo", model: "big-pickle" });
    expect(freeBackupOverConnected([found, free], { instanceId: "opencodeGo", model: "big-pickle" })).toBe(false);
    expect(freeBackupOverConnected([claude, free], { instanceId: "opencodeGo", model: "big-pickle" })).toBe(true);
  });

  it("still answers when picked by name", () => {
    expect(selectDefaultModelSelection([{ ...claude, found: true as const }, free], { instanceId: "claude", model: "claude-default" }))
      .toEqual({ instanceId: "claude", model: "claude-default" });
  });

});
