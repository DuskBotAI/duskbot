// agent_browser_batch and settled page reads on the agent-browser engine. Steps take agent-browser's own tool names and
// arguments, checked against the tool list the engine advertised, and run one by one through the single-call path.
import { z } from "zod";

import type { BatchStepOf } from "./batch.ts";
import type { PageProbe } from "./cdp/settle.ts";
import { PROBE_EXPRESSION } from "./cdp/settle.ts";
import { agentBrowserArguments } from "./agent-browser-args.ts";
import { BATCH_TOOL, MAX_BATCH_MS, MAX_BATCH_PICTURES, MAX_BATCH_STEPS } from "./tools.ts";

/** No eval, upload, close or tab steps: those need a look at the page first, or end what the later steps act on. */
export const AGENT_BROWSER_BATCH_ACTIONS = ["open", "click", "fill", "type", "press", "select", "check", "uncheck", "hover", "scroll",
  "wait_ms", "wait_for_selector", "wait_for_text", "wait_for_load", "read", "get_text", "snapshot", "screenshot", "back", "forward", "reload"] as const;

/** Reads that first wait out a self-clearing bot check and loading placeholders, as open does. */
export const SETTLED_READS: ReadonlySet<string> = new Set(["agent_browser_snapshot", "agent_browser_read", "agent_browser_get_text"]);

const INPUT = z.object({
  steps: z.array(z.object({
    do: z.enum(AGENT_BROWSER_BATCH_ACTIONS).describe("The step: the agent_browser tool of that name, such as click for agent_browser_click."),
  }).catchall(z.unknown()).describe("do plus that tool's own arguments, such as {\"do\":\"fill\",\"selector\":\"#email\",\"text\":\"a@b.c\"}."))
    .min(1).max(MAX_BATCH_STEPS).describe(`The steps in order, ${MAX_BATCH_STEPS} at most. The first that fails ends the batch.`),
  timeoutMs: z.number().int().min(1_000).max(MAX_BATCH_MS).optional().describe(`The whole batch's time limit in milliseconds. Defaults to ${MAX_BATCH_MS}.`),
}).strict();

const { $schema: _schema, ...inputSchema } = z.toJSONSchema(INPUT) as Record<string, unknown>;

export const AGENT_BROWSER_BATCH_SPEC = {
  name: BATCH_TOOL,
  description: `Run several browser steps in one call: ${AGENT_BROWSER_BATCH_ACTIONS.join(", ")}, each the agent_browser tool of that name with its own arguments. Prefer it whenever you already know the next steps, such as filling a form and submitting it, or going through a few pages: one call instead of one per step. Every step is checked before the first runs; it stops at the first step that fails and answers with each step's result, and on a failure the page's snapshot. Refs stop applying once a step moves to another page, and every snapshot renumbers them, so name later elements by CSS selector (#email, [name=q]) or end with a snapshot and continue from its refs. ${MAX_BATCH_STEPS} steps, ${MAX_BATCH_MS / 1_000} s and ${MAX_BATCH_PICTURES} pictures at most.`,
  inputSchema,
};

export type AgentBrowserCall = { name: string; arguments: Record<string, unknown> };
type Listed = { name?: unknown; inputSchema?: unknown };

const schemas = new WeakMap<object, z.ZodType | null>();

/** The listed tool's own argument schema, unknown fields refused; null when it cannot be read. */
function schemaOf(tool: Listed & object): z.ZodType | null {
  if (schemas.has(tool)) return schemas.get(tool)!;
  let schema: z.ZodType | null = null;
  try {
    const built = z.fromJSONSchema((tool.inputSchema ?? { type: "object" }) as Parameters<typeof z.fromJSONSchema>[0]);
    schema = built instanceof z.ZodObject ? built.strict() : built;
  } catch {
    schema = null;
  }
  schemas.set(tool, schema);
  return schema;
}

function listedTool(tools: unknown, name: string): (Listed & object) | null {
  const list = (tools as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(list)) return null;
  return (list as unknown[]).find((tool): tool is Listed & object => Boolean(tool) && typeof tool === "object" && (tool as Listed).name === name) ?? null;
}

const TIMEOUT_ALIASES: ReadonlySet<string> = new Set(["timeoutMs", "timeout"]);

function propertiesOf(tool: Listed & object): ReadonlySet<string> | null {
  const properties = (tool.inputSchema as { properties?: unknown } | null | undefined)?.properties;
  return properties && typeof properties === "object" ? new Set(Object.keys(properties)) : null;
}

const issues = (error: z.ZodError) => error.issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");

/** One step as the agent-browser call it stands for, checked against that tool's advertised schema. */
export function agentBrowserStep(step: BatchStepOf, tools: unknown): { ok: true; call: AgentBrowserCall } | { ok: false; error: string } {
  const { do: action, ...given } = step;
  if (!(AGENT_BROWSER_BATCH_ACTIONS as readonly string[]).includes(action)) return { ok: false, error: `${action} cannot run in a batch` };
  const name = `agent_browser_${action}`;
  const tool = listedTool(tools, name);
  if (!tool) return { ok: false, error: `${action} is not a tool this browser offers` };
  const schema = schemaOf(tool);
  if (!schema) return { ok: false, error: `${action}'s arguments could not be checked` };
  const taken = propertiesOf(tool);
  const args = Object.fromEntries(Object.entries(agentBrowserArguments(name, given)).filter(([key]) => !TIMEOUT_ALIASES.has(key) || taken?.has(key)));
  const parsed = schema.safeParse(args);
  if (!parsed.success) return { ok: false, error: `${action} got arguments it cannot use (${issues(parsed.error)})` };
  return { ok: true, call: { name, arguments: args } };
}

export type BatchPlan = { ok: true; steps: BatchStepOf[]; limitMs: number } | { ok: false; error: string };

/** Every step is checked before the first runs, so a typo in step 9 does not leave a form half filled. */
export function planAgentBrowserBatch(args: unknown, tools: unknown): BatchPlan {
  const input = INPUT.safeParse(args ?? {});
  if (!input.success) return { ok: false, error: `${BATCH_TOOL} got arguments it cannot use (${issues(input.error)}).` };
  const steps = input.data.steps as BatchStepOf[];
  let pictures = 0;
  for (const [index, step] of steps.entries()) {
    const parsed = agentBrowserStep(step, tools);
    if (!parsed.ok) return { ok: false, error: `${BATCH_TOOL} ran nothing: step ${index + 1} ${parsed.error}.` };
    if (step.do === "screenshot") pictures++;
  }
  if (pictures > MAX_BATCH_PICTURES) return { ok: false, error: `${BATCH_TOOL} ran nothing: it returns ${MAX_BATCH_PICTURES} pictures at most, and these steps take ${pictures}.` };
  return { ok: true, steps, limitMs: input.data.timeoutMs ?? MAX_BATCH_MS };
}

/** agent-browser's eval answers with the value as JSON, so the probe comes back as a string. */
export const PROBE_SCRIPT = `JSON.stringify(${PROBE_EXPRESSION})`;

export function probeOfEval(result: unknown): PageProbe | null {
  const record = result as { isError?: unknown; content?: unknown } | null;
  if (!record || record.isError === true || !Array.isArray(record.content)) return null;
  const part = (record.content as unknown[]).find((item) => typeof (item as { text?: unknown } | null)?.text === "string") as { text: string } | undefined;
  try {
    let value: unknown = JSON.parse(part?.text ?? "");
    if (typeof value === "string") value = JSON.parse(value);
    const probe = value as Partial<PageProbe> | null;
    if (!probe || typeof probe.title !== "string" || typeof probe.text !== "string" || typeof probe.textLength !== "number" || typeof probe.nodes !== "number" ||
        typeof probe.controls !== "number" || typeof probe.busy !== "boolean" || !Array.isArray(probe.scripts) || !Array.isArray(probe.iframes) || !Array.isArray(probe.selectors)) return null;
    return probe as PageProbe;
  } catch {
    return null;
  }
}
