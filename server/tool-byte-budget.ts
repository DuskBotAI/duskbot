// Shared eager MCP schema byte budget for engines with a fixed cross-server eager token cap
// (Antigravity CLI 1.5+ enforces a 20,000-token / ~58 KB eager MCP budget and silently evicts the largest tools first).

/** Maximum serialized `tools/list` bytes one MCP server should advertise for this turn. */
export const TOOL_BYTE_BUDGET_ENV = "DUSK_TOOL_BYTE_BUDGET";

/** Conservative total MCP tool-list byte budget under Antigravity CLI 1.5+'s 20,000-token (~58.5 KB) eager cap. */
export const ANTIGRAVITY_EAGER_BYTE_BUDGET = 54_000;

export type ByteBudgetTier = "primary" | "core" | "custom";

export interface ByteBudgetServer {
  name: string;
  tier: ByteBudgetTier;
  ceiling?: number;
}

export function parseToolByteBudget(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{1,7}$/.test(value)) return undefined;
  const parsed = Number(value);
  return parsed > 0 && parsed <= 2_000_000 ? parsed : undefined;
}

export function toolByteBudgetFromEnv(env: Record<string, string | undefined> = process.env): number | undefined {
  return parseToolByteBudget(env[TOOL_BYTE_BUDGET_ENV]);
}

function splitEvenly(servers: readonly ByteBudgetServer[], pool: number, shares: Map<string, number>, cap?: (server: ByteBudgetServer) => number | undefined): number {
  let remaining = pool;
  let active = [...servers];
  while (active.length > 0 && remaining > 0) {
    const base = Math.floor(remaining / active.length);
    const extra = remaining % active.length;
    if (base === 0 && extra === 0) break;
    const next: ByteBudgetServer[] = [];
    let progress = false;
    active.forEach((server, index) => {
      const want = base + (index < extra ? 1 : 0);
      if (want <= 0) return;
      const current = shares.get(server.name) ?? 0;
      const ceiling = cap?.(server);
      const room = ceiling === undefined ? want : Math.max(0, ceiling - current);
      const grant = Math.min(want, room);
      if (grant > 0) {
        shares.set(server.name, current + grant);
        remaining -= grant;
        progress = true;
      }
      if (ceiling === undefined || current + grant < ceiling) next.push(server);
    });
    if (!progress) break;
    active = next;
  }
  return remaining;
}

/** Shares `budget` bytes deterministically across a turn's MCP servers: primary servers first up to their ceilings,
 * then core servers, then custom servers, redistributing any unused budget back across all servers. */
export function shareToolByteBudget(servers: readonly ByteBudgetServer[], budget: number): Map<string, number> {
  const shares = new Map<string, number>();
  for (const server of servers) shares.set(server.name, 0);
  let remaining = Math.max(0, Math.floor(budget));
  if (servers.length === 0 || remaining === 0) return shares;

  const primary = servers.filter((server) => server.tier === "primary");
  const core = servers.filter((server) => server.tier === "core");
  const custom = servers.filter((server) => server.tier === "custom");

  remaining = splitEvenly(primary, remaining, shares, (server) => server.ceiling);
  if (custom.length > 0) {
    remaining = splitEvenly(core, remaining, shares, (server) => server.ceiling);
    remaining = splitEvenly(custom, remaining, shares);
  } else {
    remaining = splitEvenly(core, remaining, shares);
  }
  if (remaining > 0) splitEvenly(servers, remaining, shares);
  return shares;
}

/** Keeps tools in order while their serialized JSON fits within `maxBytes`, skipping oversized outliers so smaller
 * subsequent tools still load. */
export function capToolListByBytes<T>(tools: readonly T[], maxBytes: number | undefined): { tools: T[]; bytes: number; omitted: number } {
  if (maxBytes === undefined) return { tools: [...tools], bytes: 0, omitted: 0 };
  const kept: T[] = [];
  let used = 0;
  let omitted = 0;
  for (const tool of tools) {
    const serialized = JSON.stringify(tool);
    const bytes = serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8") + (kept.length > 0 ? 1 : 0);
    if (used + bytes <= maxBytes) {
      kept.push(tool);
      used += bytes;
    } else {
      omitted += 1;
    }
  }
  return { tools: kept, bytes: used, omitted };
}

/** A `tools/list` result capped to `maxBytes`, dropping `nextCursor` when trimmed so a later page cannot pass the share. */
export function capToolListResultByBytes(result: unknown, maxBytes: number | undefined, log?: (line: string) => void): unknown {
  if (maxBytes === undefined || !result || typeof result !== "object" || Array.isArray(result)) return result;
  const { tools, nextCursor: _next, ...rest } = result as { tools?: unknown; nextCursor?: unknown };
  if (!Array.isArray(tools)) return result;
  const capped = capToolListByBytes(tools, maxBytes);
  if (capped.omitted === 0) return result;
  log?.(`listed ${capped.tools.length} of ${tools.length} tools (${capped.bytes} of ${maxBytes} bytes) to fit the eager tool budget`);
  return { ...rest, tools: capped.tools };
}
