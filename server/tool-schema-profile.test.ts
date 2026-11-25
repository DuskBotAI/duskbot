import { describe, expect, it } from "vitest";

import { TOOL_LIST as BROWSER_TOOLS } from "./browser/tools.ts";
import { DATA_TOOLS } from "./data/tools.ts";
import bridgedAgents from "./drivers/agents-catalog-goldens/bridged.tools-list.json" with { type: "json" };
import fullAgents from "./drivers/agents-catalog-goldens/full.tools-list.json" with { type: "json" };
import { createPageSchema, wideSchema } from "./testing/oversized-tool-schema.ts";
import { fitToolSchema, isRe2Compatible, schemaBytes, toolSchemaProfile, toolSchemaProfileFor, type ToolSchemaProfile } from "./tool-schema-profile.ts";

type Json = Record<string, unknown>;
const MOONSHOT = toolSchemaProfile("moonshot")!;
const ANTIGRAVITY = toolSchemaProfile("antigravity")!;
const isObject = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** What Moonshot's validator (walle, MFJS) rejects in a fitted schema: an untyped subschema, a `required` name with no
 * property, or a reference left behind. */
function mfjsProblems(schema: Json): string[] {
  const problems: string[] = [];
  const visit = (node: unknown, path: string, root = false) => {
    if (!isObject(node)) return;
    if (!root && !("type" in node) && !("anyOf" in node)) problems.push(`${path}: no type`);
    if ("$ref" in node || "$defs" in node) problems.push(`${path}: reference`);
    if (Array.isArray(node.required) && node.required.some((key) => !isObject(node.properties) || !Object.hasOwn(node.properties, key as string))) {
      problems.push(`${path}: required names an undeclared property`);
    }
    if (isObject(node.properties)) for (const [key, child] of Object.entries(node.properties)) visit(child, `${path}.${key}`);
    if (isObject(node.items)) visit(node.items, `${path}[]`);
    if (Array.isArray(node.anyOf)) node.anyOf.forEach((branch, index) => visit(branch, `${path}|${index}`));
  };
  visit(schema, "root", true);
  return problems;
}

/** Every property path with its declared type, through items and alternatives. */
function typedPaths(schema: unknown, path = "", out = new Map<string, string>()): Map<string, string> {
  if (!isObject(schema)) return out;
  if (path && "type" in schema) out.set(path, JSON.stringify(schema.type));
  if (isObject(schema.properties)) for (const [key, child] of Object.entries(schema.properties)) typedPaths(child, `${path}.${key}`, out);
  if (isObject(schema.items)) typedPaths(schema.items, `${path}[]`, out);
  if (Array.isArray(schema.anyOf)) schema.anyOf.forEach((branch) => typedPaths(branch, path, out));
  return out;
}

function inlined(schema: Json): Json {
  const defs = isObject(schema.$defs) ? schema.$defs : {};
  const resolve = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(resolve);
    if (!isObject(node)) return node;
    if (typeof node.$ref === "string") return resolve(defs[node.$ref.replace("#/$defs/", "")]);
    return Object.fromEntries(Object.entries(node).filter(([key]) => key !== "$defs").map(([key, value]) => [key, resolve(value)]));
  };
  return resolve(schema) as Json;
}

describe("fitting a tool schema to Moonshot's per-tool limit", () => {
  it("measures as Go's encoding/json does, so <, > and & count six bytes each", () => {
    expect(schemaBytes({ a: "x" })).toBe(9);
    expect(schemaBytes({ a: "<&>" })).toBe(9 + 2 + 15);
    expect(schemaBytes({ a: "é" })).toBe(10);
  });

  it("leaves a schema within the limit exactly as the server sent it", () => {
    const schema = { type: "object", properties: { query: { type: "string", description: "What to find." } }, required: ["query"] };
    const fit = fitToolSchema(schema, MOONSHOT);
    expect(fit).toEqual({ outcome: "kept", schema, bytes: schemaBytes(schema) });
    expect(fit.outcome === "kept" && fit.schema).toBe(schema);
  });

  it("measures a schema with its refs inlined, as Kimi Code sends it", () => {
    const schema = createPageSchema();
    expect(schemaBytes(schema)).toBeLessThan(12_000);
    expect(schemaBytes(inlined(schema))).toBeGreaterThan(20_000);
    expect(fitToolSchema(schema, MOONSHOT).outcome).not.toBe("kept");
  });

  it("fits a realistic oversized schema under the limit and keeps its meaning", () => {
    const original = createPageSchema();
    const fit = fitToolSchema(original, MOONSHOT);
    if (fit.outcome === "kept" || fit.outcome === "dropped") throw new Error(`unexpected ${fit.outcome}`);
    expect(fit.outcome).toBe("loosened");
    expect(fit.bytes).toBeLessThanOrEqual(12_000);
    expect(schemaBytes(fit.schema)).toBe(fit.bytes);
    expect(mfjsProblems(fit.schema)).toEqual([]);
    expect(fit.schema.required).toEqual(["parent", "title"]);
    expect(Object.keys(fit.schema.properties as Json)).toEqual(["parent", "title", "icon", "children"]);
    const before = typedPaths(inlined(original));
    const after = typedPaths(fit.schema);
    expect(after.size).toBeGreaterThan(20);
    for (const [path, type] of after) expect([path, before.get(path)]).toEqual([path, type]);
    expect((fit.schema.properties as Json).parent).toMatchObject({ description: expect.stringContaining("Where the page goes") });
    expect(JSON.stringify(fit.schema)).not.toMatch(/"\$schema"|"title":"paragraph"/);
  });

  it("first only drops words: every field, type and constraint stays", () => {
    const schema = {
      type: "object",
      properties: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`item_${index}`, {
        type: "object",
        description: `Item ${index}.`,
        properties: { amount: { type: "integer", minimum: 0, maximum: 500, description: "An amount in cents. ".repeat(40) }, unit: { type: "string", enum: ["usd", "eur"] } },
        required: ["amount"],
      }])),
      required: ["item_0"],
    };
    const fit = fitToolSchema(schema, MOONSHOT);
    expect(fit.outcome).toBe("trimmed");
    if (fit.outcome !== "trimmed") return;
    const withoutNestedWords = structuredClone(schema) as Json;
    for (const item of Object.values(withoutNestedWords.properties as Json)) delete ((item as Json).properties as { amount: Json }).amount.description;
    expect(fit.schema).toEqual(withoutNestedWords);
  });

  it("keeps only the top-level fields when nothing less fits, and leaves out a tool even those overflow", () => {
    const wide = fitToolSchema(wideSchema(110), MOONSHOT);
    expect(wide.outcome).toBe("minimal");
    if (wide.outcome !== "minimal") return;
    expect(wide.bytes).toBeLessThanOrEqual(12_000);
    expect(Object.keys(wide.schema.properties as Json)).toHaveLength(110);
    expect(wide.schema).toMatchObject({ type: "object", required: ["field_000"], additionalProperties: true });
    expect((wide.schema.properties as Json).field_007).toEqual({ type: "object", additionalProperties: true, description: "Settings group 7." });
    expect(mfjsProblems(wide.schema)).toEqual([]);

    const fit = fitToolSchema(wideSchema(400), MOONSHOT);
    expect(fit.outcome).toBe("dropped");
    expect(fit.bytes).toBeGreaterThan(12_000);
  });

  it("brings a schema deeper than the depth limit back within it", () => {
    let deep: Json = { type: "string" };
    for (let level = 0; level < 40; level += 1) deep = { type: "object", properties: { next: deep } };
    const fit = fitToolSchema(deep, MOONSHOT);
    expect(fit.outcome).toBe("loosened");
    let depth = 0;
    for (let node = fit.outcome === "loosened" ? fit.schema : {}; isObject(node.properties); node = (node.properties as Json).next as Json) depth += 1;
    expect(depth).toBeLessThanOrEqual(30);
  });

  it("keeps a cyclic reference it cannot inline, measured beside its definition", () => {
    const tree = { type: "object", $defs: { node: { type: "object", properties: { name: { type: "string" }, children: { type: "array", items: { $ref: "#/$defs/node" } } } } },
      properties: { root: { $ref: "#/$defs/node" } } };
    expect(fitToolSchema(tree, MOONSHOT).outcome).toBe("kept");
  });
});

describe("fitting a tool schema to Antigravity's RE2 regex rules", () => {
  it("recognises valid Go RE2 patterns and rejects Perl-only or invalid syntax", () => {
    for (const valid of [
      "^[a-z0-9](?:[a-z0-9]|-[a-z0-9]){0,38}$",
      "^[a-z0-9-]+$",
      "(?i)^[a-z]+$",
      "(?P<owner>[a-z0-9-]+)/(?P<repo>[a-z0-9._-]+)",
      "^[[:alpha:]_][[:alnum:]_-]*$",
      "^[(?=]+$",
      "^\\(?=literal$",
      "^\\Q(?=literal)\\E$",
      "^\\p{L}+$",
      "^\\pL+$",
      "^a+?$",
      "^[]a]$",
    ]) {
      expect([valid, isRe2Compatible(valid)]).toEqual([valid, true]);
    }

    for (const invalid of [
      "^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$",
      "^(?!admin)[a-z]+$",
      "(?<=@)[a-z]+",
      "(?<!foo)bar",
      "(?<owner>[a-z]+)",
      "(?>abc)",
      "^([a-z]+)-\\1$",
      "^(?P<a>[a-z]+)-\\k<a>$",
      "^[a-z]++$",
      "^a*+$",
      "^a{1,5}+$",
      "^[\\u0041-\\u005A]+$",
      "^\\u{1F600}$",
      "^\\p{Script=Latin}+$",
      "^foo\\Z$",
      "^[\\b]+$",
      "^[]$",
      "^[^]$",
      "^a{1001}$",
      "^a{5,2}$",
      "^(unclosed",
      "^\\é$",
    ]) {
      expect([invalid, isRe2Compatible(invalid)]).toEqual([invalid, false]);
    }
  });

  it("keeps RE2-compatible schemas untouched and strips unsupported pattern and patternProperties without mutating input", () => {
    const clean = {
      type: "object",
      properties: { owner: { type: "string", pattern: "^[a-z0-9-]+$" } },
      required: ["owner"],
    };
    const kept = fitToolSchema(clean, ANTIGRAVITY);
    expect(kept.outcome).toBe("kept");
    if (kept.outcome === "kept") expect(kept.schema).toBe(clean);

    const original = {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description: "Repository owner.",
          pattern: "^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$",
          minLength: 1,
        },
        repo: { type: "string", pattern: "^[a-z0-9._-]+$" },
        labels: {
          type: "object",
          patternProperties: {
            "^(?!_)[a-z]+$": { type: "string" },
            "^ok_[0-9]+$": { type: "string", pattern: "^(?<=v)[0-9]+$" },
          },
          additionalProperties: false,
        },
      },
      $defs: {
        slug: { type: "string", pattern: "^(?!-)[a-z-]+$" },
      },
      required: ["owner", "repo"],
    };
    const snapshot = JSON.stringify(original);
    const fit = fitToolSchema(original, ANTIGRAVITY);
    expect(JSON.stringify(original)).toBe(snapshot);
    expect(fit.outcome).toBe("sanitized");
    if (fit.outcome !== "sanitized") return;
    expect(fit.droppedPatterns).toBe(4);
    expect(fit.schema).toEqual({
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner.", minLength: 1 },
        repo: { type: "string", pattern: "^[a-z0-9._-]+$" },
        labels: {
          type: "object",
          patternProperties: {
            "^ok_[0-9]+$": { type: "string" },
          },
          additionalProperties: true,
        },
      },
      $defs: {
        slug: { type: "string" },
      },
      required: ["owner", "repo"],
    });
  });

  it("removes patternProperties entirely when every key is non-RE2", () => {
    const schema = {
      type: "object",
      patternProperties: { "^(?!_)[a-z]+$": { type: "string" } },
      additionalProperties: false,
    };
    const fit = fitToolSchema(schema, ANTIGRAVITY);
    expect(fit.outcome).toBe("sanitized");
    if (fit.outcome !== "sanitized") return;
    expect(fit.schema).toEqual({ type: "object", additionalProperties: true });
  });
});

describe("which turns carry a schema profile", () => {
  it("is Kimi Code's engine, Moonshot's own endpoint, or a Moonshot model on OpenRouter", () => {
    expect(toolSchemaProfileFor({ engine: "kimiAgent" })).toBe(MOONSHOT);
    expect(toolSchemaProfileFor({ url: "https://api.moonshot.ai/v1" })).toBe(MOONSHOT);
    expect(toolSchemaProfileFor({ url: "https://api.moonshot.cn/v1", model: "kimi-k2.6" })).toBe(MOONSHOT);
    expect(toolSchemaProfileFor({ url: "https://openrouter.ai/api/v1", model: "moonshotai/kimi-k2.6" })).toBe(MOONSHOT);
  });

  it("is Antigravity's engine for RE2 regex sanitization and always-load metadata", () => {
    expect(toolSchemaProfileFor({ engine: "antigravityAgent" })).toBe(ANTIGRAVITY);
    expect(ANTIGRAVITY.alwaysLoadMeta).toBe("antigravity/alwaysLoad");
    expect(MOONSHOT.alwaysLoadMeta).toBeUndefined();
  });

  it("is no other engine or endpoint, so their tool lists are unchanged", () => {
    for (const engine of ["claudeAgent", "codex", "geminiAgent", "grokAgent", "opencodeGo", "qwenAgent", "cursorAgent", "hermesAgent"]) {
      expect(toolSchemaProfileFor({ engine, model: "kimi-k2.6" })).toBeUndefined();
    }
    expect(toolSchemaProfileFor({ url: "https://api.groq.com/openai/v1", model: "moonshotai/kimi-k2-instruct-0905" })).toBeUndefined();
    expect(toolSchemaProfileFor({ url: "https://openrouter.ai/api/v1", model: "openai/gpt-5" })).toBeUndefined();
    expect(toolSchemaProfileFor({ url: "https://moonshot.ai.example.com/v1" })).toBeUndefined();
    expect(toolSchemaProfileFor({ url: "not a url" })).toBeUndefined();
    expect(toolSchemaProfile("__proto__")).toBeUndefined();
  });
});

describe("dusk bot's own tools", () => {
  const catalogs: Array<[string, ReadonlyArray<{ name: string; inputSchema: unknown }>]> = [
    ["agents (full)", fullAgents.tools], ["agents (bridged)", bridgedAgents.tools], ["browser", BROWSER_TOOLS],
    ["data", DATA_TOOLS],
  ];

  it.each(catalogs)("fit every profile as written: %s", (_name, tools) => {
    const profiles: ToolSchemaProfile[] = [MOONSHOT, ANTIGRAVITY];
    for (const profile of profiles) {
      for (const tool of tools) expect([tool.name, fitToolSchema(tool.inputSchema as Json, profile).outcome]).toEqual([tool.name, "kept"]);
    }
  });
});
