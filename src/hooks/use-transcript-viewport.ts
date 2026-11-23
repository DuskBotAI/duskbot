import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DependencyList,
  type PointerEvent,
  type TouchEvent,
  type WheelEvent,
} from "react";
import { BOTTOM_FOLLOW_THRESHOLD, shouldResumeBottomFollow, useBottomFollowResize } from "@/lib/bottom-follow";
import { useFocusMessage } from "@/lib/focus-message";
import {
  PAGE_SHARE,
  PHONE_TRANSCRIPT_WINDOW_SIZE,
  TRANSCRIPT_WINDOW_SIZE,
  boundedWindow,
  expandWindowStart,
  focusWindowRange,
  followWindowStart,
  laterWindow,
  olderPageWindow,
  resolveTranscriptWindow,
  tailWindowStart,
} from "@/lib/transcript-window";
import { reducedMotion } from "@/lib/onboarding";
import { useArrivalFlow } from "@/hooks/use-arrival-flow";
import { useStore } from "@/state/store";
import { phoneApp } from "@/lib/store-app";

export const AUTO_EXPAND_TOP_THRESHOLD = 250;

/** A row's drawn box: a `display: contents` row has none of its own, so its first drawn descendant stands for it. */
function rowBox(row: Element): DOMRect | null {
  for (let node: Element | null = row, depth = 0; node && depth < 4; node = node.firstElementChild, depth++) {
    const box = node.getBoundingClientRect();
    if (box.height > 0 || box.width > 0) return box;
  }
  return null;
}

type ScrollAnchor = { key: string; height: number; id?: string; top?: number; edge: "top" | "bottom" };

/** The first (or last, when paging forward) row on screen and where it sits, so a page of rows mounted or let go above
 * or below keeps it in place. */
function scrollAnchor(el: HTMLElement, key: string, edge: "top" | "bottom" = "top"): ScrollAnchor {
  const anchor: ScrollAnchor = { key, height: el.scrollHeight, edge };
  if (typeof el.querySelectorAll !== "function") return anchor;
  const rect = el.getBoundingClientRect();
  const rows = el.querySelectorAll<HTMLElement>("[data-mid]");
  if (edge === "bottom") {
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!;
      const box = rowBox(row);
      if (!box || box.top >= rect.bottom) continue;
      return { ...anchor, id: row.dataset.mid, top: box.top };
    }
    return anchor;
  }
  for (const row of rows) {
    const box = rowBox(row);
    if (!box || box.bottom <= rect.top) continue;
    return { ...anchor, id: row.dataset.mid, top: box.top };
  }
  return anchor;
}

function anchorShift(el: HTMLElement, anchor: ScrollAnchor): number {
  const row = anchor.id && anchor.top !== undefined ? el.querySelector(`[data-mid=${JSON.stringify(anchor.id)}]`) : null;
  const box = row && rowBox(row);
  if (box) return box.top - anchor.top!;
  // If a forward page dropped the only visible anchor row, stay put rather than slamming scrollTop to 0.
  return anchor.edge === "bottom" ? 0 : el.scrollHeight - anchor.height;
}

const WIDGETS_WITH_OWN_ARROW_KEYS = '[role="menu"], [role="menubar"], [role="listbox"], [role="tree"], [role="grid"], [role="tablist"], [role="radiogroup"], [role="slider"], select, [contenteditable="true"]';

export function useTranscriptViewport<T extends { id: string; role?: string }>({
  ownerId,
  threadId,
  messages,
  pinOn,
  transcriptShown = true,
  hasMore = false,
  latestVisibleIndex,
  isVisible,
}: {
  ownerId: string;
  threadId: string;
  messages: readonly T[];
  pinOn: DependencyList;
  transcriptShown?: boolean;
  hasMore?: boolean;
  latestVisibleIndex?: number;
  /** When set, windowing counts and pages over visible rows while keeping the contiguous raw slice mounted. */
  isVisible?: (message: T) => boolean;
}) {
  const { state, dispatch } = useStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  // wraps the transcript column: it clips the column while arrivals move it, so the scroll range never includes them
  const clipRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);

  // Follow breaks only on an upward user gesture: content growth flickers "at bottom" false for a frame.
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  const previousScrollTop = useRef(0);
  const touchY = useRef(0);

  const visibleIndices = useMemo(() => {
    if (!isVisible) return null;
    const indices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (isVisible(messages[i]!)) indices.push(i);
    }
    return indices;
  }, [messages, isVisible]);
  const viewportMessages = useMemo(
    () => (visibleIndices ? visibleIndices.map((index) => messages[index]!) : messages),
    [messages, visibleIndices],
  );

  const transcriptKey = `${ownerId}:${threadId}`;
  const windowSize = phoneApp() ? PHONE_TRANSCRIPT_WINDOW_SIZE : TRANSCRIPT_WINDOW_SIZE;
  const mountedRows = windowSize;
  const pageRows = windowSize * PAGE_SHARE;
  const tailStart = Math.min(
    tailWindowStart(viewportMessages.length, windowSize),
    latestVisibleIndex !== undefined && !visibleIndices ? latestVisibleIndex : Infinity,
  );
  const [transcriptWindow, setTranscriptWindow] = useState<{
    key: string;
    start: number;
    end: number | null;
  }>(() => ({
    key: transcriptKey,
    start: tailStart,
    end: null,
  }));
  const switched = transcriptWindow.key !== transcriptKey;
  const olderFrom = useRef<string | null>(null);
  const landed = olderFrom.current !== null && viewportMessages[0]?.id !== olderFrom.current
    ? viewportMessages.findIndex((message) => message.id === olderFrom.current)
    : -1;
  if (landed >= 0) olderFrom.current = null;
  const next = switched
    ? { start: tailStart, end: null }
    : follow && transcriptWindow.end === null
      ? { start: Math.min(tailStart, followWindowStart(viewportMessages, transcriptWindow.start, windowSize)), end: null }
      : landed > 0 ? olderPageWindow(transcriptWindow, landed, viewportMessages.length, pageRows, mountedRows) : transcriptWindow;
  if (switched || next.start !== transcriptWindow.start || next.end !== transcriptWindow.end) {
    setTranscriptWindow({ key: transcriptKey, ...next });
  }
  const {
    visible: visibleWindow,
    hiddenCount,
    laterCount,
    startIndex,
    endIndex,
  } = useMemo(
    () => resolveTranscriptWindow(viewportMessages, transcriptWindow.start, windowSize, transcriptWindow.end),
    [viewportMessages, transcriptWindow.start, transcriptWindow.end, windowSize],
  );
  const windowedMessages = useMemo(() => {
    if (!visibleIndices) return visibleWindow;
    if (visibleIndices.length === 0) return messages as T[];
    if (startIndex >= endIndex) return [];
    const rawStart = startIndex === 0 ? 0 : visibleIndices[startIndex - 1]! + 1;
    const rawEnd = endIndex >= visibleIndices.length ? messages.length : visibleIndices[endIndex - 1]! + 1;
    return messages.slice(rawStart, rawEnd);
  }, [messages, visibleIndices, visibleWindow, startIndex, endIndex]);
  // an observer's or a stale handler's page step reads the window as it is now, not as it was when it was made
  const shownWindow = useRef({ start: startIndex, end: endIndex, total: viewportMessages.length });
  shownWindow.current = { start: startIndex, end: endIndex, total: viewportMessages.length };

  const setBottomFollow = useCallback((next: boolean) => {
    followRef.current = next;
    setFollow(next);
  }, []);
  const holdAtReply = useCallback(() => setBottomFollow(false), [setBottomFollow]);
  useBottomFollowResize(scrollRef, transcriptRef, followRef, transcriptShown ? transcriptKey : null, holdAtReply);

  useEffect(() => setBottomFollow(true), [transcriptKey, setBottomFollow]);

  const appliedFocus = useRef<number | null>(null);
  useEffect(() => {
    const focus = state.focusMessage;
    if (!focus || focus.consumed || focus.threadId !== threadId || appliedFocus.current === focus.nonce) return;
    let targetIndex = viewportMessages.findIndex((message) => message.id === focus.messageId);
    if (targetIndex < 0 && visibleIndices && visibleIndices.length > 0) {
      const rawIndex = messages.findIndex((message) => message.id === focus.messageId);
      if (rawIndex >= 0) {
        const nextVisible = visibleIndices.findIndex((index) => index >= rawIndex);
        targetIndex = nextVisible >= 0 ? nextVisible : visibleIndices.length - 1;
      }
    }
    if (targetIndex < 0) return;
    appliedFocus.current = focus.nonce;
    const range = focusWindowRange(viewportMessages.length, targetIndex, windowSize);
    setBottomFollow(false);
    setTranscriptWindow({ key: transcriptKey, start: range.start, end: range.end });
  }, [threadId, messages, viewportMessages, visibleIndices, setBottomFollow, state.focusMessage, transcriptKey, windowSize]);
  useFocusMessage(threadId, messages.length > 0);

  // Shift scrollTop by the growth after commit (scroll anchoring is off here); a switch drops the capture.
  const preExpandHeight = useRef<ScrollAnchor | null>(null);
  const expandingRef = useRef(false);
  // After paging forward, hold off automatic earlier-paging until the reader actually scrolls up again.
  const suppressEarlierRef = useRef(false);
  const settleSeqRef = useRef(0);

  const holdRowForPrepend = (edge: "top" | "bottom" = "top") => {
    preExpandHeight.current = scrollRef.current ? scrollAnchor(scrollRef.current, transcriptKey, edge) : null;
    setBottomFollow(false);
  };
  const oldestId = viewportMessages[0]?.id;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const captured = preExpandHeight.current;
    if (!captured || !el) {
      expandingRef.current = false;
      return;
    }
    preExpandHeight.current = null;
    if (captured.key !== transcriptKey) {
      expandingRef.current = false;
      suppressEarlierRef.current = false;
      return;
    }
    el.scrollTop += anchorShift(el, captured);
    previousScrollTop.current = el.scrollTop;
    expandingRef.current = false;
    if (captured.edge === "bottom") {
      suppressEarlierRef.current = true;
      const seq = ++settleSeqRef.current;
      requestAnimationFrame(() => {
        if (settleSeqRef.current === seq) settleSeqRef.current = 0;
      });
    }
  }, [transcriptWindow.start, transcriptWindow.end, oldestId, transcriptKey]);

  // `follow` is omitted on purpose: re-arming only arms future content and never scrolls. Before paint, so an opened
  // chat's first frame is already at its newest row; a switch re-arms following here rather than a frame later.
  useLayoutEffect(() => {
    // the newest row seen is recorded after paint, so here it still names the thread that was open before
    if (seenNewest.current.key !== transcriptKey) {
      setBottomFollow(true);
      suppressEarlierRef.current = false;
    }
    const el = scrollRef.current;
    // a search jump into this thread places the transcript itself
    const focus = state.focusMessage;
    if (!el || !followRef.current || (focus && !focus.consumed && focus.threadId === threadId && appliedFocus.current !== focus.nonce)) return;
    el.scrollTo({ top: el.scrollHeight });
    previousScrollTop.current = el.scrollTop;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pinOn is the caller's dependency list
  }, [transcriptKey, messages.length, ...pinOn]);

  const pageTo = (next: { start: number; end: number | null }, edge: "top" | "bottom" = "top") => {
    const { start, end, total } = shownWindow.current;
    if (next.start === start && (next.end ?? total) === end) {
      expandingRef.current = false;
      return;
    }
    if (edge === "bottom") suppressEarlierRef.current = true;
    holdRowForPrepend(edge);
    setTranscriptWindow((w) => ({ ...w, ...next }));
  };
  const pageEarlier = () => {
    const { start, end, total } = shownWindow.current;
    pageTo(boundedWindow({ start: expandWindowStart(start, pageRows), end: end >= total ? null : end }, total, mountedRows), "top");
  };
  const pageLater = () => {
    const { start, end, total } = shownWindow.current;
    pageTo(laterWindow({ start, end }, total, pageRows, mountedRows), "bottom");
  };
  const showEarlier = pageEarlier;
  const showLater = pageLater;
  const olderPending = Boolean(state.loadingOlder[threadId]);
  const loadOlder = () => {
    holdRowForPrepend("top");
    olderFrom.current = viewportMessages[0]?.id ?? null;
    dispatch({ type: "loadOlderMessages", threadId });
  };

  useEffect(() => {
    if (!olderPending) expandingRef.current = false;
  }, [olderPending]);

  const triggerAutoEarlier = useCallback(() => {
    if (expandingRef.current) return;
    if (hiddenCount > 0) {
      expandingRef.current = true;
      pageEarlier();
    } else if (hasMore && !olderPending) {
      expandingRef.current = true;
      loadOlder();
    }
  }, [hiddenCount, startIndex, hasMore, olderPending, threadId, dispatch, transcriptKey, viewportMessages, pageRows, mountedRows]);

  const triggerAutoLater = () => {
    if (expandingRef.current || laterCount === 0) return;
    expandingRef.current = true;
    pageLater();
  };
  const nearWindowEnd = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight <= AUTO_EXPAND_TOP_THRESHOLD;

  useEffect(() => {
    const sentinel = topSentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting && !followRef.current && !suppressEarlierRef.current) {
          triggerAutoEarlier();
        }
      },
      { root, rootMargin: "250px 0px 0px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [triggerAutoEarlier]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
      const ownKeys = typeof (e.target as Element | null)?.closest === "function" &&
        Boolean((e.target as Element).closest(WIDGETS_WITH_OWN_ARROW_KEYS));
      if (ownKeys || !canScroll()) return;
      if (e.key === "PageUp" || ((e.key === "Home" || e.key === "ArrowUp") && !typing)) {
        suppressEarlierRef.current = false;
        setBottomFollow(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setBottomFollow]);

  const canScroll = () => {
    const el = scrollRef.current;
    return Boolean(el && el.scrollHeight - el.clientHeight >= 1);
  };
  // Rows that draw nothing (hidden tool steps) can leave a window too short to scroll while earlier ones exist.
  const canScrollUp = () => canScroll() || hiddenCount > 0 || Boolean(hasMore);
  const atEnd = () => {
    const el = scrollRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_FOLLOW_THRESHOLD;
  };
  const jumpSeqRef = useRef(0);
  const jumpToLatest = () => {
    const seq = ++jumpSeqRef.current;
    suppressEarlierRef.current = false;
    setBottomFollow(true);
    setTranscriptWindow({ key: transcriptKey, start: tailStart, end: null });
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (!el) {
        if (jumpSeqRef.current === seq) jumpSeqRef.current = 0;
        return;
      }
      const smooth = !reducedMotion();
      // from far up the list cuts to one screen above the end and eases the rest, so it never scrolls through everything
      // in between
      const end = el.scrollHeight - el.clientHeight;
      if (smooth && end - el.scrollTop > el.clientHeight) el.scrollTop = end - el.clientHeight;
      previousScrollTop.current = el.scrollTop;
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
      if (jumpSeqRef.current === seq) jumpSeqRef.current = 0;
    });
  };

  // the person's own new message brings the transcript back to the latest, however far up or windowed it was
  const newest = messages.at(-1);
  const seenNewest = useRef({ key: transcriptKey, id: newest?.id });
  const latestJump = useRef(jumpToLatest);
  latestJump.current = jumpToLatest;
  const windowed = transcriptWindow.end !== null;
  useEffect(() => {
    const seen = seenNewest.current;
    seenNewest.current = { key: transcriptKey, id: newest?.id };
    if (seen.key !== transcriptKey || seen.id === newest?.id || newest?.role !== "user") return;
    if (!followRef.current || windowed) latestJump.current();
  }, [transcriptKey, newest?.id, newest?.role, windowed]);

  const scrollHandlers = {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      // Grabbing the scrollbar is a scroll gesture: its lane lies past clientWidth.
      const el = scrollRef.current;
      if (el && e.target === el && e.nativeEvent.offsetX >= el.clientWidth) setBottomFollow(false);
    },
    onWheel: (e: WheelEvent<HTMLDivElement>) => {
      if (e.deltaY < 0 && canScrollUp()) {
        suppressEarlierRef.current = false;
        setBottomFollow(false);
        const el = scrollRef.current;
        if (el && el.scrollTop <= AUTO_EXPAND_TOP_THRESHOLD) {
          triggerAutoEarlier();
        }
      } else if (laterCount > 0) {
        const el = scrollRef.current;
        if (e.deltaY > 0 && el && nearWindowEnd(el)) triggerAutoLater();
      } else if (atEnd()) {
        setBottomFollow(true);
      }
    },
    onTouchStart: (e: TouchEvent<HTMLDivElement>) => {
      touchY.current = e.touches[0]?.clientY ?? 0;
    },
    onTouchMove: (e: TouchEvent<HTMLDivElement>) => {
      const y = e.touches[0]?.clientY ?? 0;
      if (y > touchY.current + 4 && canScrollUp()) {
        suppressEarlierRef.current = false;
        setBottomFollow(false);
        const el = scrollRef.current;
        if (el && el.scrollTop <= AUTO_EXPAND_TOP_THRESHOLD) {
          triggerAutoEarlier();
        }
      } else if (laterCount > 0 && y < touchY.current - 4) {
        const el = scrollRef.current;
        if (el && nearWindowEnd(el)) triggerAutoLater();
      } else if (laterCount === 0 && atEnd()) {
        setBottomFollow(true);
      }
    },
    onScroll: () => {
      const el = scrollRef.current;
      if (!el) return;
      const scrollTop = el.scrollTop;
      const previousTop = previousScrollTop.current;
      const resume = laterCount === 0 && shouldResumeBottomFollow({
        following: followRef.current,
        previousScrollTop: previousScrollTop.current,
        scrollTop,
        distanceFromBottom: el.scrollHeight - scrollTop - el.clientHeight,
      });
      previousScrollTop.current = scrollTop;
      if (scrollTop > AUTO_EXPAND_TOP_THRESHOLD && settleSeqRef.current === 0) suppressEarlierRef.current = false;
      // a jump up by more than a screen with no finger or wheel on the list: iOS's tap on the status bar, VoiceOver
      if (jumpSeqRef.current === 0 && followRef.current && scrollTop < previousTop && el.scrollHeight - scrollTop - el.clientHeight > el.clientHeight) setBottomFollow(false);
      if (resume) {
        setBottomFollow(true);
      } else if (!followRef.current && settleSeqRef.current === 0 && scrollTop < previousTop && scrollTop <= AUTO_EXPAND_TOP_THRESHOLD) {
        suppressEarlierRef.current = false;
        triggerAutoEarlier();
      } else if (laterCount > 0 && scrollTop > previousTop && nearWindowEnd(el)) {
        triggerAutoLater();
      }
    },
  };

  useArrivalFlow({ scrollRef, clipRef, columnRef: transcriptRef, transcriptKey, following: follow, onHold: holdAtReply });

  return {
    scrollRef,
    clipRef,
    transcriptRef,
    topSentinelRef,
    transcriptKey,
    following: follow,
    windowedMessages,
    hiddenCount,
    laterCount,
    olderPending,
    hasEarlier: hiddenCount > 0 || Boolean(hasMore),
    showEarlier,
    showLater,
    loadOlder,
    jumpToLatest,
    scrollHandlers,
  };
}
