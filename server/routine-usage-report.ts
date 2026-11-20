// What the bot reads when the person asks what is using their usage: each automation of the bots it may answer for,
// with its runs and use over the last 7 and 30 days. Ids, names and numbers only; never a message or a person.
import type { UsagePeriod } from "../shared/spend.ts";

const SHOWN = 15;

export interface UsageReportInput {
  rows: ReadonlyArray<{ routineId: string; botId: string; name: string; week: UsagePeriod; month: UsagePeriod }>;
  /** The bots this turn may answer for, by id. */
  bots: ReadonlyMap<string, string>;
  automations: ReadonlyArray<{ id: string; name: string; kind: "schedule" | "webhook" | "app_event"; everyMinutes?: number }>;
  /** A routine's address id to the routine it runs. */
  runsRoutine: ReadonlyMap<string, string>;
}

const rounded = (period: UsagePeriod, priced: boolean) => ({
  runs: period.runs,
  ...(priced ? { usd: Math.round(period.usd * 100) / 100 } : { tokens: period.tokens }),
});

export function routineUsageReport(input: UsageReportInput) {
  const merged = new Map<string, { botId: string; name: string; week: UsagePeriod; month: UsagePeriod }>();
  for (const row of input.rows) {
    if (!input.bots.has(row.botId)) continue;
    const id = input.runsRoutine.get(row.routineId) ?? row.routineId;
    const held = merged.get(id);
    if (!held) { merged.set(id, { botId: row.botId, name: row.name, week: { ...row.week }, month: { ...row.month } }); continue; }
    for (const key of ["week", "month"] as const) {
      held[key].runs += row[key].runs; held[key].usd += row[key].usd; held[key].tokens += row[key].tokens;
    }
  }
  const priced = [...merged.values()].some((row) => row.month.usd > 0);
  const ranked = [...merged.entries()]
    .sort(([, a], [, b]) => (priced ? b.month.usd - a.month.usd : b.month.tokens - a.month.tokens) || b.week.runs - a.week.runs)
    .slice(0, SHOWN)
    .map(([id, row]) => {
      const automation = input.automations.find((one) => one.id === id);
      return {
        trigger_id: automation ? id : null,
        bot: input.bots.get(row.botId),
        name: automation?.name ?? row.name,
        kind: automation?.kind ?? "deleted",
        ...(automation?.everyMinutes ? { runsEveryMinutes: automation.everyMinutes } : {}),
        last7Days: rounded(row.week, priced),
        last30Days: rounded(row.month, priced),
      };
    });
  return {
    basis: priced ? "usd" : "tokens",
    automations: ranked,
    note: ranked.length
      ? "Most used first. A frequent schedule that keeps checking for something is usually the cause: offer to run it less often, or give the routine an address (trigger_info include_address) so the app or a phone shortcut wakes it only when something happens. A person's own chats are not listed here."
      : "No automation of these bots used anything in the last 30 days; the usage is from chats.",
  };
}
