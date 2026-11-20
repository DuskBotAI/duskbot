import { useEffect, useSyncExternalStore } from "react";

type Availability = boolean | null;

const UNANSWERED_RETRY_MS = 5_000;

let current: Availability = null;
let asking: Promise<void> | null = null;
let place = 0;
let retry: ReturnType<typeof setTimeout> | undefined;
const watchers = new Set<() => void>();

function pageCanCall(): boolean {
  return typeof navigator !== "undefined"
    && typeof navigator.mediaDevices?.getUserMedia === "function"
    && typeof globalThis.AudioContext === "function";
}

async function placeAnswer(): Promise<boolean | null> {
  try {
    const res = await fetch("/api/voice/local");
    if (!res.ok) return null;
    const body: { available?: boolean } = await res.json();
    return body.available === true;
  } catch {
    return null;
  }
}

function ask(): void {
  if (current !== null || asking) return;
  if (!pageCanCall()) {
    current = false;
    return;
  }
  const askedOf = place;
  asking = placeAnswer().then((answer) => {
    if (askedOf !== place) return;
    asking = null;
    if (answer === null) {
      clearTimeout(retry);
      if (watchers.size > 0) retry = setTimeout(ask, UNANSWERED_RETRY_MS);
      return;
    }
    current = answer;
    for (const fn of Array.from(watchers)) fn();
  });
}

/** Whether a voice call with the built-in voice can run here: null until the server has answered. */
export function useLocalVoiceCall(): Availability {
  useEffect(ask, []);
  return useSyncExternalStore(
    (fn) => {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    () => current,
    () => current,
  );
}

export function localVoiceCallKnown(): Availability {
  return current;
}

/** The app now talks to another place (a phone switching computer or cloud): that place's answer is asked for afresh. */
export function forgetLocalVoiceCall(): void {
  place += 1;
  asking = null;
  clearTimeout(retry);
  const known = current !== null;
  current = null;
  if (known) for (const fn of Array.from(watchers)) fn();
  if (watchers.size > 0) ask();
}

/** The runtime turned out not to load here: calls go back to Take turns. */
export function markLocalVoiceUnavailable(): void {
  if (current === false) return;
  current = false;
  for (const fn of Array.from(watchers)) fn();
}
