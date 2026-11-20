import { AlarmClock } from "../icons";
import type { AsleepWork } from "@/lib/asleep-work";
import { useUpsellShown } from "@/lib/cloud-upsell";
import { activeLocale, t } from "@/lib/i18n";
import type { LateRoutineRun } from "@/lib/late-routine";
import { routineDateTime } from "@/lib/routine-display";
import { sleepDevice, type RoutineSleep } from "@/lib/routine-sleep";
import { NoticeCard, NotNowButton, PRIMARY_BUTTON } from "./NoticeCard";
import { deviceWord } from "./vps-link/parts";
import { deviceHourCycle } from "@/lib/format-time";

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
/** A time alone when `day` already says the day (today, or the day it was due), else the date with it. */
const clock = (at: number, day: number) => sameDay(at, day)
  ? new Date(at).toLocaleTimeString(activeLocale(), { hour: "numeric", minute: "2-digit", hourCycle: deviceHourCycle() }) : routineDateTime(at);

/** A routine on this computer ran late, or not at all, while the computer slept: the one moment dusk cloud answers on
 * its own. Shown once, in the corner, never over a chat. */
export function LateRoutineCard({ late, now, onStart, onNotNow }: { late: LateRoutineRun; now: number; onStart: () => void; onNotNow: () => void }) {
  useUpsellShown("app_late_routine");
  const device = deviceWord();
  const missed = late.ranAt === null;
  return <NoticeCard titleId="late-routine-title" notice="late-routine" icon={AlarmClock} pixel="clock"
    title={t(missed ? "routines.late.titleMissed" : "routines.late.title", { name: late.name })} onDismiss={onNotNow}>
    <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
      {missed ? t("routines.late.bodyMissed", { due: clock(late.dueAt, now), device })
        : t("routines.late.body", { due: clock(late.dueAt, now), ran: clock(late.ranAt!, late.dueAt), device })}
    </p>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
      <button type="button" data-late-routine-start="" className={PRIMARY_BUTTON} onClick={onStart}>{t("routines.late.start")}</button>
      <NotNowButton onClick={onNotNow} />
    </div>
  </NoticeCard>;
}

/** A bot was working when this computer went to sleep. Shown once, in the corner, never over a chat. */
export function AsleepWorkCard({ slept, onStart, onNotNow }: { slept: AsleepWork; onStart: () => void; onNotNow: () => void }) {
  useUpsellShown("app_asleep");
  const device = deviceWord();
  return <NoticeCard titleId="asleep-work-title" notice="asleep-work" icon={AlarmClock} pixel="laptop"
    title={t("notices.asleep.title", { name: slept.name, device })} onDismiss={onNotNow}>
    <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">{t("notices.asleep.body", { device })}</p>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
      <button type="button" data-asleep-work-start="" className={PRIMARY_BUTTON} onClick={onStart}>{t("routines.late.start")}</button>
      <NotNowButton onClick={onNotNow} />
    </div>
  </NoticeCard>;
}

export const sleepDeviceWord = () => t(`vpsLink.device.${sleepDevice(typeof window === "undefined" ? undefined : window.duskDesktop?.platform)}`);

/** This computer's sleep is costing its routines: run them on dusk cloud, or keep it awake while plugged in. Shown once,
 * in the corner, never over a chat. */
export function RoutineSleepCard({ sleep, onCloud, onKeepAwake, onDismiss }: { sleep: RoutineSleep; onCloud: () => void; onKeepAwake: () => void; onDismiss: () => void }) {
  useUpsellShown("app_late_routine");
  const device = sleepDeviceWord();
  return <NoticeCard titleId="routine-sleep-title" notice="routine-sleep" icon={AlarmClock} pixel="laptop"
    title={t("routines.sleep.title", { device })} onDismiss={onDismiss}>
    <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
      {sleep.reason === "missed" ? t("routines.sleep.bodyMissed", { count: sleep.count }) : t("routines.sleep.bodySlept")}
    </p>
    <div className="mt-3 flex flex-col items-stretch gap-2">
      <button type="button" data-routine-sleep-cloud="" className={PRIMARY_BUTTON} onClick={onCloud}>{t("routines.sleep.cloud")}</button>
      <button type="button" data-routine-sleep-awake="" className="ui-button min-h-9 px-3 py-1.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus" onClick={onKeepAwake}>{t("routines.sleep.awake", { device })}</button>
    </div>
  </NoticeCard>;
}
