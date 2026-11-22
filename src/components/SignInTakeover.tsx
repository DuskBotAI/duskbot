import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useLiveDesktop } from "./live-desktop-module";
import { viewerTargetId } from "../../shared/desktop-viewer";
import { parseComputerHelp } from "@/lib/computer-control";
import { trailHeaders } from "@/lib/trail";
import { friendlyError } from "@/lib/plain-error";
import { t } from "@/lib/i18n";
import { phoneApp } from "@/lib/store-app";
import { api, useStore } from "@/state/store";
import { SCREEN_GROW_MS } from "./ComputerFullscreen";
import { useComputerTakeover } from "./computer-takeover";


/** A computer can sleep while its card waits for the person (idle sleep): it is woken before its screen is asked for. */
const WAKE_TIMEOUT_MS = 180_000;

/** The live desktop a sign-in card can hand over: the bot's cloud computer or its Local VM; null for anywhere else. A
 * cloud computer that went to sleep while the card waited is woken first (`onWaking` says so on the card). */
async function liveTargetFor(place: string, botId: string, threadId: string, signal: AbortSignal, onWaking: () => void): Promise<string | null> {
  const bot = encodeURIComponent(botId), thread = encodeURIComponent(threadId);
  if (place === "cloud") {
    const status = await api(`/api/bots/${bot}/computer?threadId=${thread}`, { signal });
    if (status?.ready !== true) {
      onWaking();
      await api(`/api/bots/${bot}/computer/provision?threadId=${thread}`, { method: "POST", body: "{}", signal, timeoutMs: WAKE_TIMEOUT_MS });
    }
    return `vps/${botId}`;
  }
  if (place !== "vm") return null;
  const status = await api(`/api/bots/${encodeURIComponent(botId)}/local-computer?threadId=${encodeURIComponent(threadId)}`, { signal });
  return status?.viewer_url && typeof status.target_key === "string" ? viewerTargetId({ key: status.target_key }) : null;
}

/**
 * Take over from the sign-in card itself: the card's picture becomes the bot's live desktop, control is taken the moment
 * it paints, and the full view opens over the window with input going to the bot's computer. Closing the full view
 * keeps control in the card; I'm done shrinks the view back first, then answers the card, which gives control back.
 */
export function useSignInTakeover({ botId, threadId, name, place, poster, onDone }: {
  botId: string;
  threadId: string;
  name: string;
  place: string;
  poster: string | null;
  onDone: () => Promise<void>;
}) {
  const { state, dispatch } = useStore();
  const held = state.computerControl[botId]?.held === true;
  const [target, setTarget] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [ready, setReady] = useState(false);
  const [taking, setTaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waking, setWaking] = useState(false);
  // a take the person asked for, run once the live desktop paints
  const wanted = useRef(false);
  const resolving = useRef<AbortController | null>(null);
  useEffect(() => () => resolving.current?.abort(), []);

  const request = useCallback(async (action: "take" | "release", controlLeaseId?: string, cid?: string) => {
    const snap = await api(`/api/bots/${encodeURIComponent(botId)}/computer/control`, {
      method: "POST",
      headers: { "content-type": "application/json", ...trailHeaders(cid) },
      body: JSON.stringify({ action, ...(controlLeaseId ? { controlLeaseId } : {}) }),
    });
    dispatch({ type: "computerControl", botId, held: snap?.held === true, helpReason: snap?.helpReason ?? null, help: parseComputerHelp(snap?.help) });
    return { held: snap?.held === true, owned: snap?.owned === true };
  }, [botId, dispatch]);
  const takeover = useComputerTakeover({ botId, session: `${target ?? ""}:${threadId}`, held, request, viewerClose: null });

  const take = useCallback(async () => {
    wanted.current = false;
    setTaking(true);
    setError(null);
    try { await takeover.take(true); }
    catch (cause) { setError(friendlyError(cause)); }
    finally { setTaking(false); }
  }, [takeover]);

  useEffect(() => {
    if (ready && wanted.current && !takeover.here && !taking) void take();
  }, [ready, take, takeover.here, taking]);

  /** Take over: the live desktop replaces the picture, and control follows as soon as it paints. */
  const open = async () => {
    setError(null);
    if (takeover.here) return takeover.setExpanded(true);
    wanted.current = true;
    if (target) {
      setShown(true);
      if (phoneApp()) takeover.setExpanded(true);
      if (ready) void take();
      return;
    }
    resolving.current?.abort();
    const controller = new AbortController();
    resolving.current = controller;
    setTaking(true);
    try {
      const next = await liveTargetFor(place, botId, threadId, controller.signal, () => setWaking(true));
      if (controller.signal.aborted) return;
      if (!next) throw new Error(t("computer.err.openDesktop"));
      setTarget(next);
      setShown(true);
      if (phoneApp()) takeover.setExpanded(true);
    } catch (cause) {
      if (controller.signal.aborted) return;
      wanted.current = false;
      setError(friendlyError(cause));
    } finally {
      if (!controller.signal.aborted) { setTaking(false); setWaking(false); }
    }
  };

  const [finishing, setFinishing] = useState(false);
  /** I'm done: the full view shrinks back into the card before the card answers and settles. */
  const done = async () => {
    if (finishing) return;
    setFinishing(true);
    try {
      if (takeover.expanded) {
        takeover.setExpanded(false);
        await new Promise((resolve) => setTimeout(resolve, SCREEN_GROW_MS));
      }
      await onDone();
    } finally {
      setFinishing(false);
    }
  };

  const viewerCode = useLiveDesktop(true);
  const LiveDesktop = viewerCode.kind === "ready" ? viewerCode.LiveDesktop : null;
  const unreachable = () => {
    setReady(false);
    wanted.current = false;
    if (takeover.here) takeover.leave();
    // back to the card's own picture (never a dead box), with what went wrong under it; a retry wakes it again
    setShown(false);
    setTarget(null);
    setError(friendlyError(new Error(t("computer.err.openDesktop"))));
  };
  const viewerFailed = viewerCode.kind === "failed" && shown && Boolean(target);
  useEffect(() => { if (viewerFailed) unreachable(); }, [viewerFailed]); // eslint-disable-line react-hooks/exhaustive-deps
  const bot = state.bots?.find((one) => one.id === botId);
  const media: ReactNode = shown && target ? (
    <div data-sign-in-live="" data-in-control={takeover.here ? "true" : undefined} className="relative aspect-[16/10] w-full overflow-hidden bg-[#000]">
      {LiveDesktop && (
        <LiveDesktop key={target} target={target} threadId={threadId} botId={botId} bot={bot} name={name} poster={poster}
          viewOnly={!takeover.here} taking={taking} asked originalViewer
          expanded={takeover.expanded} onExpandedChange={takeover.setExpanded} onOpenPreview={() => void open()}
          onTakeControl={() => void open()} onHandBack={() => void done()} handingBack={finishing || takeover.handingBack}
          onReadyChange={setReady}
          onUnreachable={unreachable} />
      )}
    </div>
  ) : null;

  return { open, done, media, here: takeover.here, expanded: takeover.expanded, expand: () => takeover.setExpanded(true), taking, waking, finishing, error };
}
