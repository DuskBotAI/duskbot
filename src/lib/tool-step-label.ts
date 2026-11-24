import { composioActionPhrase } from "@/lib/approval-summary";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { Message } from "@/state/store";

type StepTool = Pick<NonNullable<Message["tool"]>, "name" | "summary" | "whose" | "label">;

const STEP_KEYS: Record<string, LocaleKey> = {
  bash: "toolStep.runCommand",
  shell: "toolStep.runCommand",
  terminal: "toolStep.runCommand",
  run_command: "toolStep.runCommand",
  execute: "toolStep.runCommand",
  computer_exec: "toolStep.runCommand",
  read: "toolStep.readFile",
  read_file: "toolStep.readFile",
  view: "toolStep.readFile",
  write: "toolStep.writeFile",
  create_file: "toolStep.writeFile",
  edit: "toolStep.editFile",
  multiedit: "toolStep.editFile",
  str_replace: "toolStep.editFile",
  apply_patch: "toolStep.editFile",
  notebookedit: "toolStep.editFile",
  delete: "toolStep.deleteFile",
  grep: "toolStep.searchFiles",
  glob: "toolStep.searchFiles",
  find: "toolStep.searchFiles",
  search: "toolStep.searchFiles",
  ls: "toolStep.searchFiles",
  websearch: "toolStep.searchWeb",
  web_search: "toolStep.searchWeb",
  webfetch: "toolStep.openWebPage",
  web_fetch: "toolStep.openWebPage",
  fetch: "toolStep.openWebPage",
  open_url: "toolStep.openWebPage",
  screenshot: "toolStep.lookAtScreen",
  computer_screenshot: "toolStep.lookAtScreen",
  click: "toolStep.useComputer",
  type_text: "toolStep.useComputer",
  press_key: "toolStep.useComputer",
  scroll: "toolStep.useComputer",
  computer_batch: "toolStep.useComputer",
  todowrite: "toolStep.updatePlan",
  update_plan: "toolStep.updatePlan",
  schedule: "toolStep.waitForBackgroundTask",
  "run schedule": "toolStep.waitForBackgroundTask",
  manage_task: "toolStep.checkBackgroundTask",
  "run manage_task": "toolStep.checkBackgroundTask",
  task: "toolStep.askHelper",
  agent: "toolStep.askHelper",
  think: "toolStep.think",
  list_bots: "toolStep.checkTeam",
  list_rooms: "toolStep.checkTeam",
  list_room_targets: "toolStep.checkTeam",
  web_search_many: "toolStep.searchWeb",
  vm_exec: "toolStep.runCommand",
  x_search: "toolStep.searchX",
  coordinate_bots: "toolStep.askTeammate",
  post_to_room: "toolStep.postToRoom",
  session_search: "toolStep.searchPastChats",
  memory_update: "toolStep.updateMemory",
  memory_log: "toolStep.updateMemory",
  attach_file: "toolStep.attachFile",
  tool_result_read: "toolStep.readResult",
  select_computer: "toolStep.pickComputer",
  trigger: "toolStep.manageAutomations",
  trigger_info: "toolStep.checkAutomations",
  tool: "toolStep.useTool",
  other: "toolStep.useTool",
  mcp: "toolStep.useTool",
};

/** Everything in the chat window is sentence case, a name made from a tool's own id too. */
function sentence(words: string): string {
  const flat = words.replace(/\s+/g, " ").trim();
  return flat.charAt(0).toUpperCase() + flat.slice(1);
}

/** Whose own app or MCP server a step used, after its label: "Fetch emails · using Ada's Gmail". */
export function withWhose(label: string, tool: Pick<StepTool, "whose">): string {
  return tool.whose ? `${label} · ${t("toolStep.usingWhose", { person: tool.whose.person, app: tool.whose.app })}` : label;
}

export function toolStepLabel(tool: StepTool): string {
  return withWhose(stepWords(tool), tool);
}

function stepWords(tool: StepTool): string {
  const { name } = tool;
  if (tool.label) return tool.label;
  // Codex and ACP title a command's chip with the command line; only a command carries a summary.
  if (tool.summary) return t("toolStep.runCommand");
  // Claude names a call mcp__agents__tool; the chat runtime names it agents_tool.
  const bare = name.replace(/^mcp__.+?__(?=.)/, "").replace(/^agents_(?=.)/, "");
  const key = STEP_KEYS[bare.toLowerCase()];
  if (key) return t(key);
  if (/\s/.test(name)) return name;
  if (/(?:^|_)browser_/i.test(bare)) return t("toolStep.useBrowser");
  const composio = composioActionPhrase(bare);
  if (composio) return sentence(composio);
  const words = bare
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.:]+/g, " ")
    .toLowerCase();
  return sentence(words) || t("toolStep.useTool");
}
