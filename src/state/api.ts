// The renderer's JSON request helper. A Cloud home that went to sleep is never woken by a background poll
// (src/lib/cloud-power.ts), and a page out of sight sends none at all.
import { asleepAnswer, BACKGROUND_HEADERS, cloudAsleep, goneAnswer, markCloudAsleep, markCloudAwake, markCloudGone, pageHidden, pageShown, wakingAnswer } from "../lib/cloud-power";
import { lacksAdminScope } from "../lib/admin-scope";
import { isBotLimitRefusal, showBotLimit } from "../lib/bot-limit";
import { noteRefusedRequest } from "../lib/session-ended";
import { feature, requestRefused, settingsChange } from "../lib/product-analytics";
import { plainErrorLine } from "../lib/plain-error";
import { t } from "../lib/i18n";
import { TRAIL_HEADER, newTrailId, trailApiCall, trailAvailable } from "../lib/trail";

export class ApiError extends Error {
  readonly status: number;
  readonly body?: Record<string, unknown>;
  /** the server's own words when `message` was turned into plain ones */
  readonly detail?: string;
  constructor(message: string, status: number, body?: Record<string, unknown>, detail?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.detail = detail;
  }
}

/** a person never reads a stack, an errno or a bare status line: plain words, the raw text kept in the console */
function plainOrRaw(raw: string): { message: string; detail?: string } {
  const plain = plainErrorLine(raw);
  if (!plain || plain === raw) return { message: raw };
  console.warn("[api]", raw);
  return { message: plain, detail: raw };
}

type ApiInit = RequestInit & { timeoutMs?: number; background?: boolean };
/** Background reads waiting for a hidden page to show again, one per path: a poll that ticks while hidden asks once. */
const heldReads = new Map<string, Promise<unknown>>();

/** `background`: a poll nobody asked for just now. It never wakes a Cloud home that went to sleep (it is refused here
 * instead, src/lib/cloud-power.ts) and the home doesn't count it as someone using it. Anything else wakes it. While the
 * page is hidden (a background tab, a minimized window) a background request waits until it shows again, so a page out of
 * sight never reaches a Cloud home on its own: a Cloud home asleep is woken by any request that reaches it. */
export async function api<T = any>(path: string, init?: ApiInit): Promise<T> {
  const { timeoutMs, signal, background, headers, ...rest } = init ?? {};
  if (background && pageHidden()) return heldUntilShown<T>(path, init!);
  if (cloudAsleep()) {
    if (background) throw new ApiError("My Cloud is asleep", 503, { error: "asleep" });
    markCloudAwake();
  }
  const sent = new Headers(headers ?? { "content-type": "application/json" });
  if (background) for (const [name, value] of Object.entries(BACKGROUND_HEADERS)) sent.set(name, value);
  const method = (rest.method ?? "GET").toUpperCase(), startedAt = performance.now();
  // every change the desktop app asks for carries a trail id, so the server's trail names the same action
  if (method !== "GET" && method !== "HEAD" && trailAvailable() && !sent.has(TRAIL_HEADER)) sent.set(TRAIL_HEADER, newTrailId());
  const res = await fetch(path, {
    ...rest,
    headers: sent,
    signal: timeoutMs === undefined
      ? signal
      : signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
  }).catch((error: unknown) => {
    trailApiCall(path, method, 0, startedAt, rest.body, sent.get(TRAIL_HEADER), error);
    // the name stays, so callers that tell a timeout or a cancel apart still can
    if (error instanceof DOMException && error.name === "TimeoutError") throw new DOMException(t("error.plain.timeout"), "TimeoutError");
    // still a TypeError: callers read "not an ApiError" as "no answer came" and send again
    if (error instanceof TypeError) {
      console.warn("[api]", path, error.message);
      throw new TypeError(t("error.plain.unreachable"), { cause: error });
    }
    throw error;
  });
  trailApiCall(path, method, res.status, startedAt, rest.body, sent.get(TRAIL_HEADER));
  const answer = await answerOf<T>(res);
  if (path === "/api/config" && ["PUT", "PATCH"].includes((init?.method ?? "GET").toUpperCase())) feature("settings_changed");
  if (method !== "GET" && method !== "HEAD") settingsChange();
  return answer;
}

/** What `api` makes of a response, for one whose request started elsewhere (src/state/boot-reads.ts). */
export async function answerOf<T = any>(res: Response): Promise<T> {
  if (asleepAnswer(res)) markCloudAsleep();
  if (goneAnswer(res)) markCloudGone();
  if (wakingAnswer(res)) { await res.body?.cancel().catch(() => {}); throw new ApiError("My Cloud is waking up", 503, { error: "waking" }); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = body?.error;
    const raw = typeof error === "string" ? error : typeof error?.message === "string" ? error.message : `${res.status} ${res.statusText}`;
    const { message, detail } = plainOrRaw(raw);
    const refused = new ApiError(message, res.status, body, detail);
    requestRefused(res.status, body, res.url);
    if (res.status === 401 || (res.status === 403 && !lacksAdminScope(refused))) noteRefusedRequest();
    if (res.status === 409 && isBotLimitRefusal(refused)) showBotLimit();
    throw refused;
  }
  return body;
}

/** A background request from a hidden page, sent once it shows again (src/lib/cloud-power.ts `pageShown`), by then refused if
 * the Cloud home fell asleep meanwhile. Reads of one path without a signal of their own share one request. */
function heldUntilShown<T>(path: string, init: ApiInit): Promise<T> {
  const shared = (init.method ?? "GET").toUpperCase() === "GET" && !init.signal;
  const waiting = shared ? heldReads.get(path) : undefined;
  if (waiting) return waiting as Promise<T>;
  const sent = pageShown(init.signal ?? undefined).then(() => api<T>(path, init));
  if (!shared) return sent;
  heldReads.set(path, sent);
  void sent.finally(() => { if (heldReads.get(path) === sent) heldReads.delete(path); }).catch(() => {});
  return sent;
}

/** A 200 that isn't the snapshot: `api` turns a non-JSON answer into `{}`, and the reducer can't take a missing list. The part
 * fails instead, which keeps what's on screen. */
export function snapshotArrays<T>(answer: T, ...keys: (keyof T)[]): T {
  for (const key of keys) if (!Array.isArray(answer[key])) throw new Error(`Invalid snapshot: ${String(key)} is not a list`);
  return answer;
}
