import type { DirectoryApp } from "../shared/connector-directory.ts";
import { isComposioConnectUrl } from "./composio-connect.ts";
import { mcpServerLabel, remoteMcpAppFor } from "./remote-mcp-label.ts";
import { customMcpPrompt } from "./system-prompt.ts";

const urlOf = (server: unknown): string | undefined =>
  server && typeof server === "object" && typeof (server as { url?: unknown }).url === "string" ? (server as { url: string }).url : undefined;

const joined = (items: string[]) => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

export interface McpPromptInput {
  /** The servers this turn mounts. */
  mounted: readonly string[];
  /** The bot's servers as the person configured them: their own URLs, never a turn's proxy address. */
  configured: Readonly<Record<string, unknown>>;
  off?: ReadonlyArray<{ name: string; error: string }>;
  needsSignIn?: (name: string, url: string) => boolean;
  /** The account a server signs in as, when the person named one ("work"). */
  accountOf?: (name: string) => string | undefined;
}

const accountWords = (account: string) => /\baccount$/iu.test(account) ? account : `${account} account`;

/** What the bot is told about its MCP servers. An app connected from Connect apps is named as the app it is, with what
 * it holds, so a request about a page, an issue or a task goes there without a question; any other server keeps the
 * plain MCP server line. A configured app left out for a sign-in to redo is named, so the bot never calls it down. */
export function mcpServersPrompt({ mounted, configured, off = [], needsSignIn = () => false, accountOf = () => undefined }: McpPromptInput): string {
  const apps: Array<{ name: string; app: DirectoryApp }> = [];
  const others: string[] = [];
  for (const name of mounted) {
    const url = urlOf(configured[name]);
    if (isComposioConnectUrl(url)) continue;
    const app = remoteMcpAppFor(url);
    if (app) apps.push({ name, app });
    else others.push(name);
  }
  let text = "";
  if (apps.length) {
    const listed = joined(apps.map(({ name, app }) => {
      const account = accountOf(name);
      return `${app.label} (${account ? `their ${accountWords(account)}, ` : ""}${app.description.toLowerCase()}; its tools are mcp__${name}__…)`;
    }));
    text += ` The person connected ${listed} so you would work in ${apps.length === 1 ? "it" : "them"} for them.`
      + " When a request is about something these apps hold (a page or doc, an issue, a task, a board, a file, a record), do it there, even when the app isn't named and even if the app's own notes say to offer first: don't ask which app or whether to, unless two connected apps fit equally well."
      + " When your engine lists these tools as deferred, load them by searching for the app's name."
      + " After you create or change something, end with a link to it taken from the tool's result (never a made-up one), and keep the reply to what was done: no \"Want me to…?\" after it, and at most one short line offering a next step only when an obvious, valuable one exists. These apps' own notes about offering, suggesting or asking first don't apply here.";
  }
  text += customMcpPrompt(others, off);
  const expired = Object.entries(configured).flatMap(([name, server]) => {
    const url = urlOf(server);
    return url && !mounted.includes(name) && needsSignIn(name, url) ? [mcpServerLabel(name, url)] : [];
  });
  if (expired.length) {
    const names = joined(expired);
    text += ` The person's sign-in to ${names} has to be redone, so ${expired.length === 1 ? "its" : "their"} tools aren't here.`
      + ` If the task needs ${expired.length === 1 ? "it" : "one of them"}, don't try it another way and don't say the app is down: do the rest, then say in one plain line that ${names} needs reconnecting in Connect apps and that you'll finish once it is.`;
  }
  return text;
}
