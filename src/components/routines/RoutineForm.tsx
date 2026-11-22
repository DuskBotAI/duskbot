import { useId, useState, type FormEvent, type KeyboardEvent } from "react";

import { isDone, plainWhen } from "@/lib/automations";
import { cn } from "@/lib/cn";
import { activeLocale, t } from "@/lib/i18n";
import { upperFirst } from "@/lib/lower-first";
import { probeLine } from "@/lib/routine-display";
import type { Routine, RoutineInput, RoutineProbe, RoutineRunOn } from "@/lib/routines";
import { autoRoutineName, editedSchedule, newWhenDraft, scheduleFromDraft, whenDraftFor, type WhenDraft, type WhenPreset } from "@/lib/routine-when";
import { imeComposing } from "@/lib/send-key";
import { phoneApp } from "@/lib/store-app";
import { useStore, type Bot } from "@/state/store";
import { useBotEditor } from "../bot-settings/BotEditorContext";
import { buttonCls, fieldCls, Segmented } from "../bot-panel/rows";
import { SelectPill } from "../ui/SelectPill";
import { Toggle } from "../ui/Toggle";
import { AlwaysOnNote } from "../CloudUpsell";
import { friendlyError } from "@/lib/plain-error";
import { deviceHourCycle } from "@/lib/format-time";

const labelCls = "block text-[12px] leading-4 tracking-[0.01em] text-ink-secondary";
const primaryCls = cn(buttonCls, "bg-ink text-app shadow-none enabled:hover:bg-ink/85");
const PRESETS: readonly Exclude<WhenPreset, "keep">[] = ["daily", "weekdays", "weekly", "hourly", "once"];

/** "9", "9pm", "9:30 am", "21:30", "930", "24:00" -> "HH:MM", or null. */
export function parseTypedTime(text: string): string | null {
  const m = /^\s*(\d{1,2})(?:[:.\s]?(\d{2}))?\s*([ap])?\.?\s*m?\.?\s*$/i.exec(text);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const half = m[3]?.toLowerCase();
  if (hour === 24 && minute === 0 && !half) hour = 0;
  if (minute > 59 || hour > 23 || (half && (hour < 1 || hour > 12))) return null;
  if (half === "p" && hour < 12) hour += 12;
  if (half === "a" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** "Around" saves money only where a cloud desktop sleeps between runs: a cloud home, or a routine that runs on one. */
export function aroundSavesSleep({ cloudHome, runOn }: { cloudHome: boolean; runOn?: RoutineRunOn }): boolean {
  return cloudHome || runOn === "cloud";
}

const shownTime = (time: string) => {
  const [h, m] = time.split(":").map(Number);
  return new Date(2026, 0, 1, h ?? 0, m ?? 0).toLocaleTimeString(activeLocale(), { hour: "numeric", minute: "2-digit", hourCycle: deviceHourCycle() });
};

export function TimeField({ value, onChange }: { value: string; onChange: (time: string | null) => void }) {
  const [text, setText] = useState(() => shownTime(value));
  const [bad, setBad] = useState(false);
  if (phoneApp()) {
    return (
      <input
        type="time"
        data-routine-time=""
        aria-label={t("routines.inline.time")}
        value={value}
        onChange={(event) => { if (event.target.value) onChange(event.target.value); }}
        className={cn(fieldCls, "w-auto flex-none")}
      />
    );
  }
  const commit = () => {
    const time = parseTypedTime(text);
    if (!time) return setBad(true);
    setBad(false);
    onChange(time);
    setText(shownTime(time));
  };
  return (
    <input
      type="text"
      data-routine-time=""
      aria-label={t("routines.inline.time")}
      aria-invalid={bad || undefined}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        setBad(false);
        onChange(parseTypedTime(event.target.value));
      }}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === "Enter" && !imeComposing(event.nativeEvent)) { event.preventDefault(); commit(); } }}
      className={cn(fieldCls, "w-[7.5rem] flex-none", bad && "border-danger")}
    />
  );
}

const dayName = (day: number) => new Date(2026, 0, 4 + day).toLocaleDateString(activeLocale(), { weekday: "long" });

const PROBE_KINDS: readonly Exclude<RoutineProbe["kind"], "script">[] = ["page", "feed", "price"];
const WAKING = { start: "07:00", end: "23:00" };

/** One routine's name, when and what, edited in place: a new one for `bot`, or `routine` as it is saved, with how exact
 * its time is, the hours an hourly one keeps, and an optional page, feed or price it checks before waking the bot.
 * Everything else a routine carries (where it runs, where results go, files) is kept as it is. */
export function RoutineForm({ bot, routine, defaultRunOn, onDone }: {
  bot: Bot;
  routine?: Routine;
  defaultRunOn?: RoutineRunOn;
  onDone: (saved?: Routine) => void;
}) {
  const { state, dispatch } = useStore();
  const { request } = useBotEditor();
  const id = useId();
  const [name, setName] = useState(routine?.name ?? "");
  const [prompt, setPrompt] = useState(routine?.prompt ?? "");
  const [savedWhen] = useState<WhenDraft | null>(() => (routine ? whenDraftFor(routine.schedule) : null));
  const [when, setWhen] = useState<WhenDraft>(() => savedWhen ?? newWhenDraft());
  // a new daily routine runs around its time unless the person pins it
  const [timing, setTiming] = useState<"exact" | "around">(routine ? (routine.timing === "around" ? "around" : "exact") : "around");
  const [probe, setProbe] = useState<RoutineProbe | null>(routine?.probe ?? null);
  const [watching, setWatching] = useState(Boolean(routine?.probe));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const patchWhen = (next: Partial<WhenDraft>) => setWhen((current) => ({ ...current, ...next }));

  const presetOptions = [
    ...(when.preset === "keep" && routine ? [{ value: "keep" as const, label: upperFirst(plainWhen(routine.schedule)) }] : []),
    ...PRESETS.map((preset) => ({ value: preset, label: upperFirst(t(`routines.inline.preset.${preset}`)) })),
  ];

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    if (saving) return;
    const what = prompt.trim();
    if (!what) { setError(t("routines.inline.error.what")); return; }
    const { schedule, error: whenError } = savedWhen ? editedSchedule(savedWhen, when) : scheduleFromDraft(when);
    if (whenError) { setError(t(whenError)); return; }
    const named = name.trim() || autoRoutineName(what);
    const timed = when.preset !== "hourly" && when.preset !== "keep" ? { timing: timing === "around" ? "around" as const : null } : {};
    const kept = routine?.probe;
    const unchanged = watching && kept && probe && probe.kind === kept.kind && probe.url.trim() === kept.url;
    const watched = unchanged ? {} : watching && probe?.url.trim() ? { probe: { kind: probe.kind, url: probe.url.trim() } } : kept ? { probe: null } : {};
    const body: Partial<RoutineInput> = routine
      ? { name: named, prompt: what, ...(schedule ? { schedule } : {}), ...timed, ...watched, ...(schedule && !routine.enabled && isDone(routine) ? { enabled: true } : {}) }
      : { name: named, prompt: what, botId: bot.id, enabled: true, schedule, ...timed, ...watched, ...(defaultRunOn ? { runOn: defaultRunOn } : {}) };
    setSaving(true);
    setError("");
    try {
      const response = await request(routine ? `/api/routines/${routine.id}` : "/api/routines", { method: routine ? "PATCH" : "POST", body: JSON.stringify(body) });
      dispatch({ type: "routinePatched", routine: response.routine });
      onDone(response.routine as Routine);
    } catch (cause) {
      setError(friendlyError(cause));
      setSaving(false);
    }
  };
  const keys = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.stopPropagation(); onDone(); }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !imeComposing(event.nativeEvent)) void save();
  };

  return (
    <form data-routine-form={routine?.id ?? "new"} onSubmit={(event) => void save(event)} onKeyDown={keys} className="flex flex-col gap-3 px-2 pb-2 pt-1.5">
      <div>
        <label htmlFor={`${id}-name`} className={labelCls}>{upperFirst(t("routines.inline.name"))}</label>
        <input
          id={`${id}-name`}
          autoFocus={Boolean(routine) && !phoneApp()}
          value={name}
          maxLength={80}
          placeholder={autoRoutineName(prompt) || upperFirst(t("routines.inline.namePlaceholder"))}
          onChange={(event) => setName(event.target.value)}
          className={cn(fieldCls, "mt-1 w-full")}
        />
      </div>
      <div>
        <span id={`${id}-when`} className={labelCls}>{upperFirst(t("routines.inline.when"))}</span>
        <div role="group" aria-labelledby={`${id}-when`} className="mt-1 flex flex-wrap items-center gap-1.5">
          <SelectPill data-panel-select="routine-when" aria-label={t("routines.inline.when")} value={when.preset} options={presetOptions} onChange={(preset) => patchWhen({ preset })} />
          {when.preset === "weekly" && (
            <SelectPill aria-label={t("routines.inline.day")} value={String(when.day)} options={[0, 1, 2, 3, 4, 5, 6].map((day) => ({ value: String(day), label: dayName(day) }))} onChange={(day) => patchWhen({ day: Number(day) })} />
          )}
          {when.preset === "once" && (
            <input type="date" aria-label={t("routines.inline.date")} value={when.date} onChange={(event) => patchWhen({ date: event.target.value })} className={cn(fieldCls, "w-auto flex-none")} />
          )}
          {when.preset !== "hourly" && when.preset !== "keep" && (
            <TimeField value={when.time} onChange={(time) => patchWhen({ time: time ?? "" })} />
          )}
        </div>
        {when.preset !== "hourly" && when.preset !== "keep" && (
          <div className="mt-1.5">
            <Segmented label={upperFirst(t("routines.timing.label"))} attr="routine-timing" compact value={timing} onChange={setTiming}
              options={[{ value: "exact", label: upperFirst(t("routines.timing.exact")) }, { value: "around", label: upperFirst(t("routines.timing.around")) }]} />
            {timing === "around" && aroundSavesSleep({ cloudHome: state.config?.cloudHome === true, runOn: routine?.runOn ?? defaultRunOn }) && <p className="m-0 mt-1 text-[12px] leading-4 text-ink-secondary">{t("routines.timing.aroundHint")}</p>}
          </div>
        )}
        {when.preset === "hourly" && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5" data-routine-quiet="">
            {phoneApp() ? (
              <div className="flex w-full items-center justify-between gap-2 text-[13px] leading-[18px] text-ink">
                <span>{upperFirst(t("routines.hours.quietAtNight"))}</span>
                <Toggle
                  checked={when.window !== null}
                  aria-label={upperFirst(t("routines.hours.quietAtNight"))}
                  onClick={() => patchWhen({ window: when.window === null ? (routine ? WAKING : undefined) : null })}
                />
              </div>
            ) : (
              <label className="flex items-center gap-1.5 text-[13px] leading-[18px] text-ink">
                <input type="checkbox" checked={when.window !== null} onChange={(event) => patchWhen({ window: event.target.checked ? (routine ? WAKING : undefined) : null })} />
                {upperFirst(t("routines.hours.quietAtNight"))}
              </label>
            )}
            {when.window && (
              <>
                <TimeField value={when.window.start} onChange={(start) => patchWhen({ window: { ...when.window!, start: start ?? "" } })} />
                <span className="text-[13px] text-ink-secondary">{t("routines.hours.to")}</span>
                <TimeField value={when.window.end} onChange={(end) => patchWhen({ window: { ...when.window!, end: end ?? "" } })} />
              </>
            )}
            {when.window === undefined && <span className="text-[12px] leading-4 text-ink-secondary">{t("routines.hours.learned")}</span>}
          </div>
        )}
      </div>
      <div>
        <label htmlFor={`${id}-what`} className={labelCls}>{upperFirst(t("routines.inline.what"))}</label>
        <textarea
          id={`${id}-what`}
          autoFocus={!routine && !phoneApp()}
          rows={3}
          value={prompt}
          placeholder={upperFirst(t("routines.inline.whatPlaceholder"))}
          onChange={(event) => setPrompt(event.target.value)}
          className={cn(fieldCls, "mt-1 h-auto max-h-[40vh] min-h-[4.75rem] w-full resize-none py-1.5 [field-sizing:content]")}
        />
      </div>
      {when.preset !== "once" && (
        <div data-routine-probe="">
          {phoneApp() ? (
            <div className="flex items-center justify-between gap-2 text-[13px] leading-[18px] text-ink">
              <span>{upperFirst(t("routines.probe.toggle"))}</span>
              <Toggle
                checked={watching}
                aria-label={upperFirst(t("routines.probe.toggle"))}
                onClick={() => {
                  const next = !watching;
                  setWatching(next);
                  if (next && !probe) setProbe({ kind: "page", url: "" });
                }}
              />
            </div>
          ) : (
            <label className="flex items-center gap-1.5 text-[13px] leading-[18px] text-ink">
              <input type="checkbox" checked={watching} onChange={(event) => { setWatching(event.target.checked); if (event.target.checked && !probe) setProbe({ kind: "page", url: "" }); }} />
              {upperFirst(t("routines.probe.toggle"))}
            </label>
          )}
          {watching && probe?.kind === "script" && <p className="m-0 mt-1 text-[13px] leading-[18px] text-ink">{upperFirst(probeLine(probe))}</p>}
          {watching && probe && probe.kind !== "script" && (
            <div className="mt-1 flex items-center gap-1.5">
              <SelectPill aria-label={t("routines.probe.kind")} value={probe.kind} options={PROBE_KINDS.map((kind) => ({ value: kind, label: t(`routines.probe.kind.${kind}`) }))}
                onChange={(kind) => setProbe({ ...probe, kind })} />
              <input type="url" inputMode="url" aria-label={t("routines.probe.url")} placeholder="https://" value={probe.url}
                onChange={(event) => setProbe({ ...probe, url: event.target.value })} className={cn(fieldCls, "w-full")} />
            </div>
          )}
          {watching && <p className="m-0 mt-1 text-[12px] leading-4 text-ink-secondary">{t("routines.probe.hint")}</p>}
        </div>
      )}
      {!routine && <AlwaysOnNote />}
      {error && <p role="alert" className="m-0 text-[12px] leading-4 text-danger">{error}</p>}
      <div className="flex justify-end gap-1.5">
        <button type="button" onClick={() => onDone()} className={buttonCls}>{upperFirst(t("common.cancel"))}</button>
        <button type="submit" disabled={saving || !prompt.trim()} className={primaryCls}>{upperFirst(t("common.save"))}</button>
      </div>
    </form>
  );
}
