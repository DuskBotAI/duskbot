import { noteRoutineRun } from "@/lib/product-analytics";
import { useCallback, useEffect, useRef, useState } from "react";
import { BotAvatar } from "@/components/Avatar";
import { WorkingDots } from "@/components/WorkingIndicator";
import { t } from "@/lib/i18n";
import { systemDialogs } from "@/lib/system-dialog";
import { routineDateTime, routineNextLabel, routineRunLabel, routineRunTime } from "@/lib/routine-display";
import { upperFirst } from "@/lib/lower-first";
import { scheduleLabel } from "@/lib/schedule-label";
import type { Routine, RoutineRun } from "@/lib/routines";
import { api, useStore } from "@/state/store";
import { Sheet } from "../Sheet";
import { SheetPush } from "../SheetPush";
import { haptic } from "../haptics";
import { SettingsSwitch } from "./SettingsRow";
import { SwipeRow } from "./SwipeRow";
import { EmptyState } from "../Illustration";
import type { SheetPageProps } from "./registry";

export function routineResultsThread(routine: Pick<Routine, "resultsThreadId">, bot: { threadId: string; mainThreadId?: string }): string {
  return routine.resultsThreadId ?? bot.mainThreadId ?? bot.threadId;
}

export function RoutinesSheet({ sheet, open, onClose, onOpenChat }: SheetPageProps<"routines">) {
  const { state, dispatch } = useStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string[]>([]);
  const pending = useRef(new Set<string>());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState(false);
  const [loading, setLoading] = useState(false);
  const requestVersion = useRef(0);
  const selected = state.routines.find((routine) => routine.id === selectedId);
  const bot = state.bots.find((entry) => entry.id === sheet.botId);
  const routines = state.routines.filter((routine) => !sheet.botId || routine.botId === sheet.botId);
  const load = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
    try {
      const answer = await api<{ routines: Routine[]; runs: RoutineRun[] }>(`/api/routines?since=${since}`);
      if (version === requestVersion.current) dispatch({ type: "routinesHydrated", routines: answer.routines, runs: answer.runs, since });
    } catch {
      if (version === requestVersion.current) { setError(t("mobile.routines.loadError")); haptic("error"); }
    } finally { if (version === requestVersion.current) setLoading(false); }
  }, [dispatch]);
  useEffect(() => {
    if (open && state.routinesLoadState !== "ready") void load();
    return () => { requestVersion.current++; };
  }, [open, load, state.routinesLoadState]);
  useEffect(() => { if (open) { setSelectedId(null); setArmed(null); setError(null); setNotice(false); } }, [open, sheet.botId]);
  useEffect(() => { if (!armed) return; const timer = window.setTimeout(() => setArmed(null), 3000); return () => window.clearTimeout(timer); }, [armed]);
  const work = async (routine: Routine, action: "toggle" | "run" | "delete") => {
    if (pending.current.has(routine.id)) return;
    if (action === "delete") {
      const dialogs = systemDialogs();
      if (dialogs) {
        const outcome = await dialogs.alert({
          title: t("mobile.routines.delete"),
          message: routine.name,
          confirmLabel: t("mobile.routines.delete"),
          cancelLabel: t("common.cancel"),
          tone: "danger",
        });
        if (outcome !== "confirm") return;
      } else if (armed !== routine.id) {
        setArmed(routine.id);
        return;
      }
    }
    pending.current.add(routine.id);
    setBusy([...pending.current]);
    setError(null);
    setNotice(false);
    try {
      const path = `/api/routines/${encodeURIComponent(routine.id)}`;
      if (action === "toggle") {
        const { routine: updated } = await api<{ routine: Routine }>(path, { method: "PATCH", body: JSON.stringify({ enabled: !routine.enabled }) });
        dispatch({ type: "routinePatched", routine: updated });
      } else if (action === "run") {
        const { run } = await api<{ run: RoutineRun }>(`${path}/run`, { method: "POST" });
        noteRoutineRun(run.id, run.status);
        dispatch({ type: "routineRunPatched", run });
        setNotice(true);
      } else {
        await api(path, { method: "DELETE" });
        dispatch({ type: "routineDeleted", routineId: routine.id });
        setArmed(null);
        if (selectedId === routine.id) setSelectedId(null);
      }
    } catch { setError(t(`mobile.routines.${action}Error`)); haptic("error"); }
    finally { pending.current.delete(routine.id); setBusy([...pending.current]); }
  };
  const back = () => { setSelectedId(null); setArmed(null); setError(null); setNotice(false); };
  const lastSelected = useRef<Routine | null>(null);
  if (selected) lastSelected.current = selected;
  const shown = selected ?? lastSelected.current;
  const runs = shown ? state.routineRuns.filter((run) => run.routineId === shown.id).sort((a, b) => routineRunTime(b) - routineRunTime(a)) : [];
  const selectedBot = state.bots.find((entry) => entry.id === shown?.botId);
  const askBot = bot ?? state.bots.find((entry) => entry.defaultBot && !entry.hidden) ?? state.bots.find((entry) => !entry.hidden);
  const loadFailed = state.routinesLoadState === "error" || error === t("mobile.routines.loadError");
  const title = bot ? t("mobile.routines.botTitle", { name: bot.name }) : t("mobile.routines.title");
  return (
    <Sheet open={open} onClose={onClose} full title={title}>
      <div className="px-4 pt-2">
        {error && !selected && (!loadFailed || routines.length > 0) && <p role="alert" className="px-3 py-3 text-[15px] text-danger">{error}</p>}
        {loadFailed && routines.length === 0 && !loading && <EmptyState tone="error" art="clock" title={t("mobile.routines.loadErrorTitle")} body={t("mobile.routines.loadErrorBody")} action={{ label: t("mobile.routines.retry"), onClick: () => void load() }} className="pt-16" />}
        {(loading || state.routinesLoadState === "loading" && !error) && !routines.length ? <div role="status" aria-label={t("mobile.routines.loading")}>{[0, 1, 2].map((key) => <div key={key} aria-hidden className="flex min-h-[84px] items-center gap-3 px-3 py-3"><span className="size-9 shrink-0 rounded-full bg-ink/[0.06]" /><span className="flex-1 space-y-2"><span className="block h-4 w-2/5 rounded-full bg-ink/[0.06]" /><span className="block h-3 w-3/5 rounded-full bg-ink/[0.05]" /></span></div>)}</div> : routines.length ? (
          <ul data-settings-card="" className="flex flex-col gap-[2px] overflow-hidden rounded-[16px] [&>*]:bg-menu [&_.mobile-row]:rounded-none">{routines.map((routine) => {
            const owner = state.bots.find((entry) => entry.id === routine.botId);
            return <li key={routine.id} aria-busy={busy.includes(routine.id)}>
              <SwipeRow actions={[{ label: armed === routine.id ? t("mobile.routines.confirmDelete") : t("mobile.routines.delete"), danger: true, onPress: () => void work(routine, "delete") }]}>
                <div className="flex items-center">
                  <button type="button" onClick={() => { setSelectedId(routine.id); setError(null); setNotice(false); setArmed(null); }} className="mobile-row flex min-h-[84px] min-w-0 flex-1 items-center gap-3 rounded-2xl px-3 py-3 text-left">
                    {owner && <BotAvatar bot={owner} size={36} animated={false} label="" />}
                    <span className="min-w-0 flex-1"><span className="block truncate text-[16px] font-semibold text-ink">{routine.name}</span><span className="mt-0.5 block text-[14px] text-ink-secondary">{upperFirst(scheduleLabel(routine.schedule))}</span><span className="block text-[14px] text-ink-secondary">{routineNextLabel(routine)}</span></span>
                  </button>
                  <div className="w-[68px] shrink-0 [&_button>span:first-child]:sr-only [&_button]:justify-center [&_button]:gap-0 [&_button]:px-2"><SettingsSwitch label={t("mobile.routines.enable", { name: routine.name })} checked={routine.enabled} onChange={() => { if (!pending.current.has(routine.id)) { haptic("toggle"); void work(routine, "toggle"); } }} /></div>
                </div>
              </SwipeRow>
            </li>;
          })}</ul>
        ) : !error && state.routinesLoadState === "ready" ? <EmptyState art="clock" title={t("mobile.routines.empty")} body={t("mobile.routines.emptyHint")} action={askBot ? { label: t("mobile.routines.ask", { name: askBot.name }), onClick: () => { onClose(); onOpenChat(askBot.id); } } : undefined} className="pt-16" /> : null}
      </div>
      <SheetPush open={Boolean(selected)} onClose={back} title={shown?.name}>
        {shown && (
          <div className="px-4 pt-2">
            {error && <p role="alert" className="px-3 py-3 text-[15px] text-danger">{error}</p>}
            <div className="flex flex-col gap-5 px-3">
              <div><h2 className="text-[14px] font-medium text-ink-secondary">{t("mobile.routines.schedule")}</h2><p className="mt-1 text-[16px] text-ink">{upperFirst(scheduleLabel(shown.schedule))}</p><p className="mt-1 text-[14px] text-ink-secondary">{routineNextLabel(shown)}</p></div>
              <p className="whitespace-pre-wrap text-[16px] text-ink-secondary">{shown.prompt}</p>
              <button type="button" disabled={busy.includes(shown.id)} onClick={() => void work(shown, "run")} className="mobile-press flex h-12 items-center justify-center gap-2 rounded-full bg-ink text-[16px] font-semibold text-app disabled:opacity-40">{busy.includes(shown.id) && <WorkingDots size={4} />}{t("mobile.routines.run")}</button>
              {notice && <p role="status" className="text-[14px] text-ink-secondary">{t("mobile.routines.started")}</p>}
              <button type="button" disabled={!selectedBot} onClick={() => { if (selectedBot) { onClose(); onOpenChat(selectedBot.id); dispatch({ type: "switchTask", botId: selectedBot.id, threadId: routineResultsThread(shown, selectedBot) }); } }} className="mobile-press h-12 rounded-full bg-ink/[0.05] text-[16px] font-semibold text-ink disabled:opacity-40">{t("mobile.routines.results")}</button>
              <section><h2 className="pb-2 text-[14px] font-medium text-ink-secondary">{t("mobile.routines.runs")}</h2>
                {runs.length ? <ul>{runs.map((run) => <li key={run.id} className="flex min-h-14 items-center justify-between gap-3 py-2"><span className="text-[16px] font-semibold text-ink">{routineRunLabel(run)}</span><time dateTime={new Date(routineRunTime(run)).toISOString()} className="text-right text-[14px] text-ink-secondary">{routineDateTime(routineRunTime(run))}</time></li>)}</ul> : <p className="py-3 text-[14px] text-ink-secondary">{t("mobile.routines.noRuns")}</p>}
              </section>
            </div>
          </div>
        )}
      </SheetPush>
    </Sheet>
  );
}
