import { describe, expect, it, vi } from "vitest";
import type { InstanceInfo, ModelSelection } from "@/state/store";
import { starKey, toggleStar, parseStarred } from "./starred-models";
import { modelName, providerName, restToggleKey, simpleModelMenu, SIMPLE_SEARCH_AFTER } from "./simple-model-menu";

vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});

type Menu = ReturnType<typeof simpleModelMenu>;
type Option = InstanceInfo["models"]["options"][number];

const claudeModels: Option[] = [
  { id: "sonnet-5", label: "Claude Sonnet 5" },
  { id: "fable-5-1", label: "Claude Fable 5.1" },
  { id: "fable-5", label: "Claude Fable 5" },
  { id: "opus-5-5", label: "Claude Opus 5.5" },
  { id: "opus-5", label: "Claude Opus 5" },
  { id: "haiku-5-5", label: "Claude Haiku 5.5" },
  { id: "haiku-5", label: "Claude Haiku 5" },
  { id: "sonnet-4-5", label: "Claude Sonnet 4.5" },
];
const engine = (instanceId: string, driverKind: string, displayName: string, access: InstanceInfo["access"], options: Option[], extra: Partial<InstanceInfo> = {}): InstanceInfo => ({
  instanceId, driverKind, displayName, access,
  snapshot: { state: "available", version: "1.0.0", authenticated: true },
  models: { default: options.find((option) => !option.custom)?.id ?? "", options },
  ...extra,
});
const claude = (extra: Partial<InstanceInfo> = {}, options = claudeModels) => engine("claude", "claudeAgent", "Claude", "subscription", options, { ...extra, models: { default: "sonnet-5", options } });
const codex = engine("codex", "codex", "Codex", "subscription", [{ id: "gpt-5.6", label: "GPT-5.6" }, { id: "gpt-5.6-mini", label: "GPT-5.6 mini" }, { id: "gpt-5.5", label: "GPT-5.5" }]);
const cursor = engine("cursor", "cursorAgent", "Cursor", "subscription", [{ id: "auto", label: "Auto" }]);
const openaiKey = engine("openai", "openai-compat", "OpenAI", "api", [{ id: "gpt-5.6", label: "GPT-5.6" }]);
const claudeKey = engine("claudeApi", "claudeAgent", "Claude (API key)", "api", claudeModels.slice(0, 2));
const pi = engine("pi", "piAgent", "pi", "custom", [
  { id: "llama", label: "Llama 4", custom: true },
  { id: "gemma", label: "Gemma 4", custom: true, loaded: true },
]);
const sonnet: ModelSelection = { instanceId: "claude", model: "sonnet-5" };

function menu(listed: InstanceInfo[], options: Partial<Parameters<typeof simpleModelMenu>[0]> = {}): Menu {
  return simpleModelMenu({
    instances: listed, listed, selection: sonnet,
    bot: { name: "Pepper", selection: sonnet },
    query: "", expanded: new Set(), probing: new Set(), loading: false,
    ...options,
  });
}
const rows = (built: Menu, index = 0) => {
  const body = built.groups[index]!.body;
  return body.kind === "models" ? body.rows.map((row) => row.label) : [];
};
const body = (built: Menu, index = 0) => built.groups[index]!.body;

describe("the Simple model menu", () => {
  it("puts the current model on top, then the rest of its provider under a heading, in short names", () => {
    const built = menu([claude()]);
    expect(built.current).toMatchObject({ label: "Claude Sonnet 5", title: "Claude · Claude Sonnet 5", warning: false, pending: false });
    expect(built.current!.meta).toBeUndefined();
    expect(built.groups.map((group) => group.label)).toEqual(["Claude"]);
    expect(rows(built)).toEqual(["Fable 5.1", "Fable 5", "Opus 5.5", "Opus 5"]);
    expect(body(built)).toMatchObject({ kind: "models", total: 8, toggle: "more" });
    expect(built.search).toBe(false);
  });

  it("opens a group's whole list in place, keeping its suggestions first, and folds it back", () => {
    const opened = menu([claude()], { expanded: new Set(["claude"]) });
    expect(rows(opened)).toEqual(["Fable 5.1", "Fable 5", "Opus 5.5", "Opus 5", "Haiku 5.5", "Haiku 5", "Sonnet 4.5"]);
    expect(body(opened)).toMatchObject({ toggle: "less" });
  });

  it("shows the one model a toggle would hide instead of the toggle", () => {
    const built = menu([claude({}, claudeModels.slice(0, 6))]);
    expect(rows(built)).toEqual(["Fable 5.1", "Fable 5", "Opus 5.5", "Opus 5", "Haiku 5.5"]);
    expect(body(built)).toMatchObject({ toggle: null });
  });

  it("lists every ready provider at once: the current one first, then sign-ins, API keys and local engines", () => {
    const built = menu([codex, openaiKey, pi, claude(), claudeKey]);
    expect(built.groups.map((group) => group.label)).toEqual(["Claude", "OpenAI", "OpenAI · API key", "Claude · API key", "pi"]);
    expect(rows(built, 1)).toEqual(["GPT-5.6", "GPT-5.6 mini", "GPT-5.5"]);
    expect(rows(built, 3)).toEqual(["Sonnet 5", "Fable 5.1"]);
  });

  it("offers three suggestions in a provider that does not hold the current model", () => {
    const built = menu([claude(), engine("other", "codex", "Codex", "subscription", claudeModels.slice(0, 5))]);
    expect(rows(built, 1)).toHaveLength(3);
    expect(body(built, 1)).toMatchObject({ toggle: "more", total: 5 });
  });

  it("leaves out a provider whose only model is the current one", () => {
    expect(menu([cursor], { selection: { instanceId: "cursor", model: "auto" } }).groups).toEqual([]);
  });

  it("names each signed-in account of one family, and keeps a signed-out sibling apart, to connect", () => {
    const work = engine("claude-work", "claudeAgent", "Work", "subscription", claudeModels.slice(0, 2));
    const home = { ...engine("claude-home", "claudeAgent", "Home", "subscription", claudeModels.slice(0, 2)),
      snapshot: { state: "available" as const, authenticated: false } };
    const built = menu([claude(), work, home]);
    expect(built.groups.map((group) => [group.label, group.body.kind])).toEqual([["Claude", "models"], ["Claude · Work", "models"]]);
    expect(built.connect.map((group) => [group.label, group.body.kind])).toEqual([["Claude · Home", "signIn"]]);
    expect(built.groups[1]).toMatchObject({ provider: "Claude", account: "Work" });
    expect(built.current!.meta).toBe("Claude");
  });

  it("says why a provider cannot run: set up, sign in, managed, or nothing listed yet", () => {
    const missing = { ...cursor, snapshot: { state: "unavailable" as const, reason: "not found" } };
    const signedOut = { ...codex, snapshot: { state: "available" as const, authenticated: false } };
    const managed = { ...openaiKey, policy: { organizationName: "Acme", reason: "Company models only." } };
    const plan = engine("chatgpt", "codex", "ChatGPT plan", "subscription", [], { snapshot: { state: "available", authenticated: true, chatgptPlan: true } });
    const built = menu([claude(), missing, signedOut, managed, plan]);
    expect(Object.fromEntries(built.groups.map((group) => [group.instance.instanceId, group.body]))).toEqual({
      claude: expect.objectContaining({ kind: "models" }), openai: { kind: "policy", organization: "Acme" }, chatgpt: { kind: "empty", loading: false },
    });
    // the ones waiting for a setup or a sign-in go to Not connected
    expect(Object.fromEntries(built.connect.map((group) => [group.instance.instanceId, group.body]))).toEqual({
      cursor: { kind: "setUp" }, codex: { kind: "signIn" },
    });
  });

  it("says a provider is loading its models while it lists them, and offers to check again once it lists none", () => {
    const unlisted = claude({}, []);
    const loading = menu([unlisted], { refreshing: "claude" });
    expect(loading.current).toMatchObject({ label: "sonnet-5", pending: true });
    expect(body(loading)).toEqual({ kind: "empty", loading: true });
    expect(body(menu([unlisted]))).toEqual({ kind: "empty", loading: false });
    expect(menu([unlisted]).current).toMatchObject({ pending: false });
  });

  it("keeps a signed-out engine's local models with a way to sign in for its own", () => {
    const signedOut = claude({ snapshot: { state: "available", authenticated: false } }, [...claudeModels, { id: "ollama::qwen3", label: "qwen3 (Ollama)", custom: true }]);
    const built = menu([signedOut], { selection: { instanceId: "claude", model: "ollama::qwen3" } });
    expect(built.current).toMatchObject({ label: "qwen3 (Ollama)", warning: false });
    expect(body(built)).toMatchObject({ kind: "models", rows: [], signInForOwn: true });
    const onOfficial = menu([signedOut]);
    expect(onOfficial.current).toMatchObject({ meta: "Sign-in required", warning: true });
    expect(rows(onOfficial)).toEqual(["qwen3 (Ollama)"]);
  });

  it("marks local models apart only where a provider mixes them with its own", () => {
    const withLocal = claude({}, [...claudeModels.slice(0, 2), { id: "ollama::qwen3", label: "qwen3 (Ollama)", custom: true }]);
    expect(body(menu([withLocal]))).toMatchObject({ localFrom: 1 });
    expect(body(menu([claude(), pi]), 1)).toMatchObject({ localFrom: null });
    expect(rows(menu([claude(), pi]), 1)).toEqual(["Gemma 4", "Llama 4"]);
  });

  it("says it is looking for local models while a provider with none yet is probed", () => {
    expect(body(menu([claude()], { probing: new Set(["claude"]) }))).toMatchObject({ probing: true });
    const withLocal = claude({}, [...claudeModels, { id: "ollama::qwen3", label: "qwen3 (Ollama)", custom: true }]);
    expect(body(menu([withLocal], { probing: new Set(["claude"]) }))).toMatchObject({ probing: false });
  });

  it("tells same-named models apart by their route", () => {
    const routes = engine("pi", "piAgent", "pi", "custom", [
      { id: "anthropic/sonnet", label: "Claude Sonnet 4.5", custom: true, provider: "anthropic" },
      { id: "bedrock/sonnet", label: "Claude Sonnet 4.5", custom: true, provider: "amazon-bedrock" },
      { id: "openai/gpt", label: "GPT-5.6", custom: true, provider: "openai" },
    ]);
    const piRows = (menu([claude(), routes]).groups[1]!.body as Extract<Menu["groups"][number]["body"], { kind: "models" }>).rows;
    expect(piRows.map((row) => [row.label, row.route])).toEqual([
      ["Claude Sonnet 4.5", "anthropic"], ["Claude Sonnet 4.5", "amazon-bedrock"], ["GPT-5.6", undefined],
    ]);
  });

  it("offers the bot's model to a thread on its own once, in the follow row, not again in its provider", () => {
    const own = menu([claude(), codex], { bot: { name: "Pepper", selection: { instanceId: "codex", model: "gpt-5.6" }, follows: false } });
    expect(own.follow).toBe(true);
    expect(rows(own, 1)).toEqual(["GPT-5.6 mini", "GPT-5.5"]);
    const onlyModel = menu([claude(), cursor], { bot: { name: "Pepper", selection: { instanceId: "cursor", model: "auto" }, follows: false } });
    expect(onlyModel.groups.map((group) => group.label)).toEqual(["Claude"]);
    expect(rows(menu([claude(), codex], { bot: { name: "Pepper", selection: { instanceId: "codex", model: "gpt-5.6" } } }), 1))
      .toEqual(["GPT-5.6", "GPT-5.6 mini", "GPT-5.5"]);
    const router = engine("router", "openai-compat", "OpenRouter", "api", [1, 2, 3, 4].map((index) => ({ id: `r-${index}`, label: `Router ${index}` })));
    const searched = menu([claude(), codex, router], { query: "gpt-5.6", bot: { name: "Pepper", selection: { instanceId: "codex", model: "gpt-5.6" }, follows: false } });
    expect(searched.follow).toBe(false);
    expect(rows(searched)).toEqual(["GPT-5.6", "GPT-5.6 mini"]);
  });

  it("names a model the catalog calls by one bare word with its provider, wherever no heading is beside it", () => {
    const auto = menu([claude(), cursor], { selection: { instanceId: "cursor", model: "auto" } });
    expect(auto.current).toMatchObject({ label: "Cursor Auto", title: "Cursor · Auto" });
    expect(modelName(cursor, "auto")).toBe("Cursor Auto");
    expect(modelName(claude(), "sonnet-5")).toBe("Claude Sonnet 5");
    expect(modelName(codex, "gpt-5.6")).toBe("GPT-5.6");
    expect(modelName(pi, "llama")).toBe("Llama 4");
    expect(modelName(undefined, "gone-model")).toBe("gone-model");
    expect(modelName(cursor, "gone-model")).toBe("gone-model");
  });

  it("names the picked Antigravity thinking level on the current model, as its row in the list does (#4160)", () => {
    const variants = [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }];
    const gemini = engine("antigravity", "antigravityAgent", "Google Gemini", "subscription", [
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", variants },
    ], { capabilities: { modelVariants: true } });
    const picked = menu([gemini], { selection: { instanceId: "antigravity", model: "gemini-3.8-flash", variant: "medium" } });
    expect(picked.current).toMatchObject({ label: "Gemini 3.8 Flash · Medium" });
    expect(picked.current?.title).toBe("Google Gemini · Gemini 3.8 Flash · Medium");
    const pickedLow = menu([gemini], { selection: { instanceId: "antigravity", model: "gemini-3.8-flash", variant: "low" } });
    expect(pickedLow.current).toMatchObject({ label: "Gemini 3.8 Flash · Low" });
    expect(rows(picked)).toEqual(["Gemini 3.8 Flash · Low"]);
    expect(modelName(gemini, "gemini-3.8-flash")).toBe("Gemini 3.8 Flash");
    expect(modelName(gemini, "gemini-3.8-flash", "gone")).toBe("Gemini 3.8 Flash");
    expect(modelName({ ...gemini, driverKind: "opencodeGo" }, "gemini-3.8-flash", "medium")).toBe("Gemini 3.8 Flash");
    expect(modelName(gemini, "gemini-3.8-flash", "low")).toBe("Gemini 3.8 Flash · Low");
  });

  it("is busy while the menu reads its providers or one provider's models", () => {
    expect(menu([claude()]).busy).toBe(false);
    expect(menu([claude()], { loading: true }).busy).toBe(true);
    expect(menu([claude()], { refreshing: "claude" }).busy).toBe(true);
  });

  it("says on the current model when the thread follows its bot, and offers no follow row then", () => {
    const built = menu([claude()], { bot: { name: "Pepper", selection: sonnet, follows: true } });
    expect(built.current!.meta).toBe("Pepper's model");
    expect(built.follow).toBe(false);
    expect(menu([claude()]).follow).toBe(false);
  });

  it("shows a model whose engine has not loaded as waiting, then as unavailable", () => {
    expect(menu([], { loading: true }).current).toMatchObject({ label: "sonnet-5", pending: true });
    expect(menu([], { loading: true }).empty).toBe("loading");
    expect(menu([]).current).toMatchObject({ meta: "Unavailable", warning: true, pending: false });
    expect(menu([]).empty).toBe("none");
  });

  it("counts only models a person can pick toward the search box", () => {
    const missing = engine("cursor", "cursorAgent", "Cursor", "subscription", claudeModels.slice(0, 6), { snapshot: { state: "unavailable", reason: "not found" } });
    const managed = { ...engine("router", "openai-compat", "Router", "api", claudeModels), policy: { organizationName: "Acme", reason: "No." } };
    expect(menu([claude(), missing, managed]).search).toBe(false);
  });

  it("searches only past twelve models, across every provider, with the current model checked in place", () => {
    expect(menu([claude(), codex]).search).toBe(false);
    const many = engine("router", "openai-compat", "OpenRouter", "api",
      Array.from({ length: SIMPLE_SEARCH_AFTER }, (_, index) => ({ id: `model-${index}`, label: `Router ${index}` })));
    expect(menu([claude(), many], { query: "sonnet" }).search).toBe(true);
    const found = menu([claude(), codex, many], { query: "sonnet 5" });
    expect(found.current).toBeNull();
    expect(found.groups.map((group) => group.label)).toEqual(["Claude"]);
    expect((found.groups[0]!.body as Extract<Menu["groups"][number]["body"], { kind: "models" }>).rows.map((row) => [row.label, row.current]))
      .toEqual([["Sonnet 5", true]]);
    expect(found.results).toBe(1);
    expect(menu([claude(), codex, many], { query: "zzz" })).toMatchObject({ groups: [], results: 0 });
  });
});

describe("a model the organization turned off", () => {
  const blockedModels = claudeModels.map((option) => option.id === "opus-5-5" ? { ...option, orgBlocked: true as const } : option);
  const pick = (model: string) => ({ instanceId: "claude", model });
  const menuOn = (model: string) => simpleModelMenu({
    instances: [claude({}, blockedModels)], listed: [claude({}, blockedModels)], selection: pick(model),
    bot: { name: "Scout", selection: pick(model) }, query: "", expanded: new Set(["claude"]), probing: new Set(), loading: false,
  });

  it("stays listed, marked, among the others", () => {
    const body = menuOn("sonnet-5").groups[0]!.body;
    if (body.kind !== "models") throw new Error("expected the models");
    expect(body.rows.filter((row) => row.blocked).map((row) => row.option.id)).toEqual(["opus-5-5"]);
    expect(body.rows.length).toBeGreaterThan(1);
  });

  it("says so on the current row, with nothing to set up", () => {
    expect(menuOn("opus-5-5").current).toMatchObject({ warning: true, blocked: true, meta: "Turned off by your organization" });
    expect(menuOn("sonnet-5").current?.blocked).toBeUndefined();
  });
});

describe("OpenCode's free models", () => {
  const freeOptions: Option[] = [
    { id: "opencode/beam-free", label: "Zen · Beam Free" },
    { id: "opencode/glm-5.3-flash-free", label: "Zen · Glm 5.3 Flash Free" },
    { id: "opencode/minimax-m3.1-flash-free", label: "Zen · Minimax M3.1 Flash Free" },
    { id: "opencode/longcat-2.5-free", label: "Zen · Longcat 2.5 Free" },
    { id: "opencode/nemotron-3.5-lightning-free", label: "Zen · Nemotron 3.5 Lightning Free" },
    { id: "opencode/claude-opus-5", label: "Zen · Claude Opus 5" },
    { id: "opencode/gpt-6-sol", label: "Zen · GPT 6 Sol" },
  ];
  const fake = { state: "available", version: "1.0.0", authenticated: true, freeFallback: true } as const;
  const free = engine("opencode", "opencodeGo", "OpenCode", "subscription", freeOptions,
    { models: { default: "opencode/beam-free", options: freeOptions }, snapshot: { ...fake } });

  it("goes by OpenCode, and the current row names the free model it runs", () => {
    const built = menu([free, claude()], { selection: { instanceId: "opencode", model: "opencode/beam-free" } });
    expect(providerName(free)).toBe("OpenCode");
    expect(built.current).toMatchObject({ label: "Beam Free", title: "A free model from OpenCode, so you can start right away. Connect your own AI any time." });
    expect(built.groups.map((group) => group.label)).toEqual(["OpenCode", "Claude"]);
    expect(built.groups[0]!.note).toBe("Free, no account needed.");
    expect(modelName(free, "opencode/glm-5.3-flash-free")).toBe("Glm 5.3 Flash Free");
    // a label the CLI gives without a provider in front keeps all of its name
    expect(modelName({ ...free, models: { default: "opencode/plain", options: [{ id: "opencode/plain", label: "Plain" }] } }, "opencode/plain"))
      .toBe("Plain");
  });

  it("lists its free models by name, and opens the rest of them in place", () => {
    const built = menu([claude(), free]);
    expect(built.groups.map((group) => group.label)).toEqual(["Claude", "OpenCode"]);
    expect(rows(built, 1)).toEqual(["Beam Free", "Glm 5.3 Flash Free", "Minimax M3.1 Flash Free"]);
    expect(body(built, 1)).toMatchObject({ kind: "models", total: 5, toggle: "more" });
    const opened = menu([claude(), free], { expanded: new Set(["opencode"]) });
    expect(rows(opened, 1)).toEqual(["Beam Free", "Glm 5.3 Flash Free", "Minimax M3.1 Flash Free", "Longcat 2.5 Free", "Nemotron 3.5 Lightning Free"]);
  });

  it("folds the models that need a login away behind one row", () => {
    const folded = menu([claude(), free]);
    expect(body(folded, 1)).toMatchObject({ rest: { rows: [], total: 2, open: false } });
    const opened = menu([claude(), free], { expanded: new Set([restToggleKey("opencode")]) });
    const rest = (body(opened, 1) as { rest?: { rows: { label: string }[]; total: number; open: boolean } }).rest!;
    expect(rest).toMatchObject({ total: 2, open: true });
    expect(rest.rows.map((row) => row.label)).toEqual(["Claude Opus 5", "GPT 6 Sol"]);
    expect(rows(opened, 1)).not.toContain("Claude Opus 5");
  });

  it("keeps a picked model a login made paid on the current row, out of the other models", () => {
    const selection = { instanceId: "opencode", model: "opencode/claude-opus-5" };
    expect(menu([claude(), free], { selection }).current).toMatchObject({ label: "Claude Opus 5", title: "OpenCode · Claude Opus 5" });
    const opened = menu([claude(), free], { selection, expanded: new Set([restToggleKey("opencode")]) });
    const rest = (body(opened) as { rest?: { rows: { label: string }[] } }).rest!;
    expect(rest.rows.map((row) => row.label)).toEqual(["GPT 6 Sol"]);
  });

  it("answers a search with its free models by name, and with the paid ones", () => {
    const searched = menu([claude(), free], { query: "free", searchAll: true });
    expect(searched.groups.map((group) => group.label)).toEqual(["OpenCode"]);
    expect(rows(searched)).toEqual(["Beam Free", "Glm 5.3 Flash Free", "Minimax M3.1 Flash Free", "Longcat 2.5 Free", "Nemotron 3.5 Lightning Free"]);
    const opus = menu([claude(), free], { query: "opus", searchAll: true }).groups.find((group) => group.label === "OpenCode")!;
    expect(opus.body.kind === "models" && opus.body.rows.map((row) => row.label)).toEqual(["Claude Opus 5"]);
  });

  it("treats every model as free when the catalog marks none, as an older CLI does", () => {
    const plain: Option[] = [{ id: "opencode/alpha", label: "Zen · Alpha" }, { id: "opencode/beta", label: "Zen · Beta" }];
    const unmarked = engine("opencode", "opencodeGo", "OpenCode", "subscription", plain,
      { models: { default: "opencode/alpha", options: plain }, snapshot: { ...fake } });
    const built = menu([unmarked]);
    expect(rows(built)).toEqual(["Alpha", "Beta"]);
    expect(body(built)).toMatchObject({ total: 2, toggle: null });
    expect((body(built) as { rest?: unknown }).rest).toBeUndefined();
  });

  describe("starred models", () => {
    const stars = [starKey("codex", "gpt-5.5"), starKey("claude", "opus-5")];

    it("lists them in starred order across providers, and keeps them in their group", () => {
      const built = menu([claude(), codex], { starred: stars });
      expect(built.starred.map((entry) => [entry.provider, entry.row.label])).toEqual([["OpenAI", "GPT-5.5"], ["Claude", "Opus 5"]]);
      expect(built.starred.every((entry) => entry.row.starred)).toBe(true);
      expect(rows(built)).toContain("Opus 5");
      const group = built.groups.find((one) => one.provider === "Claude")!.body;
      expect(group.kind === "models" && group.rows.find((row) => row.label === "Opus 5")?.starred).toBe(true);
    });

    it("lists a starred model that the group folds away, and skips one that no longer exists", () => {
      const built = menu([claude()], { starred: [starKey("claude", "sonnet-4-5"), starKey("claude", "gone")] });
      expect(built.starred.map((entry) => entry.row.label)).toEqual(["Sonnet 4.5"]);
    });

    it("stays out of a search, and is empty with no stars", () => {
      expect(menu([claude()]).starred).toEqual([]);
      expect(menu([claude(), codex], { starred: stars, query: "opus", searchAll: true }).starred).toEqual([]);
    });

    it("toggles in order and reads a damaged value as none", () => {
      expect(toggleStar(toggleStar([], "a"), "b")).toEqual(["a", "b"]);
      expect(toggleStar(["a", "b"], "a")).toEqual(["b"]);
      expect(parseStarred("{oops")).toEqual([]);
      expect(parseStarred('["a",3,"a"]')).toEqual(["a"]);
    });
  });
});
