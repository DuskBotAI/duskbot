// "Move from Grok Bot" (docs/grok-bot-move.md): one flow behind every entry point, in three screens on one sheet of a
// fixed height, so nothing jumps between them: what was found, the move on its way, and what came and what is left.
import { AnimatePresence } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/cn";
import { copyText } from "@/lib/copy-text";
import { acceptLine, grokMoveApi, grokMoveChanged, looksLikeGrokExport, openInGrokBot, useGrokMoveRequests, type GrokMoveClient, type GrokMoveOpen } from "@/lib/grok-bot-move";
import { t } from "@/lib/i18n";
import { friendlyError } from "@/lib/plain-error";
import { useStore } from "@/state/store";
import type { GrokDetection, GrokMoveProgress, GrokRequestText, GrokUndoPreview, GrokUndoResult, GrokWaitingList } from "../../../shared/grok-move";
import { Check, CircleAlert } from "../../icons";
import { GrokBotMark } from "../GrokBotMark";
import { Icon } from "../Icon";
import { confirmCancelCls, formCloseCls, formSheetCls, mdDangerCls, mdPrimaryCls, mdSecondaryCls, useDialogKeys } from "../ui/GrokDialog";
import { ScrimMotion, SheetMotion, useDialogMotion } from "../ui/SheetMotion";
import { chosen, GrokMovePreview, initialChoices, type Choices } from "./GrokMovePreview";
import { GrokMoveProgressView } from "./GrokMoveProgress";
import { GrokMoveResultView, GrokUndoView, useCopiedReset, type AskState } from "./GrokMoveResult";
import { Breath, listOf } from "./parts";

type View = "loading" | "failed" | "unavailable" | "none" | "preview" | "progress" | "result" | "undo";

const POLL_MS = 400;
const WAITING_POLL_MS = 4_000;
const live = (state: GrokMoveProgress["state"] | undefined) => state === "running" || state === "stopping";

export function GrokMoveHost({ client = grokMoveApi }: { client?: GrokMoveClient }) {
  const [session, setSession] = useState<{ key: number; open: GrokMoveOpen } | null>(null);
  useGrokMoveRequests((open) => setSession((was) => was ?? { key: Date.now(), open }));
  return <AnimatePresence>{session && <GrokMoveDialog key={session.key} client={client} open={session.open} onClose={() => setSession(null)} />}</AnimatePresence>;
}

export function GrokMoveDialog({ client, open, onClose }: { client: GrokMoveClient; open: GrokMoveOpen; onClose: () => void }) {
  const { dispatch } = useStore();
  const [view, setView] = useState<View>("loading");
  const [detection, setDetection] = useState<GrokDetection | null>(null);
  const [choices, setChoices] = useState<Choices>({});
  const [progress, setProgress] = useState<GrokMoveProgress | null>(null);
  const [waiting, setWaiting] = useState<GrokWaitingList>({ bots: [], waiting: 0 });
  const [asks, setAsks] = useState<Record<string, AskState>>({});
  const requests = useRef(new Map<string, GrokRequestText>());
  const [undo, setUndo] = useState<{ preview: GrokUndoPreview | null; result: GrokUndoResult | null }>({ preview: null, result: null });
  /** The one-consent walk through every moved bot: open each prefilled, wait for its file, then open the next. */
  const [walk, setWalk] = useState<{ order: string[]; index: number } | null>(null);
  const walkAsked = useRef(-1);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ line: string; failed: boolean } | null>(null);
  const [round, setRound] = useState(0);
  useCopiedReset(asks, setAsks);

  const fail = (error: unknown) => setSaid({ line: friendlyError(error), failed: true });
  const refreshWaiting = useCallback(() => client.waiting().then(setWaiting, () => {}), [client]);
  const refreshDetection = useCallback(() => client.detect().then(setDetection, () => {}), [client]);

  useEffect(() => {
    let alive = true;
    setView("loading");
    void (async () => {
      try {
        const [found, last, awaited] = await Promise.all([client.detect(), client.progress().catch(() => null), client.waiting().catch(() => ({ bots: [], waiting: 0 }))]);
        if (!alive) return;
        setDetection(found);
        setChoices(initialChoices(found.bots));
        setProgress(last);
        setWaiting(awaited);
        if (!found.available) setView("unavailable");
        else if (found.running || live(last?.state)) setView("progress");
        else if (last && last.state !== "undone" && (open.at === "result" || last.state === "interrupted")) setView("result");
        else if (!found.found || !found.bots.length) setView(last && last.state !== "undone" ? "result" : "none");
        else setView("preview");
      } catch (error) {
        if (alive) { fail(error); setView("failed"); }
      }
    })();
    return () => { alive = false; };
  }, [client, open.at, round]);

  useEffect(() => {
    if (view !== "progress") return;
    let alive = true;
    const timer = setInterval(() => {
      void client.progress().then((next) => {
        if (!alive || !next) return;
        setProgress(next);
        if (!live(next.state)) {
          setView("result");
          grokMoveChanged();
          void refreshDetection();
          void refreshWaiting();
        }
      }, () => {});
    }, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [client, view, refreshWaiting, refreshDetection]);

  const awaited = waiting.waiting;
  useEffect(() => {
    if (view !== "result" || !awaited) return;
    const timer = setInterval(() => void refreshWaiting(), WAITING_POLL_MS);
    return () => clearInterval(timer);
  }, [view, awaited, refreshWaiting]);
  useEffect(() => {
    const again = () => void refreshWaiting();
    window.addEventListener("dusk:grok-move-changed", again);
    return () => window.removeEventListener("dusk:grok-move-changed", again);
  }, [refreshWaiting]);

  const found = useMemo(() => new Map((detection?.bots ?? []).map((bot) => [bot.rosterId, bot])), [detection]);
  const picks = detection ? chosen(detection.bots, choices) : [];
  const updating = picks.length > 0 && picks.every((pick) => found.get(pick.rosterId)?.here);

  const start = async (bots: Array<{ rosterId: string; chat?: boolean; instructions?: boolean }>) => {
    if (!bots.length || busy) return;
    setBusy(true);
    setSaid(null);
    try {
      setProgress(await client.start(bots));
      setView("progress");
    } catch (error) {
      const running = await client.progress().catch(() => null);
      if (running && live(running.state)) { setProgress(running); setView("progress"); } else fail(error);
    } finally {
      setBusy(false);
    }
  };
  const again = (rosterIds: string[]) => void start(rosterIds.map((rosterId) => {
    const choice = choices[rosterId];
    return { rosterId, ...(choice ? { chat: choice.chat, instructions: choice.instructions } : {}) };
  }));
  const stop = async () => {
    try { setProgress(await client.stop()); } catch (error) { fail(error); }
  };

  const ask = async (rosterId: string) => {
    setSaid(null);
    try {
      const request = await client.request(rosterId);
      requests.current.set(rosterId, request);
      const opened = await openInGrokBot(request.url);
      setAsks((was) => ({ ...was, [rosterId]: { opened } }));
      await refreshWaiting();
      grokMoveChanged();
    } catch (error) {
      fail(error);
    }
  };
  const copy = async (rosterId: string) => {
    try {
      const request = requests.current.get(rosterId) ?? await client.request(rosterId);
      requests.current.set(rosterId, request);
      const copied = (await copyText(request.text)) === "copied";
      setAsks((was) => ({ ...was, [rosterId]: { opened: was[rosterId]?.opened ?? false, copied } }));
      if (!copied) setSaid({ line: t("grokBotMove.ask.copyFailed"), failed: true });
      void refreshWaiting();
    } catch (error) {
      fail(error);
    }
  };

  // The walk opens each bot in turn (ask once per index, via the ref so the effect need not depend on `ask`), waits for
  // its file to arrive or be refused, then advances. The person's only action is pressing Enter in each Grok Bot window.
  const askRef = useRef(ask);
  askRef.current = ask;
  const startWalk = (order: string[]) => {
    if (!order.length) return;
    setSaid(null);
    walkAsked.current = -1;
    setWalk({ order, index: 0 });
  };
  const stopWalk = () => { walkAsked.current = -1; setWalk(null); };
  useEffect(() => { if (view !== "result") { walkAsked.current = -1; setWalk(null); } }, [view]);
  useEffect(() => {
    if (!walk) return;
    const current = walk.order[walk.index];
    if (!current) { setWalk(null); return; }
    if (walkAsked.current !== walk.index) {
      walkAsked.current = walk.index;
      void askRef.current(current);
      return;
    }
    const entry = waiting.bots.find((one) => one.rosterId === current);
    if (entry && (entry.state === "arrived" || entry.state === "problem")) setWalk({ order: walk.order, index: walk.index + 1 });
  }, [walk, waiting]);

  const openUndo = async () => {
    if (!progress) return;
    setUndo({ preview: null, result: null });
    setView("undo");
    try { setUndo({ preview: await client.undoPreview(progress.moveId), result: null }); } catch (error) { fail(error); setView("result"); }
  };
  const confirmUndo = async () => {
    if (!progress || !undo.preview || busy) return;
    setBusy(true);
    try {
      const result = await client.undo(progress.moveId);
      setUndo({ preview: undo.preview, result });
      grokMoveChanged();
      void refreshDetection();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const takeExports = async (files: Array<{ text: string; file?: string }>) => {
    const results = await Promise.all(files.map((one) => client.accept(one).catch((error: unknown) => ({ applied: [], problems: [{ file: one.file ?? "", code: "unreadable" as const, message: friendlyError(error) }] }))));
    const merged = { applied: results.flatMap((one) => one.applied), problems: results.flatMap((one) => one.problems) };
    setSaid(acceptLine(merged, listOf));
    await refreshWaiting();
    grokMoveChanged();
  };
  const onPaste = (event: React.ClipboardEvent) => {
    const text = event.clipboardData.getData("text/plain");
    if (event.defaultPrevented || !looksLikeGrokExport(text)) return;
    event.preventDefault();
    event.stopPropagation();
    void takeExports([{ text }]);
  };
  const onDrop = (event: DragEvent) => {
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (event.defaultPrevented || !files.length) return;
    event.preventDefault();
    event.stopPropagation();
    void Promise.all(files.map(async (file) => ({ text: await file.text().catch(() => ""), file: file.name }))).then((read) => {
      const exports = read.filter((one) => looksLikeGrokExport(one.text));
      if (exports.length) void takeExports(exports);
      else setSaid({ line: t("grokBotMove.problem.notExport"), failed: true });
    });
  };

  const liveBots = detection?.bots.filter((bot) => !bot.removed) ?? [];
  const allHere = liveBots.length > 0 && liveBots.every((bot) => bot.here);
  const notHere = liveBots.filter((bot) => !bot.here).length;
  const doneCount = progress?.bots.filter((bot) => bot.state === "done").length ?? 0;

  const head: { title: string; line: string } = (() => {
    switch (view) {
      case "loading": return { title: t("grokBotMove.title"), line: t("grokBotMove.loading") };
      case "failed": return { title: t("grokBotMove.title"), line: t("grokBotMove.failed") };
      case "unavailable": return { title: t("grokBotMove.title"), line: t("grokBotMove.notDesktop") };
      case "none": return { title: t("grokBotMove.none.title"), line: t("grokBotMove.none.line") };
      case "preview": return {
        title: allHere ? t("grokBotMove.preview.allHere", { count: liveBots.length })
          : liveBots.length === 1 ? t("grokBotMove.preview.foundOne") : t("grokBotMove.preview.found", { count: liveBots.length }),
        line: t("grokBotMove.promise"),
      };
      case "progress": return { title: t("grokBotMove.progress.title"), line: t("grokBotMove.progress.line") };
      case "result": return {
        title: doneCount === 0 ? t("grokBotMove.result.titleNone") : doneCount === 1 ? t("grokBotMove.result.titleOne") : t("grokBotMove.result.title", { count: doneCount }),
        line: t("grokBotMove.result.line"),
      };
      case "undo": return undo.result
        ? { title: t("grokBotMove.undo.doneTitle"), line: t("grokBotMove.undo.doneLine") }
        : { title: t("grokBotMove.undo.title"), line: t("grokBotMove.undo.line") };
    }
  })();

  let body: ReactNode = null;
  let footer: ReactNode = null;
  const closeButton = (label = t("common.close")) => <button type="button" data-grok-close="" onClick={onClose} className={mdPrimaryCls}>{label}</button>;
  switch (view) {
    case "loading":
      body = <p role="status" className="m-0 flex items-center gap-2 px-1 text-[13px] text-ink-secondary"><Breath />{t("grokBotMove.loading")}</p>;
      break;
    case "failed":
      footer = <><button type="button" onClick={() => setRound((n) => n + 1)} className={mdSecondaryCls}>{t("grokBotMove.tryAgain")}</button>{closeButton()}</>;
      break;
    case "unavailable":
    case "none":
      footer = closeButton();
      break;
    case "preview":
      if (detection) body = <GrokMovePreview detection={detection} choices={choices} onChoices={setChoices} />;
      footer = (
        <>
          {progress && progress.state !== "undone" && (
            <button type="button" data-grok-last="" onClick={() => setView("result")} className={cn(confirmCancelCls, "me-auto")}>{t("grokBotMove.preview.lastMove")}</button>
          )}
          <button type="button" data-grok-not-now="" onClick={onClose} className={confirmCancelCls}>{t("grokBotMove.notNow")}</button>
          <button type="button" data-grok-start="" disabled={!picks.length || busy} onClick={() => void start(picks)} className={mdPrimaryCls}>
            {!picks.length ? t("grokBotMove.preview.chooseSome")
              : updating ? (picks.length === 1 ? t("grokBotMove.preview.updateOne") : t("grokBotMove.preview.update", { count: picks.length }))
                : picks.length === 1 ? t("grokBotMove.preview.moveOne") : t("grokBotMove.preview.move", { count: picks.length })}
          </button>
        </>
      );
      break;
    case "progress":
      if (progress) body = <GrokMoveProgressView progress={progress} found={found} />;
      footer = (
        <>
          <button type="button" data-grok-stop="" disabled={progress?.state !== "running"} onClick={() => void stop()} className={confirmCancelCls}>{t("grokBotMove.progress.stop")}</button>
          {closeButton()}
        </>
      );
      break;
    case "result":
      if (progress) {
        body = <GrokMoveResultView progress={progress} found={found} waiting={waiting.bots} asks={asks} actions={{ ask: (id) => void ask(id), copy: (id) => void copy(id) }}
          walk={walk} onWalkStart={startWalk} onWalkStop={stopWalk}
          onRetry={again} onRest={again} onApps={() => { onClose(); dispatch({ type: "toggleAppSettings", open: true, section: "apps" }); }} onUndo={() => void openUndo()} />;
      }
      footer = (
        <>
          {notHere > 0 && <button type="button" data-grok-more="" onClick={() => { setChoices(initialChoices(detection?.bots ?? [])); setView("preview"); }} className={cn(confirmCancelCls, "me-auto")}>{t("grokBotMove.result.moveMore")}</button>}
          {closeButton(t("grokBotMove.done"))}
        </>
      );
      break;
    case "undo":
      body = <GrokUndoView preview={undo.preview} result={undo.result} />;
      footer = undo.result ? closeButton(t("grokBotMove.done")) : (
        <>
          <button type="button" data-grok-keep="" onClick={() => setView("result")} className={confirmCancelCls}>{t("grokBotMove.undo.keep")}</button>
          <button type="button" data-grok-confirm-undo="" disabled={!undo.preview || busy} onClick={() => void confirmUndo()} className={mdDangerCls}>{t("grokBotMove.undo.confirm")}</button>
        </>
      );
      break;
  }

  return <GrokMoveSheet view={view} head={head} footer={footer} said={said} onClose={onClose} onPaste={onPaste} onDrop={onDrop}>{body}</GrokMoveSheet>;
}

function GrokMoveSheet({ view, head, footer, said, onClose, onPaste, onDrop, children }: {
  view: View;
  head: { title: string; line: string };
  footer: ReactNode;
  said: { line: string; failed: boolean } | null;
  onClose: () => void;
  onPaste: (event: React.ClipboardEvent) => void;
  onDrop: (event: DragEvent) => void;
  children: ReactNode;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const close = useDialogKeys(sheet, onClose);
  const motion = useDialogMotion();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    scroller.current?.scrollTo({ top: 0 });
    title.current?.focus({ preventScroll: true });
  }, [view]);
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" {...motion.layer}>
      <ScrimMotion aria-hidden="true" data-modal-scrim className="ui-dialog-scrim absolute inset-0" onMouseDown={() => close.current()} {...motion.scrim} />
      <SheetMotion ref={sheet} {...motion.sheet} role="dialog" aria-modal="true" aria-labelledby="grok-move-title" aria-describedby="grok-move-line" tabIndex={-1}
        data-grok-move={view} onPaste={onPaste} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}
        style={{ maxWidth: "min(560px, calc(100vw - 32px))" }} className={cn(formSheetCls, "h-[min(680px,calc(100dvh-32px))]")}>
        <header className="flex shrink-0 items-start gap-3 px-5 pb-3 pt-5">
          <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-ink/[0.05]"><GrokBotMark size={20} /></span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
            <h2 ref={title} id="grok-move-title" tabIndex={-1} data-autofocus="" className="m-0 text-pretty text-[16px] font-semibold leading-[22px] tracking-[0.01em] text-ink outline-none">{head.title}</h2>
            <p id="grok-move-line" className="m-0 text-pretty text-[13px] leading-[18px] text-ink-secondary">{head.line}</p>
          </div>
          <button type="button" aria-label={t("common.close")} onClick={() => close.current()} className={formCloseCls}><Icon name="close" size={16} /></button>
        </header>
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 pt-1 [scrollbar-width:thin]">{children}</div>
        {said && (
          <p role={said.failed ? "alert" : "status"} data-grok-said={said.failed ? "failed" : "done"}
            className={cn("m-0 mx-5 flex items-start gap-2 border-t border-ink/[0.06] pt-2.5 text-[12px] leading-4", said.failed ? "text-danger" : "text-ink")}>
            {said.failed ? <CircleAlert size={14} aria-hidden="true" className="mt-px shrink-0" /> : <Check size={14} aria-hidden="true" className="mt-px shrink-0" />}
            <span className="text-pretty">{said.line}</span>
          </p>
        )}
        {footer && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 px-5 pb-5 pt-3">{footer}</div>}
      </SheetMotion>
    </div>,
    document.body,
  );
}
