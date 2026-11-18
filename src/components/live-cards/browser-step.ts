import { isToolStep } from "@/lib/activity-runs";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { Message } from "@/state/store";
import { TOOL_NAMESPACE, toolSurfaceKind } from "../../../shared/tool-surface";

export type BrowserStep = Message & { tool: NonNullable<Message["tool"]> };

export function isBrowserStep(message: Message): message is BrowserStep {
  return isToolStep(message) && message.tool.step?.activity !== "command" && toolSurfaceKind(message.tool.name) === "browser";
}

export type BrowserAction = "open" | "click" | "type" | "scroll" | "read" | "look" | "wait" | "use";

const ACTIONS: ReadonlyArray<[RegExp, BrowserAction]> = [
  [/^(?:open|navigate|back|forward|reload|tab_new|tab_switch|tabs|teleport)$/, "open"],
  [/^(?:click|check|uncheck|select|select_option|hover|drag|dialog|tab_close|close)$/, "click"],
  [/^(?:fill|type|press|upload)$/, "type"],
  [/^scroll$/, "scroll"],
  [/^(?:snapshot|read|get_text|get_url|get_title|eval|console|network_requests|status|tab_list)$/, "read"],
  [/^screenshot$/, "look"],
  [/^wait(?:_|$)/, "wait"],
];

export function browserAction(toolName: string): BrowserAction {
  const bare = toolName.toLowerCase().replace(TOOL_NAMESPACE, "").replace(/^browser_(?=agent_browser_)/, "").replace(/^(?:agent_browser|browser)_/, "");
  return ACTIONS.find(([pattern]) => pattern.test(bare))?.[1] ?? "use";
}

export function browserSite(step: BrowserStep): string | undefined {
  const site = step.tool.step;
  return site?.activity === "fetch" ? site.target : undefined;
}

export function stretchSite(steps: readonly BrowserStep[]): string | undefined {
  return steps.map(browserSite).findLast(Boolean);
}

type Wording = Record<BrowserAction, LocaleKey> & { openPage: LocaleKey };

const DOING: Wording = {
  open: "liveCard.browser.doing.open",
  openPage: "liveCard.browser.doing.openPage",
  click: "liveCard.browser.doing.click",
  type: "liveCard.browser.doing.type",
  scroll: "liveCard.browser.doing.scroll",
  read: "liveCard.browser.doing.read",
  look: "liveCard.browser.doing.look",
  wait: "liveCard.browser.doing.wait",
  use: "liveCard.browser.doing.use",
};

const DID: Wording = {
  open: "liveCard.browser.did.open",
  openPage: "liveCard.browser.did.openPage",
  click: "liveCard.browser.did.click",
  type: "liveCard.browser.did.type",
  scroll: "liveCard.browser.did.scroll",
  read: "liveCard.browser.did.read",
  look: "liveCard.browser.did.look",
  wait: "liveCard.browser.did.wait",
  use: "liveCard.browser.did.use",
};

function worded(step: BrowserStep, words: Wording): string {
  const action = browserAction(step.tool.name);
  const page = step.tool.step?.activity === "fetch" ? step.tool.step.detail ?? step.tool.step.target : undefined;
  return action === "open" && page ? t(words.openPage, { page }) : t(words[action]);
}

export function browserDoing(step: BrowserStep): string {
  return worded(step, DOING);
}

export function browserDid(step: BrowserStep): string {
  return worded(step, DID);
}

export type BrowserStretchState = "running" | "done" | "failed" | "ended";

export function stretchState(steps: readonly BrowserStep[], running: boolean): BrowserStretchState {
  if (running) return "running";
  const last = steps.at(-1)?.tool.ok;
  return last === undefined ? "ended" : last ? "done" : "failed";
}
