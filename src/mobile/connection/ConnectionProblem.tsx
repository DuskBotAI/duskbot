import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { RotateCcw } from "../../icons";
import { useStore } from "@/state/store";
import { WorkingDots } from "@/components/WorkingIndicator";
import { cloudAsleep, cloudWaking, markCloudAwake, onCloudPower, onCloudWaking } from "@/lib/cloud-power";
import { retryLiveEventsNow } from "@/lib/live-events";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { isGlassDark, useGlassPill } from "../native-glass";
import { PlatformContext, usePlatform } from "../platform";
import { useOffline } from "../network";
import { refreshSnapshot } from "../refresh";
import { LoadingMascot, PixelArt } from "../Illustration";
import { spring } from "../motion";
import { ActiveConnection } from "./active";
import { useConnections } from "./connections";
import { useQuietResume } from "./quiet-resume";
import { onWorkspaceAnswer, workspaceAnsweredAt } from "./reachability";

/** the live stream is asked to reconnect at most this often when the place answers while it is down */
export const ANSWER_RETRY_GAP_MS = 5_000;
import { placeKind, useConnectionNotice, type ConnectionNotice, type PlaceKind } from "./connection-notice";

export type LivePlace = { name: string; kind: PlaceKind };

/** The phone's live connection as one thing to say, the place it is about, and the one action that helps. */
export function useLiveConnection(): { notice: ConnectionNotice; place: LivePlace; retry(): void; trying: boolean } {
  const { state, dispatch } = useStore();
  const platform = usePlatform();
  const resuming = useQuietResume(platform);
  const offline = useOffline();
  const waking = useSyncExternalStore(onCloudWaking, cloudWaking, () => false);
  const asleep = useSyncExternalStore(onCloudPower, cloudAsleep, () => false);
  const answeredAt = useSyncExternalStore(onWorkspaceAnswer, workspaceAnsweredAt, () => null);
  const connected = state.connected === true;
  const { notice, restart } = useConnectionNotice({ hydrated: state.hydrated === true, connected, offline, waking, resuming, asleep, answeredAt });
  // the place answers but the stream is down: it can connect now, so it tries without waiting out its backoff
  const kicked = useRef(-Infinity);
  useEffect(() => {
    if (connected || answeredAt === null || answeredAt - kicked.current < ANSWER_RETRY_GAP_MS) return;
    kicked.current = answeredAt;
    retryLiveEventsNow();
  }, [connected, answeredAt]);
  const activeId = useContext(ActiveConnection);
  const { connections } = useConnections();
  const record = connections.find((connection) => connection.id === activeId);
  const kind = placeKind(record);
  const place = { name: record?.label?.trim() || t(kind === "cloud" ? "mobile.connection.yourCloud" : "mobile.connection.yourComputer"), kind };
  const [trying, setTrying] = useState(false);
  const retry = useCallback(() => {
    restart();
    setTrying(true);
    markCloudAwake("click");
    retryLiveEventsNow();
    void refreshSnapshot(state, dispatch).catch(() => {}).finally(() => setTrying(false));
  }, [restart, state, dispatch]);
  return { notice, place, retry, trying };
}

const PROBLEM: ReadonlySet<ConnectionNotice> = new Set(["stuck", "wake-slow"]);
export const isConnectionProblem = (notice: ConnectionNotice) => PROBLEM.has(notice);

const sentence = (text: string) => text.charAt(0).toLocaleUpperCase() + text.slice(1);

export function problemCopy(notice: ConnectionNotice, place: LivePlace): { title: string; body: string } {
  if (notice === "wake-slow") return { title: sentence(t("mobile.connection.wakeSlowTitle", { name: place.name })), body: t("mobile.connection.wakeSlowBody") };
  return {
    title: t("mobile.unreachable.title", { name: place.name }),
    body: t(place.kind === "cloud" ? "mobile.connection.stuckCloud" : "mobile.connection.stuckComputer"),
  };
}

/** The floating status: a short word while it reconnects, and once that has gone on too long, a button to try again. */
/** The notice in words, as the pill and the system's bar both say it. */
export function connectionNoticeLabel(notice: NonNullable<ConnectionNotice>, trying: boolean): string {
  if (isConnectionProblem(notice)) return t(trying ? "mobile.connection.trying" : "mobile.connection.notConnected");
  return notice === "offline" ? t("mobile.home.offline") : t(notice === "waking" ? "cloudAsleep.waking" : "mobile.home.reconnecting");
}

export function ConnectionPill({ notice, trying, onRetry, testId, className = "h-11 px-4" }: { notice: ConnectionNotice; trying: boolean; onRetry(): void; testId: string; className?: string }) {
  const glass = useContext(PlatformContext)?.glass;
  const pillRef = useRef<HTMLElement | null>(null);
  const onRetryRef = useRef(onRetry);
  onRetryRef.current = onRetry;
  const [topOffset, setTopOffset] = useState(112);
  const [obscured, setObscured] = useState(false);

  useLayoutEffect(() => {
    if (!glass?.pill || !notice) return;
    let raf = 0;
    const sync = () => {
      raf = 0;
      const rect = pillRef.current?.getBoundingClientRect();
      if (rect && rect.top > 0) setTopOffset(Math.round(rect.top));
      setObscured(Boolean(document.querySelector(".mobile-sheet-layer, [data-image-viewer], [data-phone-takeover]")));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(sync);
    };
    sync();
    const observer = typeof MutationObserver === "function" ? new MutationObserver(schedule) : null;
    observer?.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [glass, notice]);

  const problem = notice !== null && isConnectionProblem(notice);
  const nativePill = useGlassPill(
    glass,
    "top",
    notice && !obscured
      ? {
          id: testId,
          text: connectionNoticeLabel(notice, trying),
          tone: "neutral",
          spinner: notice !== "offline" && (!problem || trying),
          symbol: notice === "offline" ? "wifi.slash" : problem && !trying ? "arrow.counterclockwise" : undefined,
          offset: topOffset,
          dark: isGlassDark(),
          tappable: problem && !trying,
        }
      : null,
    { onPill: () => onRetryRef.current() },
  );

  if (!notice) return null;
  const hiddenCls = nativePill ? "opacity-0 pointer-events-none" : "pointer-events-auto";
  const base = cn(
    "mobile-float mobile-glass bg-composer relative flex min-w-0 items-center gap-2 whitespace-nowrap rounded-full text-[13px] font-medium",
    hiddenCls,
    className,
  );
  if (problem) {
    return (
      <button ref={(el) => { pillRef.current = el; }} type="button" data-testid={testId} data-notice={notice} disabled={trying} onClick={onRetry} className={cn(base, "mobile-press text-ink")}>
        {trying ? <WorkingDots size={3} /> : <RotateCcw size={14} aria-hidden />}
        {connectionNoticeLabel(notice, trying)}
      </button>
    );
  }
  return (
    <span ref={(el) => { pillRef.current = el; }} role="status" data-testid={testId} data-notice={notice} className={cn(base, "text-ink-secondary")}>
      {notice !== "offline" && <LoadingMascot size={20} />}{connectionNoticeLabel(notice, trying)}
    </span>
  );
}

/** Above the chat list once reconnecting has gone on too long: what is wrong, where, and a way to try again. */
export function ConnectionProblemCard({ notice, place, trying, onRetry }: { notice: ConnectionNotice; place: LivePlace; trying: boolean; onRetry(): void }) {
  const reduced = useReducedMotion();
  const show = isConnectionProblem(notice);
  const copy = show ? problemCopy(notice, place) : null;
  return (
    <AnimatePresence initial={false}>
      {copy && (
        <motion.div
          key="problem"
          role="alert"
          data-testid="mobile-connection-problem"
          initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
          animate={reduced ? { opacity: 1 } : { opacity: 1, height: "auto" }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
          transition={{ ...spring.settle, opacity: { duration: 0.18 } }}
          className="overflow-hidden"
        >
          <div className="mx-3 mb-3 flex items-start gap-3 rounded-[20px] bg-ink/[0.05] px-4 py-4">
            <PixelArt name={place.kind === "cloud" ? "cloud" : "computer"} size={44} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-[16px] font-semibold leading-[22px] text-ink">{copy.title}</p>
              <p className="mt-0.5 text-[14px] leading-[20px] text-ink-secondary">{copy.body}</p>
              <button type="button" disabled={trying} onClick={onRetry} className="mobile-press mt-3 inline-flex h-10 items-center gap-2 rounded-full bg-ink px-4 text-[14px] font-semibold text-app disabled:opacity-70">
                {trying ? <WorkingDots size={3} /> : <RotateCcw size={15} aria-hidden />}{t(trying ? "mobile.connection.trying" : "mobile.home.retry")}
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
