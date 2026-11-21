/** AIs that only chat: they never read or write the bot's folder. */
const CHAT_ONLY_DRIVERS: ReadonlySet<string> = new Set(["grok", "openai-compat", "minimax", "mistral", "cerebras", "groq", "greenference", "meta"]);

export function supportsWorkspaceFiles(driverKind: string): boolean {
  return !CHAT_ONLY_DRIVERS.has(driverKind);
}
