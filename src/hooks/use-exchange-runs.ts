import { useCallback, useMemo, useState } from "react";
import type { Message } from "@/state/store";
import { exchangeBodyShown, exchangeEntries, exchangeOpenByDefault, exchangeRuns, type ExchangeRun } from "@/lib/peer-exchange";
import { useShowPeerReplies } from "@/lib/peer-replies-preference";

export interface ExchangeRows<T> {
  /** The run each folded item belongs to. */
  runAt: ReadonlyMap<number, ExchangeRun<T>>;
  isOpen: (run: ExchangeRun<T>) => boolean;
  /** The run's rows draw under its line: it is open and the person shows bot-to-bot replies, or it draws no line. */
  bodyShown: (run: ExchangeRun<T>) => boolean;
  toggle: (run: ExchangeRun<T>) => void;
  /** A closed run ends right above this item. */
  closedAbove: (index: number) => boolean;
  /** A closed run starts right below this item. */
  closedBelow: (index: number) => boolean;
}

/** Folds a transcript's runs of bot-to-bot rows into one line each; a run opens and closes in place. */
export function useExchangeRows<T>(
  messages: readonly Message[],
  items: readonly T[],
  rowsOf: (item: T) => readonly Message[],
  transparent: (item: T) => boolean,
  threadBotId?: string,
): ExchangeRows<T> {
  const runAt = useMemo(() => {
    const at = new Map<number, ExchangeRun<T>>();
    for (const run of exchangeRuns(items, rowsOf, exchangeEntries(messages, threadBotId), transparent)) {
      for (let index = run.start; index <= run.end; index++) at.set(index, run);
    }
    return at;
  }, [messages, items, rowsOf, transparent, threadBotId]);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((run: ExchangeRun<T>) => setOpen((was) => {
    const next = new Set(was);
    if (!next.delete(run.id)) next.add(run.id);
    return next;
  }), []);
  // a toggled id flips the run from how it starts
  const isOpen = useCallback((run: ExchangeRun<T>) => open.has(run.id) !== exchangeOpenByDefault(run.summary), [open]);
  const showPeerReplies = useShowPeerReplies();
  const bodyShown = useCallback((run: ExchangeRun<T>) => exchangeBodyShown(run.summary, isOpen(run), showPeerReplies), [isOpen, showPeerReplies]);
  const closedAbove = useCallback((index: number) => {
    const run = runAt.get(index - 1);
    return run !== undefined && run.end === index - 1 && !bodyShown(run);
  }, [runAt, bodyShown]);
  const closedBelow = useCallback((index: number) => {
    const run = runAt.get(index + 1);
    return run !== undefined && run.start === index + 1 && !bodyShown(run);
  }, [runAt, bodyShown]);
  return useMemo(() => ({ runAt, isOpen, bodyShown, toggle, closedAbove, closedBelow }), [runAt, isOpen, bodyShown, toggle, closedAbove, closedBelow]);
}
