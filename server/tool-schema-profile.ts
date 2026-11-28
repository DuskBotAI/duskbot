// A provider's limits on one tool's parameters schema. Fitting keeps the schema the model reads under them; the server
// still validates every call against its own full schema.
type Json = Record<string, unknown>;

export type ToolSchemaProfileId = "moonshot" | "antigravity";

export interface ToolCompaction {
  maxDescriptionChars: number;
  stripAnnotations?: boolean;
  stripSchemaDescriptions?: boolean;
}

export interface ToolSchemaProfile {
  id: ToolSchemaProfileId;
  /** The provider as the person knows it, for log lines and the note a shortened tool carries. */
  provider: string;
  maxSchemaBytes?: number;
  maxDepth?: number;
  /** The engine inlines local `$ref`s before it sends, so the inlined form is what the provider measures. */
  measureInlined?: boolean;
  /** The engine validates `pattern` and `patternProperties` with Go's RE2 regex engine and rejects unsupported Perl syntax. */
  re2Patterns?: boolean;
  /** Tool `_meta` flag that tells the engine to load every listed tool directly instead of deferring larger schemas. */
  alwaysLoadMeta?: string;
  /** Shrinks verbose descriptions and non-constraining schema prose to fit an engine's shared eager tool budget. */
  compact?: ToolCompaction;
}

const PROFILES: Record<ToolSchemaProfileId, ToolSchemaProfile> = {
  // Moonshot refuses the whole request when one tool's `function.parameters`, as Go's encoding/json writes it, passes an
  // undocumented size (about 13.7 KB accepted, 15 KB refused): https://github.com/MoonshotAI/kimi-code/issues/4231,
  // https://github.com/morluto/rea/issues/3654. Depth 30 is walle's default (https://github.com/MoonshotAI/walle/blob/main/conf.go).
  // Kimi Code inlines every local $ref first (normalizeKimiToolSchema in MoonshotAI/kimi-code packages/kosong).
  moonshot: { id: "moonshot", provider: "Kimi", maxSchemaBytes: 12_000, maxDepth: 30, measureInlined: true },
  // Antigravity CLI 1.5+ compiles every MCP tool's JSON Schema regexes with Go's RE2 engine (failing turns on Perl
  // lookaheads), defers MCP tools over ~1.2 KB without exposing `call_mcp_tool` in ACP sessions unless marked with
  // `_meta: { "antigravity/alwaysLoad": true }` (since 1.3.3), and enforces a 20,000-token global eager MCP budget
  // (~58 KB) that silently evicts the largest tools first when exceeded.
  antigravity: {
    id: "antigravity",
    provider: "Antigravity",
    re2Patterns: true,
    alwaysLoadMeta: "antigravity/alwaysLoad",
    compact: { maxDescriptionChars: 120, stripAnnotations: true, stripSchemaDescriptions: true },
  },
};

export const TOOL_SCHEMA_PROFILE_ENV = "DUSK_TOOL_SCHEMA_PROFILE";

export function toolSchemaProfile(id: unknown): ToolSchemaProfile | undefined {
  return typeof id === "string" && Object.hasOwn(PROFILES, id) ? PROFILES[id as ToolSchemaProfileId] : undefined;
}

export function toolSchemaProfileFromEnv(env: Record<string, string | undefined> = process.env): ToolSchemaProfile | undefined {
  return toolSchemaProfile(env[TOOL_SCHEMA_PROFILE_ENV]);
}

function hostOf(url: string | undefined): string {
  try { return url ? new URL(url).hostname.toLowerCase() : ""; } catch { return ""; }
}

const MOONSHOT_HOST = /(?:^|\.)(?:moonshot\.ai|moonshot\.cn|kimi\.com|kimi\.ai)$/;
const OPENROUTER_HOST = /(?:^|\.)openrouter\.ai$/;

/** Kimi Code always reaches Moonshot (as do Moonshot's own endpoint and Moonshot models on OpenRouter).
 * Antigravity's Go ACP server validates MCP tool regexes with Go's RE2 engine. */
export function toolSchemaProfileFor(target: { engine?: string; url?: string; model?: string }): ToolSchemaProfile | undefined {
  const host = hostOf(target.url);
  if (target.engine === "kimiAgent" || MOONSHOT_HOST.test(host)) return PROFILES.moonshot;
  if (OPENROUTER_HOST.test(host) && /^moonshotai\//i.test(target.model ?? "")) return PROFILES.moonshot;
  if (target.engine === "antigravityAgent") return PROFILES.antigravity;
  return undefined;
}

function isObject(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The length Go's encoding/json gives: compact, with `<`, `>` and `&` written as six-byte escapes, as are U+2028/U+2029. */
export function schemaBytes(value: unknown): number {
  const text = JSON.stringify(value) ?? "";
  return Buffer.byteLength(text) + 5 * (text.match(/[<>&]/g)?.length ?? 0) + 3 * (text.match(/[\u2028\u2029]/g)?.length ?? 0);
}

const MAP_SLOTS = ["properties", "patternProperties", "dependentSchemas", "$defs", "definitions"] as const;
const NESTED_SLOTS = ["additionalProperties", "items", "additionalItems", "contains", "propertyNames", "unevaluatedProperties", "unevaluatedItems"] as const;
const NESTED_LISTS = ["prefixItems", "items"] as const;
/** Alternatives describe the same value, so they sit at its depth. */
const ALTERNATIVE_LISTS = ["anyOf", "oneOf", "allOf"] as const;
const ALTERNATIVES = ["not", "if", "then", "else"] as const;

/** Every subschema with its depth: a property, item or definition is one deeper than its parent. */
function walk(node: unknown, depth: number, visit: (node: Json, depth: number) => void): void {
  if (!isObject(node)) return;
  visit(node, depth);
  for (const slot of MAP_SLOTS) if (isObject(node[slot])) for (const child of Object.values(node[slot])) walk(child, depth + 1, visit);
  for (const slot of NESTED_SLOTS) walk(node[slot], depth + 1, visit);
  for (const slot of NESTED_LISTS) if (Array.isArray(node[slot])) for (const item of node[slot]) walk(item, depth + 1, visit);
  for (const slot of ALTERNATIVE_LISTS) if (Array.isArray(node[slot])) for (const item of node[slot]) walk(item, depth, visit);
  for (const slot of ALTERNATIVES) walk(node[slot], depth, visit);
}

function schemaDepth(schema: Json): number {
  let deepest = 0;
  walk(schema, 0, (_node, depth) => { deepest = Math.max(deepest, depth); });
  return deepest;
}

function pointer(root: Json, ref: string): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    const part = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current) && /^(?:0|[1-9]\d*)$/.test(part)) current = current[Number(part)];
    else if (isObject(current) && Object.hasOwn(current, part)) current = current[part];
    else return undefined;
  }
  return current;
}

function dropUnusedDefinitions(schema: Json): void {
  const rest = JSON.stringify(Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$defs" && key !== "definitions")));
  for (const bucket of ["$defs", "definitions"]) if (!rest.includes(`"#/${bucket}/`)) delete schema[bucket];
}

const INLINE_NODE_BUDGET = 200_000;

/** Local refs inlined the way Kimi Code inlines them, siblings winning; a cyclic ref stays a ref beside the definitions
 * it needs. Undefined when inlining would build more than INLINE_NODE_BUDGET nodes. */
function inlineRefs(schema: Json): Json | undefined {
  let nodes = 0;
  const resolve = (node: unknown, stack: Set<string>): unknown => {
    if (++nodes > INLINE_NODE_BUDGET) throw new RangeError("inline budget");
    if (Array.isArray(node)) return node.map((item) => resolve(item, stack));
    if (!isObject(node)) return node;
    const ref = node.$ref;
    const target = typeof ref === "string" && !stack.has(ref) ? pointer(schema, ref) : undefined;
    if (typeof ref === "string" && target !== undefined) {
      stack.add(ref);
      const resolved = resolve(target, stack);
      stack.delete(ref);
      if (!isObject(resolved)) return resolved;
      const merged: Json = { ...resolved };
      for (const [key, value] of Object.entries(node)) if (key !== "$ref") merged[key] = resolve(value, stack);
      return merged;
    }
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, resolve(value, stack)]));
  };
  try {
    const inlined = resolve(schema, new Set()) as Json;
    dropUnusedDefinitions(inlined);
    return inlined;
  } catch (error) {
    if (error instanceof RangeError) return undefined;
    throw error;
  }
}

const RE2_POSIX_CLASSES = new Set([
  "alnum", "alpha", "ascii", "blank", "cntrl", "digit", "graph",
  "lower", "print", "punct", "space", "upper", "word", "xdigit",
]);
const RE2_SIMPLE_ESCAPES = new Set(["a", "f", "n", "r", "t", "v", "d", "D", "s", "S", "w", "W"]);
const RE2_BOUNDARY_ESCAPES = new Set(["A", "b", "B", "z"]);
const RE2_SHORT_UNICODE = new Set(["L", "M", "N", "P", "S", "Z", "C"]);
const RE2_MAX_REPEAT = 1000;

function parseRe2Escape(pattern: string, index: number, inClass: boolean): number {
  const ch = pattern[index + 1];
  if (ch === undefined) return -1;
  if (RE2_SIMPLE_ESCAPES.has(ch)) return index + 2;
  if (!inClass && RE2_BOUNDARY_ESCAPES.has(ch)) return index + 2;
  if (!inClass && ch === "Q") {
    const end = pattern.indexOf("\\E", index + 2);
    return end >= 0 ? end + 2 : pattern.length;
  }
  if (ch === "x") {
    if (pattern[index + 2] === "{") {
      const match = /^([0-9a-fA-F]+)\}/.exec(pattern.slice(index + 3));
      if (!match || Number.parseInt(match[1]!, 16) > 0x10ffff) return -1;
      return index + 3 + match[0].length;
    }
    return /^[0-9a-fA-F]{2}/.test(pattern.slice(index + 2)) ? index + 4 : -1;
  }
  if (ch === "p" || ch === "P") {
    const next = pattern[index + 2];
    if (next === undefined) return -1;
    if (next === "{") {
      const match = /^\^?([A-Za-z][A-Za-z0-9_]*)\}/.exec(pattern.slice(index + 3));
      return match ? index + 3 + match[0].length : -1;
    }
    return RE2_SHORT_UNICODE.has(next) ? index + 3 : -1;
  }
  if (ch >= "0" && ch <= "7") {
    // Go's regexp/syntax rejects a single non-zero digit escape (\1..\7) as a backreference, while \0 or 2-3 octal digits <= 0o377 are octal.
    const octal = /^[0-7]{1,3}/.exec(pattern.slice(index + 1))![0];
    if (ch !== "0" && octal.length === 1) return -1;
    return Number.parseInt(octal, 8) <= 0o377 ? index + 1 + octal.length : -1;
  }
  // go escapes only ascii punctuation; a letter, digit or non-ascii character after a backslash is an error.
  if ((ch >= "8" && ch <= "9") || (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch > "\x7f") return -1;
  return index + 2;
}

/** Whether `pattern` uses only syntax accepted by Go's RE2 (`regexp.Compile` in Perl mode). */
export function isRe2Compatible(pattern: string): boolean {
  let i = 0;
  let parenDepth = 0;
  let canQuantify = false;
  let afterQuantifier = false;

  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      const next = parseRe2Escape(pattern, i, false);
      if (next < 0) return false;
      i = next;
      canQuantify = true;
      afterQuantifier = false;
      continue;
    }
    if (ch === "[") {
      i += 1;
      if (pattern[i] === "^") i += 1;
      let first = true;
      let closed = false;
      while (i < pattern.length) {
        if (pattern[i] === "]" && !first) {
          i += 1;
          closed = true;
          break;
        }
        first = false;
        if (pattern[i] === "\\") {
          const next = parseRe2Escape(pattern, i, true);
          if (next < 0) return false;
          i = next;
          continue;
        }
        if (pattern[i] === "[" && pattern[i + 1] === ":") {
          const close = pattern.indexOf(":]", i + 2);
          if (close < 0) return false;
          const raw = pattern.slice(i + 2, close);
          const name = raw.startsWith("^") ? raw.slice(1) : raw;
          if (!RE2_POSIX_CLASSES.has(name)) return false;
          i = close + 2;
          continue;
        }
        i += 1;
      }
      if (!closed) return false;
      canQuantify = true;
      afterQuantifier = false;
      continue;
    }
    if (ch === "(") {
      if (pattern[i + 1] === "?") {
        if (pattern.startsWith("(?:", i)) {
          parenDepth += 1;
          i += 3;
          canQuantify = false;
          afterQuantifier = false;
          continue;
        }
        const named = /^\(\?P<[A-Za-z0-9_]+>/.exec(pattern.slice(i));
        if (named) {
          parenDepth += 1;
          i += named[0].length;
          canQuantify = false;
          afterQuantifier = false;
          continue;
        }
        const flags = /^\(\?(?:[imsU]+(?:-[imsU]*)?|-[imsU]+)([:)])/.exec(pattern.slice(i));
        if (flags) {
          if (flags[1] === ":") parenDepth += 1;
          i += flags[0].length;
          canQuantify = false;
          afterQuantifier = false;
          continue;
        }
        return false;
      }
      parenDepth += 1;
      i += 1;
      canQuantify = false;
      afterQuantifier = false;
      continue;
    }
    if (ch === ")") {
      if (parenDepth === 0) return false;
      parenDepth -= 1;
      i += 1;
      canQuantify = true;
      afterQuantifier = false;
      continue;
    }
    if (ch === "|") {
      i += 1;
      canQuantify = false;
      afterQuantifier = false;
      continue;
    }
    if (ch === "*" || ch === "+" || ch === "?") {
      if (afterQuantifier) {
        if (ch !== "?") return false;
        afterQuantifier = false;
        canQuantify = false;
        i += 1;
        continue;
      }
      if (!canQuantify) return false;
      canQuantify = false;
      afterQuantifier = true;
      i += 1;
      continue;
    }
    if (ch === "{") {
      const repeat = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(i));
      if (repeat) {
        if (!canQuantify) return false;
        const min = Number(repeat[1]);
        const max = repeat[2] === undefined ? min : repeat[2] === "" ? undefined : Number(repeat[2]);
        if (min > RE2_MAX_REPEAT || (max !== undefined && (max > RE2_MAX_REPEAT || max < min))) return false;
        i += repeat[0].length;
        canQuantify = false;
        afterQuantifier = true;
        continue;
      }
    }
    i += 1;
    canQuantify = true;
    afterQuantifier = false;
  }

  return parenDepth === 0;
}

function hasNonRe2Pattern(schema: Json): boolean {
  let found = false;
  walk(schema, 0, (node) => {
    if (found) return;
    if (typeof node.pattern === "string" && !isRe2Compatible(node.pattern)) {
      found = true;
      return;
    }
    if (isObject(node.patternProperties)) {
      for (const key of Object.keys(node.patternProperties)) {
        if (!isRe2Compatible(key)) {
          found = true;
          return;
        }
      }
    }
  });
  return found;
}

function stripNonRe2Patterns(schema: Json): number {
  let dropped = 0;
  walk(schema, 0, (node) => {
    if (typeof node.pattern === "string" && !isRe2Compatible(node.pattern)) {
      delete node.pattern;
      dropped += 1;
    }
    if (isObject(node.patternProperties)) {
      let removedHere = 0;
      for (const key of Object.keys(node.patternProperties)) {
        if (!isRe2Compatible(key)) {
          delete node.patternProperties[key];
          removedHere += 1;
          dropped += 1;
        }
      }
      if (removedHere > 0) {
        if (node.additionalProperties === false) node.additionalProperties = true;
        if (Object.keys(node.patternProperties).length === 0) delete node.patternProperties;
      }
    }
  });
  return dropped;
}

function fits(schema: Json, profile: ToolSchemaProfile): boolean {
  if (profile.re2Patterns && hasNonRe2Pattern(schema)) return false;
  if (profile.maxSchemaBytes !== undefined && schemaBytes(schema) > profile.maxSchemaBytes) return false;
  if (profile.maxDepth !== undefined && schemaDepth(schema) > profile.maxDepth) return false;
  return true;
}

/** Words for people and tooling: none of them constrains a value. */
const ANNOTATIONS = new Set(["examples", "example", "$comment", "title", "deprecated", "readOnly", "writeOnly", "$schema", "$id"]);

function stripAnnotations(schema: Json): void {
  walk(schema, 0, (node) => {
    for (const key of Object.keys(node)) if (ANNOTATIONS.has(key) || key.startsWith("x-")) delete node[key];
  });
}

function shortened(text: unknown, chars: number): string | undefined {
  if (typeof text !== "string" || !text.trim() || chars <= 0) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= chars ? flat : `${flat.slice(0, chars - 1).replace(/\s+\S*$/, "")}…`;
}

function shortenDescriptions(schema: Json, fromDepth: number, chars: number): void {
  walk(schema, 0, (node, depth) => {
    if (depth < fromDepth) return;
    const description = shortened(node.description, chars);
    if (description) node.description = description;
    else delete node.description;
  });
}

function needsSchemaCompaction(schema: Json, compact: ToolCompaction): boolean {
  let found = false;
  walk(schema, 0, (node) => {
    if (found) return;
    for (const key of Object.keys(node)) {
      if (compact.stripAnnotations && (ANNOTATIONS.has(key) || key.startsWith("x-"))) {
        found = true;
        return;
      }
      if (compact.stripSchemaDescriptions && key === "description" && typeof node[key] === "string") {
        found = true;
        return;
      }
    }
  });
  return found;
}

/** Strips non-constraining schema annotations and parameter prose while keeping every parameter name, type, enum, required list, and pattern. */
export function compactToolSchema(schema: Json, compact: ToolCompaction): Json {
  if (!needsSchemaCompaction(schema, compact)) return schema;
  const working = structuredClone(schema);
  if (compact.stripAnnotations) stripAnnotations(working);
  if (compact.stripSchemaDescriptions) shortenDescriptions(working, 0, 0);
  return working;
}

/** Single-line tool description bounded to `maxChars` at a word boundary, or undefined when blank. */
export function compactToolDescription(description: unknown, maxChars: number): string | undefined {
  if (typeof description !== "string" || maxChars <= 0) return undefined;
  const flat = description.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  if (flat.length <= maxChars) return flat;
  let head = flat.slice(0, maxChars - 1);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  const cut = head.replace(/\s+\S*$/, "");
  return `${cut || head}…`;
}

const JSON_TYPES = ["string", "number", "integer", "boolean", "object", "array", "null"];

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value === "object" ? "object" : typeof value;
}

function typesOf(node: Json, root: Json, hops = 0): string[] {
  if (hops > 16) return [];
  if (typeof node.type === "string") return [node.type];
  if (Array.isArray(node.type)) return node.type.filter((type): type is string => typeof type === "string");
  const target = typeof node.$ref === "string" ? pointer(root, node.$ref) : undefined;
  if (isObject(target)) return typesOf(target, root, hops + 1);
  const branches = ALTERNATIVE_LISTS.flatMap((slot) => Array.isArray(node[slot]) ? node[slot].filter(isObject) : []);
  if (branches.length) return [...new Set(branches.flatMap((branch) => typesOf(branch, root, hops + 1)))];
  if (Array.isArray(node.enum) && node.enum.length) return [...new Set(node.enum.map(valueType))];
  if ("const" in node) return [valueType(node.const)];
  if (isObject(node.properties) || "additionalProperties" in node || Array.isArray(node.required)) return ["object"];
  if ("items" in node || "prefixItems" in node) return ["array"];
  return [];
}

/** A subschema's type and nothing inside it, valid where Moonshot wants every subschema typed; a free-form object names
 * additionalProperties because a bare `{"type":"object"}` reads there as recursion without end. */
function placeholder(node: Json, root: Json): Json {
  const types = typesOf(node, root).filter((type) => JSON_TYPES.includes(type));
  const unique = [...new Set(types.map((type) => (type === "integer" && types.includes("number") ? "number" : type)))];
  if (unique.length !== 1) return { type: unique.length ? unique : JSON_TYPES };
  const type = unique[0]!;
  if (type === "object") return { type, additionalProperties: true };
  const choices = Array.isArray(node.enum) ? node.enum : "const" in node ? [node.const] : undefined;
  const sameType = (value: unknown) => valueType(value) === type || (type === "number" && valueType(value) === "integer");
  const keep = type !== "array" && choices && choices.length <= 64 && choices.every(sameType) && schemaBytes(choices) <= 1_024;
  return keep ? { type, enum: choices } : { type };
}

/** Each subschema at `depth` becomes its placeholder; its parent keeps every field name and `required`. */
function collapseAt(schema: Json, depth: number): void {
  walk(schema, 0, (node, at) => {
    if (at !== depth - 1) return;
    for (const slot of MAP_SLOTS) {
      const map = node[slot];
      if (isObject(map)) for (const [key, child] of Object.entries(map)) if (isObject(child)) map[key] = placeholder(child, schema);
    }
    for (const slot of NESTED_SLOTS) if (isObject(node[slot])) node[slot] = placeholder(node[slot], schema);
    for (const slot of NESTED_LISTS) {
      const list = node[slot];
      if (Array.isArray(list)) list.forEach((item, index) => { if (isObject(item)) list[index] = placeholder(item, schema); });
    }
  });
  dropUnusedDefinitions(schema);
}

function topLevelOnly(schema: Json, descriptionChars: number): Json {
  const declared = isObject(schema.properties) ? schema.properties : {};
  const properties: Json = {};
  for (const [key, child] of Object.entries(declared)) {
    const flat = isObject(child) ? placeholder(child, schema) : { type: JSON_TYPES };
    const description = isObject(child) ? shortened(child.description, descriptionChars) : undefined;
    properties[key] = description ? { ...flat, description } : flat;
  }
  const required = Array.isArray(schema.required) ? schema.required.filter((key) => typeof key === "string" && Object.hasOwn(properties, key)) : [];
  return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: true };
}

/** kept: as the server sent it. sanitized: unsupported regex patterns removed, all fields kept.
 * trimmed: every field and constraint kept, fewer words. loosened: fields deeper in are
 * left to the tool's description. minimal: only the top-level fields. dropped: not even those fit. */
export type SchemaFit =
  | { outcome: "kept"; schema: Json; bytes: number }
  | { outcome: "sanitized"; schema: Json; bytes: number; from: number; droppedPatterns: number }
  | { outcome: "trimmed" | "loosened" | "minimal"; schema: Json; bytes: number; from: number }
  | { outcome: "dropped"; bytes: number; from: number };

/** Least loss first, stopping at the first form that fits. */
export function fitToolSchema(schema: Json, profile: ToolSchemaProfile): SchemaFit {
  const measured = profile.measureInlined ? inlineRefs(schema) : schema;
  const from = schemaBytes(measured ?? schema);
  if (measured && fits(measured, profile)) return { outcome: "kept", schema, bytes: from };
  const fitted = (outcome: "trimmed" | "loosened" | "minimal", form: Json): SchemaFit => ({ outcome, schema: form, bytes: schemaBytes(form), from });

  const working = structuredClone(measured ?? schema);
  const droppedPatterns = profile.re2Patterns ? stripNonRe2Patterns(working) : 0;
  if (droppedPatterns > 0 && fits(working, profile)) {
    return { outcome: "sanitized", schema: working, bytes: schemaBytes(working), from, droppedPatterns };
  }
  if (measured) {
    stripAnnotations(working);
    if (fits(working, profile)) return fitted("trimmed", working);
    for (let depth = schemaDepth(working); depth >= 2; depth -= 1) {
      shortenDescriptions(working, depth, 0);
      if (fits(working, profile)) return fitted("trimmed", working);
    }
    shortenDescriptions(working, 0, 300);
    if (fits(working, profile)) return fitted("trimmed", working);
    for (let depth = schemaDepth(working); depth >= 2; depth -= 1) {
      collapseAt(working, depth);
      if (fits(working, profile)) return fitted("loosened", working);
    }
  }
  for (const chars of [120, 0]) {
    const top = topLevelOnly(working, chars);
    if (fits(top, profile)) return fitted("minimal", top);
  }
  return { outcome: "dropped", bytes: schemaBytes(topLevelOnly(working, 0)), from };
}
