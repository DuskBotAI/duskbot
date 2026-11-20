// A dusk cloud's bots on the person's own screen (docs/cloud-uses-mac.md): the computer-control driver on the Mac lists
// its tools in a sealed job, and the cloud offers them as mac_<tool> on the device server, filtered as a local bot's
// computer is beside a browser of its own.
import { CLOUD_ONLY_MAC_TOOL_NAMES, MAC_TOOL_NAMES, type MacJobOutcome } from "../../shared/mac-control.ts";
import { listsComputerTool } from "../computer-tool-list.ts";
import type { MacToolResult } from "./tools.ts";

export const SCREEN_PREFIX = "mac_";
const DRIVER_NAME = /^[a-z][a-z0-9_]{0,47}$/;
const MAX_TOOLS = 80;
const DESCRIPTION_MAX = 4000;
const SCHEMA_MAX = 16_000;
const OWN_NAMES: ReadonlySet<string> = new Set([...MAC_TOOL_NAMES, ...CLOUD_ONLY_MAC_TOOL_NAMES]);

export interface ScreenTool { name: string; description: string; inputSchema: Record<string, unknown> }

/** Offered instead of the screen tools while the Mac allows its screen but computer control lacks its grants there. */
export const SCREEN_ACCESS_TOOL: ScreenTool = {
  name: "mac_request_screen_access",
  description: "Ask the person, on their Mac, to let dusk bot see and use its screen (Accessibility and Screen Recording). Call it once when a task needs the Mac's screen; the screen tools appear on a later turn once they allow it.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

export interface ScreenCatalog {
  /** The driver's version as the Mac read it; "" when it did not say. */
  driver: string;
  tools: ScreenTool[];
  /** listed name -> the driver's own name */
  driverName: Map<string, string>;
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** cua-driver 0.28.2's screenshot_out_file writes a PNG at a path on the Mac instead of returning it: a cloud bot needs the
 * picture back, and a screen call must not write files the Mac's file rules would ask about. */
const MAC_FILE_OUTPUT = /_out_file$/;

/** The call without its write-to-a-file-on-the-Mac arguments. */
export function withoutMacFileOutputs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([key]) => !MAC_FILE_OUTPUT.test(key)));
}

function withoutFileOutputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (!isObject(schema.properties)) return schema;
  const properties = withoutMacFileOutputs(schema.properties);
  const required = Array.isArray(schema.required) ? schema.required.filter((key) => typeof key !== "string" || !MAC_FILE_OUTPUT.test(key)) : undefined;
  return { ...schema, properties, ...(required ? { required } : {}) };
}

/** The catalog from a mac_screen_tools job's text, or null when it is not one. */
export function screenCatalog(text: string): ScreenCatalog | null {
  let body: unknown;
  try { body = JSON.parse(text); } catch { return null; }
  if (!isObject(body) || !Array.isArray(body.tools)) return null;
  const tools: ScreenTool[] = [];
  const driverName = new Map<string, string>();
  for (const entry of body.tools.slice(0, 200)) {
    if (!isObject(entry) || typeof entry.name !== "string" || !DRIVER_NAME.test(entry.name) || !listsComputerTool(entry.name, true)) continue;
    const name = `${SCREEN_PREFIX}${entry.name}`;
    if (OWN_NAMES.has(name) || driverName.has(name) || name === SCREEN_ACCESS_TOOL.name) continue;
    const schema = isObject(entry.inputSchema) && entry.inputSchema.type === "object" && JSON.stringify(entry.inputSchema).length <= SCHEMA_MAX
      ? withoutFileOutputSchema(entry.inputSchema) : { type: "object" };
    const description = typeof entry.description === "string" ? entry.description.slice(0, DESCRIPTION_MAX) : "";
    tools.push({ name, description: `On the person's own computer (their screen): ${description}`.trim(), inputSchema: schema });
    driverName.set(name, entry.name);
    if (tools.length >= MAX_TOOLS) break;
  }
  return { driver: typeof body.driver === "string" ? body.driver.slice(0, 40) : "", tools, driverName };
}

/** A name the device server may route to the screen: mac_ and not one of the Mac's own tools. */
export const maybeScreenTool = (name: unknown): name is string =>
  typeof name === "string" && name.startsWith(SCREEN_PREFIX) && !OWN_NAMES.has(name) && DRIVER_NAME.test(name.slice(SCREEN_PREFIX.length));

/** A mac_screen job's outcome as the driver's own MCP result. */
export function screenResult(outcome: MacJobOutcome): MacToolResult {
  if (!outcome.ok) return { content: [{ type: "text", text: outcome.error }], isError: true };
  const { text, image, structured, isError } = outcome.result;
  return {
    content: [...(text || !image ? [{ type: "text" as const, text }] : []), ...(image ? [{ type: "image" as const, ...image }] : [])],
    ...(structured ? { structuredContent: structured } : {}),
    ...(isError ? { isError: true } : {}),
  };
}
