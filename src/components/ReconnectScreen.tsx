import { useEffect, useState } from "react";
import { activeLocale, t } from "@/lib/i18n";
import type { ReconnectBridge, ReconnectView } from "../../electron/workspace-reconnect.mjs";
import { deviceHourCycle } from "@/lib/format-time";

/** Whole seconds until the next look, never below zero; null while a look is under way or none is planned. */
export function secondsLeft(view: ReconnectView | null, now = Date.now()): number | null {
  if (!view || view.checking || view.nextAt === null) return null;
  return Math.max(0, Math.ceil((view.nextAt - now) / 1000));
}

/** The page's lines: who it waits on and when it looks again. */
export function reconnectText(view: ReconnectView | null, now = Date.now()): { title: string; next: string | null } {
  if (!view) return { title: t("reconnect.opening"), next: null };
  if (view.gone) return { title: t("reconnect.gone", { name: view.name }), next: null };
  const seconds = secondsLeft(view, now);
  return { title: t(view.neverConnected ? "reconnect.notYet" : "reconnect.title", { name: view.name }), next: seconds === null ? t("reconnect.checking") : t("reconnect.next", { seconds: String(seconds) }) };
}

/**
 * This computer's own page while the chosen server isn't answering: its place stays chosen, its chats as last seen show
 * read only (nothing here asks it for anything), and the next look counts down. Main looks again by itself; this page
 * asks sooner when the network comes back or the window comes to the front, and the person may open another workspace.
 */
export function ReconnectScreen({ bridge }: { bridge: ReconnectBridge }) {
  const [view, setView] = useState<ReconnectView | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let alive = true;
    const stop = bridge.onState((next) => setView(next));
    const again = () => { void bridge.retry().then((next) => { if (alive) setView(next); }).catch(() => {}); };
    void bridge.state().then((next) => { if (alive) setView(next); }).catch(() => {});
    window.addEventListener("online", again);
    window.addEventListener("focus", again);
    return () => { alive = false; stop(); window.removeEventListener("online", again); window.removeEventListener("focus", again); };
  }, [bridge]);
  useEffect(() => {
    if (!view?.nextAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [view?.nextAt]);
  const text = reconnectText(view, now);
  const frame = view?.frame;
  const seen = frame ? new Intl.DateTimeFormat(activeLocale(), { dateStyle: "medium", timeStyle: "short", hourCycle: deviceHourCycle() }).format(new Date(frame.at)) : null;
  return (
    <main data-reconnect-screen className="flex min-h-screen justify-center overflow-y-auto bg-app px-6 py-16 text-ink" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
      <div className="flex w-full max-w-[460px] flex-col items-start gap-3" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        <p role="status" className="flex items-center gap-2 text-[20px] font-semibold">
          {view?.checking !== false && !view?.gone && <span aria-hidden="true" className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-transparent border-t-accent" />}
          {text.title}
        </p>
        {view && <p className="text-[14px] leading-relaxed text-ink-secondary">{view.gone ? t("reconnect.goneBody") : view.neverConnected ? t("reconnect.notYetBody", { host: view.host }) : t("reconnect.kept")}</p>}
        {text.next && <p data-reconnect-next className="text-[13px] tabular-nums text-ink-secondary">{text.next}</p>}
        {view && <div className="mt-1 flex flex-wrap gap-2">
          {!view.gone && <button type="button" data-reconnect-retry className="ui-button" disabled={view.checking}
            onClick={() => { void bridge.retry().then(setView).catch(() => {}); }}>{t("reconnect.retry")}</button>}
          {(view.neverConnected || view.gone) && <button type="button" data-reconnect-remove className="ui-button"
            onClick={() => { void bridge.remove().catch(() => {}); }}>{t("reconnect.remove")}</button>}
        </div>}
        {frame && (frame.bots.length > 0 || frame.groups.length > 0) && <section data-reconnect-frame aria-label={t("reconnect.lastSeen", { time: seen ?? "" })} className="mt-6 flex w-full flex-col gap-3">
          <p className="text-[12px] text-ink-secondary">{t("reconnect.lastSeen", { time: seen ?? "" })}</p>
          <ul className="flex flex-col gap-3" aria-readonly="true">
            {frame.bots.map((bot) => <li key={bot.id} data-reconnect-bot className="flex flex-col gap-1">
              <span className="text-[13px] font-medium text-ink">{bot.name}</span>
              {bot.chats.length > 0 && <ul className="flex flex-col gap-0.5 pl-3">
                {bot.chats.map((chat) => <li key={chat.id} className="truncate text-[13px] text-ink-secondary">{chat.title || t("task.untitledConversation")}</li>)}
              </ul>}
            </li>)}
            {frame.groups.length > 0 && <li data-reconnect-groups className="flex flex-col gap-1">
              <span className="text-[13px] font-medium text-ink">{t("reconnect.groups")}</span>
              <ul className="flex flex-col gap-0.5 pl-3">
                {frame.groups.map((group) => <li key={group.id} className="truncate text-[13px] text-ink-secondary">{group.name}</li>)}
              </ul>
            </li>}
          </ul>
        </section>}
        {view && view.places.length > 0 && <section data-reconnect-places className="mt-6 flex w-full flex-col gap-2">
          <p className="text-[12px] text-ink-secondary">{t("reconnect.other")}</p>
          <div className="flex flex-wrap gap-2">
            {view.places.map((place) => <button key={place.id} type="button" data-reconnect-open={place.id} className="ui-button"
              onClick={() => { void bridge.open(place.id).catch(() => {}); }}>{place.local ? t("rail.thisComputer") : place.name}</button>)}
          </div>
        </section>}
      </div>
    </main>
  );
}
