import { useCallback, useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";

import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { ACTIVITY_WHATS, activityQuery, describeEntry, formatValue, whoLabel, type ActivityEntry, type ActivityFilters, type ActivityWhat } from "@/lib/activity";
import type { LocaleKey } from "@/locales";
import { Card as RowsCard, FormDialog, FormField, ItemRow, NavRow, NoteRow } from "./ListRows";
import { SettingRow } from "./SettingsPrimitives";
import { SettingsSelect } from "./SettingsSelect";
import { textFieldCls } from "./ui/GrokDialog";
import { friendlyError } from "@/lib/plain-error";
import { ArtState } from "./ui/Art";

/** One entry: who did what as the row, when (and what was approved) as its quiet line; an admin change opens its
 * before and after under it, one path a line. */
export function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const [open, setOpen] = useState(false);
  const detail = entry.type === "admin" && (entry.changed?.length || entry.before || entry.after);
  const when = <time className="tabular-nums" dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time>;
  return (
    <li className="contents" data-activity-entry={entry.type}>
      <ItemRow title={<><span className="text-ink">{whoLabel(entry.who)}</span> <span className="break-words">{describeEntry(entry)}</span></>}
        hint={entry.type === "approval" && entry.summary ? <>{when} · {entry.summary}</> : when}>
        {detail && (
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="ui-button">
            {t("activity.changed", { paths: (entry.changed ?? []).join(", ") || "-" })}
          </button>
        )}
      </ItemRow>
      {detail && open && entry.type === "admin" && (entry.changed ?? Object.keys({ ...entry.before, ...entry.after })).map((path) => (
        <NoteRow key={path}>
          <span className="text-ink">{path}</span>: {formatValue(entry.before?.[path])} {"→"} {formatValue(entry.after?.[path])}
        </NoteRow>
      ))}
    </li>
  );
}

export function ActivitySection() {
  const [filters, setFilters] = useState<ActivityFilters>({ who: "", what: "all", from: "", to: "" });
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [days, setDays] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<"who" | "dates" | null>(null);
  const query = activityQuery(filters);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const body = await api(`/api/admin-activity${query}`) as { entries: ActivityEntry[]; total: number; retentionDays: number };
      setEntries(body.entries);
      setTotal(body.total);
      setDays(body.retentionDays);
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 250);
    return () => window.clearTimeout(timer);
  }, [load]);

  const set = (patch: Partial<ActivityFilters>) => setFilters((current) => ({ ...current, ...patch }));
  const dates = filters.from || filters.to ? `${filters.from || "…"} ${t("activity.to").toLowerCase()} ${filters.to || "…"}` : t("settings.s2.activity.anyTime");
  return (
    <>
      <RowsCard label={t("settings.s2.activity.filters")} data-settings-block="activity-filters">
        <NavRow data-settings-open="activity-who" title={t("activity.who")} value={filters.who || t("settings.s2.activity.anyone")} onClick={() => setEditing("who")} />
        <SettingRow title={t("activity.what")}>
            <SettingsSelect data-settings-select="activity-what" aria-label={t("activity.what")} value={filters.what}
              options={ACTIVITY_WHATS.map((what) => ({ value: what, label: t(`activity.what.${what}` as LocaleKey) }))}
              onChange={(event) => set({ what: event.target.value as ActivityWhat })} />
        </SettingRow>
        <NavRow data-settings-open="activity-dates" title={t("settings.s2.activity.dates")} value={dates} onClick={() => setEditing("dates")} />
      </RowsCard>
      <RowsCard label={t("settings.s2.activity.log")} data-settings-block="activity-log">
        <ItemRow title={t("settings.w6c.activity.kept", { days: String(days ?? 180) })}
          hint={total > entries.length ? t("activity.more", { shown: String(entries.length), total: String(total) }) : undefined}>
          <button type="button" onClick={() => void load()} disabled={loading} className="ui-button">{t("activity.refresh")}</button>
          <a href={`/api/admin-activity.csv${query}`} download className="ui-button">{t("activity.export")}</a>
        </ItemRow>
        {error && <NoteRow tone="danger">{t("activity.error", { message: error })}</NoteRow>}
        {!error && entries.length === 0 && !loading && <ArtState data-art-state="activity" art="binoculars" title={t("empty.activity.title")} className="py-6">{t("empty.activity.hint")}</ArtState>}
        {entries.length > 0 && <ul className="contents">{entries.map((entry, index) => <ActivityRow key={`${entry.at}-${index}`} entry={entry} />)}</ul>}
      </RowsCard>
      <AnimatePresence>{editing === "who" && (
        <FormDialog key="activity-who" data-panel-modal="activity-who" title={t("activity.who")} onClose={() => setEditing(null)}>
          <FormField label={t("activity.who")}>
            <input autoFocus value={filters.who} onChange={(e) => set({ who: e.target.value })} placeholder={t("activity.whoPlaceholder")} className={textFieldCls} />
          </FormField>
        </FormDialog>
      )}</AnimatePresence>
      <AnimatePresence>{editing === "dates" && (
        <FormDialog key="activity-dates" data-panel-modal="activity-dates" title={t("settings.s2.activity.dates")} onClose={() => setEditing(null)}>
          <FormField label={t("activity.from")}>
            <input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => set({ from: e.target.value })} className={textFieldCls} />
          </FormField>
          <FormField label={t("activity.to")}>
            <input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => set({ to: e.target.value })} className={textFieldCls} />
          </FormField>
        </FormDialog>
      )}</AnimatePresence>
    </>
  );
}
