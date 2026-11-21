import { useEffect, useMemo, useRef } from "react";
import { flushSystemControls, wakeSystemControls } from "@/lib/system-control";
import { frames, sheetStep, sheetsUp } from "./chrome";
import type { MobileChrome } from "./platform";

let nextTokenId = 0;
function createPushToken(): string {
  nextTokenId += 1;
  return `push-${nextTokenId}`;
}

/** The page repaints where it now stands and its system controls land there, before the system's cover comes off. */
async function repainted(): Promise<void> {
  await frames(1);
  await flushSystemControls();
  await frames(1);
}

const popHandlers = new Map<string, () => void>();
const watchedChromes = new WeakSet<MobileChrome>();

function registerNativePop(chrome: MobileChrome, token: string, onPop: () => void): () => void {
  if (!watchedChromes.has(chrome) && chrome.onPagePopped) {
    watchedChromes.add(chrome);
    chrome.onPagePopped((tokens) => {
      let handled = false;
      for (const id of tokens) {
        const handler = popHandlers.get(id);
        if (handler) {
          popHandlers.delete(id);
          handled = true;
          handler();
        }
      }
      if (!handled) return;
      void repainted().then(() => chrome.finishPop?.());
    });
  }
  popHandlers.set(token, onPop);
  return () => { popHandlers.delete(token); };
}

/** A page the system pushed inside its sheet. `forget` stops hearing the system pop it. */
export interface PushedPage {
  token: string;
  forget: () => void;
}

export interface NativePushSteps {
  /** False once whoever asked for the page is gone: the push is given up. */
  live(): boolean;
  /** Draws the page, under the system's picture of the one it leaves. `pushed` is null where the system refused the
   * push: the page just appears. */
  show(pushed: PushedPage | null): void;
  /** Takes the page back down: its owner went away ("gone"), or the system did not slide it in ("uncommitted"). */
  withdraw(pushed: PushedPage, why: "gone" | "uncommitted"): void;
  /** The system popped the page: its back button or the edge swipe. */
  popped(pushed: PushedPage): void;
}

/** Pushes a page the system's way: the system covers the sheet with a picture of it, the page draws itself underneath,
 * and the system slides it in. Run inside `sheetStep`. */
export async function pushNativePage(chrome: MobileChrome, steps: NativePushSteps): Promise<"pushed" | "shown" | "withdrawn"> {
  if (!steps.live()) return "withdrawn";
  const ok = await chrome.beginPush!();
  if (!steps.live()) {
    if (ok) await chrome.cancelPush?.();
    return "withdrawn";
  }
  if (!ok) {
    steps.show(null);
    await frames(1);
    await flushSystemControls();
    return "shown";
  }
  const token = createPushToken();
  const pushed: PushedPage = { token, forget: registerNativePop(chrome, token, () => steps.popped(pushed)) };
  steps.show(pushed);
  await frames(1);
  await flushSystemControls();
  await frames(2);
  if (!steps.live()) {
    pushed.forget();
    steps.withdraw(pushed, "gone");
    await chrome.cancelPush?.();
    return "withdrawn";
  }
  if (await chrome.commitPush!(token)) return "pushed";
  pushed.forget();
  steps.withdraw(pushed, "uncommitted");
  return "withdrawn";
}

/** Slides a pushed page back out; `hide` takes it off the page once the system has it covered. Run inside `sheetStep`. */
export async function popNativePage(chrome: MobileChrome, token: string, hide: () => void): Promise<void> {
  const popped = await chrome.popPage!(token);
  hide();
  await repainted();
  if (popped) await chrome.finishPop?.();
}

/** Takes a pushed page, and any over it, off the system's stack without a slide: its owner went away. */
export function dropNativePage(chrome: MobileChrome, token: string): void {
  if (!sheetsUp.system) return;
  sheetStep(async () => {
    await chrome.popPage?.(token, { animated: false });
    wakeSystemControls();
  });
}

export interface NativeTrail<T> {
  /** Pushes a page that carries `item()`, read when its turn comes. `show` draws it, with the trail as it then stands,
   * or with null where the system refused the push and the page just appears. False where the device pushes no pages. */
  push(item: () => T, show: (item: T, trail: T[] | null) => void): boolean;
  /** Pops the top page. False when the system pushed none. */
  back(): boolean;
  /** Takes every pushed page down at once, without a slide. */
  clear(): void;
}

/** Pages pushed the system's way inside its sheet, each carrying one item of the caller's. `onPopped` hears the items
 * that came off (lowest first) and those left, whoever took them off: `back`, the system's back button or edge swipe,
 * or a push the system did not finish. */
export function useNativeTrail<T>(chrome: MobileChrome | null, onPopped: (removed: T[], left: T[]) => void): NativeTrail<T> {
  const entries = useRef<Array<{ item: T; pushed: PushedPage }>>([]);
  const mounted = useRef(true);
  const latestPopped = useRef(onPopped);
  latestPopped.current = onPopped;
  const native = chrome?.beginPush && chrome.commitPush && chrome.popPage ? chrome : null;

  const trail = useMemo<NativeTrail<T>>(() => {
    const items = () => entries.current.map((entry) => entry.item);
    const takeFrom = (pushed: PushedPage): T[] => {
      const at = entries.current.findIndex((entry) => entry.pushed === pushed);
      if (at < 0) return [];
      const removed = entries.current.splice(at);
      for (const entry of removed) entry.pushed.forget();
      return removed.map((entry) => entry.item);
    };
    const report = (removed: T[]) => {
      if (removed.length > 0 && mounted.current) latestPopped.current(removed, items());
    };
    return {
      push(item, show) {
        if (!native) return false;
        sheetStep(async () => {
          await pushNativePage(native, {
            live: () => mounted.current,
            show: (pushed) => {
              const carried = item();
              if (pushed) entries.current.push({ item: carried, pushed });
              show(carried, pushed ? items() : null);
            },
            withdraw: (pushed, why) => {
              const removed = takeFrom(pushed);
              if (why === "uncommitted") report(removed);
            },
            popped: (pushed) => report(takeFrom(pushed)),
          });
        });
        return true;
      },
      back() {
        if (!native) return false;
        const top = entries.current.pop();
        if (!top) return false;
        top.pushed.forget();
        sheetStep(() => popNativePage(native, top.pushed.token, () => report([top.item])));
        return true;
      },
      clear() {
        const remaining = entries.current.splice(0);
        for (const entry of remaining) entry.pushed.forget();
        if (native && remaining[0]) dropNativePage(native, remaining[0].pushed.token);
      },
    };
  }, [native]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      trail.clear();
    };
  }, [trail]);

  return trail;
}
