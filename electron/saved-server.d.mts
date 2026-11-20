export declare const SERVER_LOOK_MS: number;
export declare const TUNNEL_GRACE_MS: number;
export declare function tunnelOrigin(origin: string): boolean;
export declare function serverAnswersWithin(
  origin: string,
  fetchImpl: typeof fetch,
  options: { withinMs: number; timeoutMs?: number; everyMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> },
): Promise<boolean>;
export declare function serverLook(origin: string, fetchImpl: typeof fetch, timeoutMs?: number): Promise<"yes" | "no" | "gone">;
export declare function serverAnswers(origin: string, fetchImpl: typeof fetch, timeoutMs?: number): Promise<boolean>;
export declare function serverOpens(
  entry: { id: string; name: string; origin: string },
  deps: { fetch: typeof fetch; dialog: { showMessageBox(options: object): Promise<{ response: number }> }; forget: (id: string) => unknown; timeoutMs?: number; graceMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> },
): Promise<boolean>;
export declare function newServerReach(
  link: { origin: string },
  deps: { fetch: typeof fetch; dialog: { showMessageBox(options: object): Promise<{ response: number }> }; timeoutMs?: number },
): Promise<"open" | "keep" | "cancel">;
