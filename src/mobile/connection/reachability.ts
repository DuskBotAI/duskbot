import { asleepAnswer, goneAnswer, wakingAnswer } from "@/lib/cloud-power";

type Listener = (at: number) => void;
const listeners = new Set<Listener>();
let answeredAt: number | null = null;

/** An answer from the place itself: anything under 500, and not the edge saying a cloud sleeps or is waking. */
export function placeAnswered(response: Pick<Response, "status" | "headers">): boolean {
  return response.status > 0 && response.status < 500 && !asleepAnswer(response) && !wakingAnswer(response) && !goneAnswer(response);
}

/** every screen that shows the connection re-renders on this, so a burst of answers moves it once a second */
const STEP_MS = 1_000;

/** The linked place answered a request: it is reachable, whatever its live stream is doing. */
export function noteWorkspaceAnswer(at = Date.now()): void {
  if (answeredAt !== null && at >= answeredAt && at - answeredAt < STEP_MS) return;
  answeredAt = at;
  for (const listener of listeners) listener(at);
}

export function workspaceAnsweredAt(): number | null {
  return answeredAt;
}

export function onWorkspaceAnswer(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** a different place (or none) is linked now: what the last one said is not about it */
export function forgetWorkspaceAnswers(): void {
  answeredAt = null;
}
