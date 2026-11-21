import { plainTimeZone } from "../shared/plain-time-zone.ts";
import type { RoutineRequestSchedule } from "../shared/routine-request.ts";
import { serverLine } from "./server-lines.ts";

const CRON_DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const CRON_DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/** A daily, weekday or weekly cron at one time in plain words ("Weekdays at 10:00, London time"); null for any other rule. */
export function plainCronWhen(schedule: Extract<RoutineRequestSchedule, { type: "cron" }>): string | null {
  const [minute, hour, day, month, rawWeekday, extra] = schedule.expression.trim().split(/\s+/);
  if (extra !== undefined || day !== "*" || month !== "*" || !/^\d{1,2}$/.test(minute ?? "") || !/^\d{1,2}$/.test(hour ?? "")) return null;
  const params = { time: `${hour!.padStart(2, "0")}:${minute!.padStart(2, "0")}`, zone: plainTimeZone(schedule.timeZone) };
  const weekday = rawWeekday!.toUpperCase().replace(/\b(SUN|MON|TUE|WED|THU|FRI|SAT)\b/g, (name) => String(CRON_DAY_NAMES.indexOf(name)));
  if (weekday === "*") return serverLine(undefined, "server.routine.cronDaily", params);
  if (weekday === "1-5") return serverLine(undefined, "server.routine.cronWeekdays", params);
  if (/^[0-7]$/.test(weekday)) return serverLine(undefined, "server.routine.cronWeekly", { ...params, day: CRON_DAYS[Number(weekday) % 7]! });
  return null;
}
