/** How long the native side has to say its composer is on screen before the page keeps its own. */
export const COMPOSER_ACK_MS = 400;

export type ComposerAck = { shown: boolean; reason?: string };

/** Who draws the chat's composer: the page hides its own only once the native side has said its composer is on screen,
 * and takes it back when the native side says it could not draw one or stays silent too long. One of the two always
 * shows, never both. */
export function composerHandoff(now: () => number = () => performance.now()) {
  let wanted = false;
  let askedAt = 0;
  let confirmed = false;
  let refused: string | null = null;
  return {
    /** the page has a composer for the native side to draw (true), or none (false) */
    want(next: boolean): void {
      if (next === wanted) return;
      wanted = next;
      confirmed = false;
      refused = null;
      askedAt = now();
    },
    ack(answer: ComposerAck): void {
      if (!wanted || refused) return;
      if (answer.shown) confirmed = true;
      else { confirmed = false; refused = answer.reason ?? "not drawn"; }
    },
    /** back in front: whatever was decided is asked again */
    recheck(): void {
      confirmed = false;
      refused = null;
      askedAt = now();
    },
    /** the native side is asked to draw the composer */
    native(): boolean {
      if (!wanted || refused) return false;
      if (!confirmed && now() - askedAt > COMPOSER_ACK_MS) refused = "no answer";
      return !refused;
    },
    /** the page's own composer is hidden */
    pageHidden(): boolean {
      return wanted && confirmed && !refused;
    },
    /** waiting on the native side's answer */
    pending(): boolean {
      return wanted && !confirmed && !refused;
    },
    /** why the page kept its composer, if it did */
    refusal(): string | null {
      return refused;
    },
  };
}
