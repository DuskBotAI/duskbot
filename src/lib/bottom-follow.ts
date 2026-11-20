import { useLayoutEffect, useRef, type RefObject } from "react";
import { contentTop, growingReply, readingInset, replyHoldTop } from "./reply-hold";

export const BOTTOM_FOLLOW_THRESHOLD = 4;

export function shouldResumeBottomFollow({
  following,
  previousScrollTop,
  scrollTop,
  distanceFromBottom,
}: {
  following: boolean;
  previousScrollTop: number;
  scrollTop: number;
  distanceFromBottom: number;
}): boolean {
  return !following && scrollTop > previousScrollTop && distanceFromBottom < BOTTOM_FOLLOW_THRESHOLD;
}

interface BottomFollowScroller {
  scrollHeight: number;
  scrollTo(options?: ScrollToOptions): void;
}

export function followBottomGrowth(scroller: BottomFollowScroller, following: boolean): boolean {
  if (!following) return false;
  scroller.scrollTo({ top: scroller.scrollHeight });
  return true;
}

/** Where a reply growing past the view stops the follow, or null to follow to the end. */
export function growthHold(scroller: HTMLElement, transcript: HTMLElement): number | null {
  const reply = growingReply(transcript);
  if (!reply) return null;
  return replyHoldTop({ replyTop: contentTop(scroller, reply), inset: readingInset(scroller), end: scroller.scrollHeight - scroller.clientHeight, current: scroller.scrollTop });
}

export function useBottomFollowResize(
  scrollRef: RefObject<HTMLElement | null>,
  transcriptRef: RefObject<HTMLElement | null>,
  followingRef: RefObject<boolean>,
  observeKey: string | null,
  onHold?: () => void,
): void {
  const hold = useRef(onHold);
  hold.current = onHold;
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const transcript = transcriptRef.current;
    if (!scroller || !transcript || observeKey === null) return;

    const observer = new ResizeObserver(() => {
      const top = followingRef.current ? growthHold(scroller, transcript) : null;
      if (top === null) { followBottomGrowth(scroller, followingRef.current); return; }
      scroller.scrollTop = top;
      hold.current?.();
    });
    observer.observe(transcript);
    return () => observer.disconnect();
  }, [followingRef, observeKey, scrollRef, transcriptRef]);
}
