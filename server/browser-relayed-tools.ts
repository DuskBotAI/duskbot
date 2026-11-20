export const BROWSER_UPLOAD_TOOL = "agent_browser_upload";
export const BROWSER_HOVER_TOOL = "agent_browser_hover";
export const BROWSER_DIALOG_TOOL = "agent_browser_dialog";
/** agent-browser 0.37.0 offers upload, hover and dialog only in its 156-tool "all" profile, so dusk bot runs these through the daemon's relay. */
export const RELAYED_TOOL_SPECS = [
  {
    name: BROWSER_UPLOAD_TOOL,
    description: "Put files into a file input (<input type=\"file\">), then submit its form as usual. files are absolute paths of files the person attached to this conversation or files in your own working folder; any other path is refused.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["selector", "files"],
      properties: {
        selector: { type: "string", minLength: 1, description: "The file input: an @eN ref from a snapshot, or a CSS selector." },
        files: { type: "array", minItems: 1, maxItems: 10, items: { type: "string", minLength: 1 }, description: "Absolute paths of the files to put in the input." },
      },
    },
  },
  {
    name: BROWSER_HOVER_TOOL,
    description: "Move the mouse over an element, for menus and tooltips that open on hover.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["selector"],
      properties: { selector: { type: "string", minLength: 1, description: "An @eN ref from a snapshot, or a CSS selector." } },
    },
  },
  {
    name: BROWSER_DIALOG_TOOL,
    description: "Answer the alert, confirm or prompt dialog the page opened, which holds every other action on the page until it is answered. accept true presses OK, false presses Cancel; promptText is the answer to a prompt.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["accept"],
      properties: {
        accept: { type: "boolean", description: "true for OK, false for Cancel." },
        promptText: { type: "string", maxLength: 4_000, description: "The text to answer a prompt with, when accepting." },
      },
    },
  },
];

const RETRY_HINT = /Resolve it with `dialog accept` or `dialog dismiss`, then retry `([\w-]+)`\./gu;
const OTHER_HINTS = /[Uu]se `dialog accept(?: \[text\])?` or `dialog dismiss` to resolve it|resolve it with `dialog accept`\/`dialog dismiss`/gu;

/** agent-browser 0.37.0's advice on an open dialog names its CLI command; the bot answers one with agent_browser_dialog. */
export function withDialogTool(text: string): string {
  return text
    .replace(RETRY_HINT, (_all, call: string) => `Answer it with ${BROWSER_DIALOG_TOOL} (accept true or false), then call ${call.startsWith("agent_browser_") ? call : `agent_browser_${call}`} again.`)
    .replace(OTHER_HINTS, `answer it with ${BROWSER_DIALOG_TOOL} (accept true or false)`);
}

export type RelayedToolSpec = (typeof RELAYED_TOOL_SPECS)[number];
export const RELAYED_TOOLS: ReadonlyMap<string, RelayedToolSpec> = new Map(RELAYED_TOOL_SPECS.map((spec) => [spec.name, spec]));
