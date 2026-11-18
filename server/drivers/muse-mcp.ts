import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { mountedMcpServerName } from "./codex-mcp-names.ts";
import type { TurnStdioMcpServer } from "./turn-mcp.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function readServers(path: string, scope: "user" | "project"): [string, unknown][] {
  try {
    const settings: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(settings)) return [];
    let servers = settings.mcpServers;
    // Muse Code accepts mcp_servers only in user settings and rejects a user file containing both spellings.
    if (scope === "user" && Object.hasOwn(settings, "mcp_servers")) {
      if (Object.hasOwn(settings, "mcpServers")) return [];
      servers = settings.mcp_servers;
    }
    if (isRecord(servers)) return Object.entries(servers);
  } catch {}
  return [];
}

// Muse Code with --trust-workspace loads .mcp.json in the physical workspace and its ancestors within the repository.
function projectSettings(cwd: string): string[] {
  let workspace: string;
  try {
    workspace = realpathSync.native(cwd);
  } catch {
    workspace = resolve(cwd);
  }
  const settings = [];
  for (let dir = workspace; dir !== dirname(dir); dir = dirname(dir)) {
    settings.push(join(dir, ".mcp.json"));
    if (existsSync(join(dir, ".git"))) return settings.reverse();
  }
  return [join(workspace, ".mcp.json")];
}

function equivalentStdio(saved: unknown, server: TurnStdioMcpServer): boolean {
  if (!isRecord(saved)) return false;
  const { type = "stdio", enabled = true, command, args = [], env = {}, ...options } = saved;
  return type === "stdio" && enabled === true && Object.keys(options).length === 0
    && command === server.command && isDeepStrictEqual(args, server.args) && isDeepStrictEqual(env, server.env);
}

export function museMcpConfig(servers: TurnStdioMcpServer[], cwd: string, env: NodeJS.ProcessEnv, reuseSaved: boolean) {
  const home = env.HOME || env.USERPROFILE || homedir();
  const userSettings = join(env.XDG_CONFIG_HOME || join(home, ".config"), "muse", "settings.json");
  const saved = new Map([...readServers(userSettings, "user"), ...projectSettings(cwd).flatMap((path) => readServers(path, "project"))]);
  const taken = new Set([...saved.keys(), ...servers.map(({ name }) => name)]);
  const names = new Map<string, string>();
  const mounts: Record<string, Omit<TurnStdioMcpServer, "name"> & { transport: "stdio"; mode: "optional" }> = Object.create(null);
  for (const server of servers) {
    const { name, command, args, env } = server;
    if (reuseSaved && equivalentStdio(saved.get(name), server)) {
      names.set(name, name);
      continue;
    }
    const mounted = saved.has(name) ? mountedMcpServerName(name, taken) : name;
    taken.add(mounted);
    names.set(name, mounted);
    mounts[mounted] = { transport: "stdio", command, args, env, mode: "optional" };
  }
  return { config: Object.keys(mounts).length ? { mcpServers: mounts } : undefined, names };
}

export function museMcpToolReferences(text: string, names: ReadonlyMap<string, string>): string {
  if (![...names].some(([name, mounted]) => name !== mounted)) return text;
  const alternatives = [...names.keys()].sort((a, b) => b.length - a.length).map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return text.replace(new RegExp(`\\bmcp__(${alternatives.join("|")})__`, "g"), (prefix, name: string) => {
    const mounted = names.get(name);
    return mounted ? `mcp__${mounted}__` : prefix;
  });
}
