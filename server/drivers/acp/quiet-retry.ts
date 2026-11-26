import type { AcpTurn } from "./turn-state.ts";

/** Nothing of the turn reached the person and nothing ran: no reply, step, tool, question, background wait or stop. */
export function untouchedTurn(current: AcpTurn, asks: ReadonlyMap<string, unknown>, closing: boolean): boolean {
  const { state } = current;
  return !state.settled && !state.cancelling && !state.stopped && !closing && !state.text.trim() && !state.repliedText
    && !state.producedItem && !current.runningTools.size && !asks.size && !current.backgroundWait;
}

/** The turns already run once more, so a second failure shows; bounded, since a turn id is never reused. */
export class QuietRetries {
  readonly #turns = new Set<string>();

  take(turnId: string): boolean {
    if (this.#turns.has(turnId)) return false;
    if (this.#turns.size >= 1_000) this.#turns.clear();
    this.#turns.add(turnId);
    return true;
  }
}
