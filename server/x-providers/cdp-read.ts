// The X sign-in route's read on a browser reached over CDP (agent-browser's Chrome, whose address `agent-browser get
// cdp-url` gives): a background tab, the bodies of the named responses, the tab closed after. Runtime is never
// enabled, so the page sees no more of this than of a person's own DevTools.
import { inRunningBrowser, startBrowserSession } from "../browser-engine.ts";
import { browserRuntimeEnv } from "../browser-runtime.ts";
import { connectCdp, type BrowserSitesTarget, type Cdp, type CdpEvent } from "../browser-sites.ts";

export interface ResponseRead {
  url: string;
  wanted: (url: string) => string | null;
  enough: (names: ReadonlySet<string>) => boolean;
  timeoutMs: number;
}
export interface ReadAnswer { url: string; responses: Array<{ name: string; status: number; body: string }> }

/** Reads on a bot's agent-browser session, starting it first when it is not running. */
export async function readOnAgentBrowser(target: Pick<BrowserSitesTarget, "binaryPath" | "session" | "env">, request: ResponseRead): Promise<ReadAnswer> {
  const env = browserRuntimeEnv({ ...target.env, AGENT_BROWSER_SESSION: target.session });
  const address = async () => {
    const answer = await inRunningBrowser(target.binaryPath, env, ["get", "cdp-url"]);
    return typeof answer?.cdpUrl === "string" && /^wss?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(answer.cdpUrl) ? answer.cdpUrl : null;
  };
  let socket = await address();
  if (!socket) {
    if (!await startBrowserSession(target.binaryPath, env)) throw new Error("The browser did not start.");
    socket = await address();
  }
  if (!socket) throw new Error("The browser gave no CDP address.");
  return readResponsesOverCdp(socket, request);
}

type Connect = (url: string, timeoutMs: number, listeners: { event?(message: CdpEvent): void; closed?(): void }) => Promise<Cdp>;

export async function readResponsesOverCdp(socket: string, request: ResponseRead, connect: Connect = connectCdp): Promise<ReadAnswer> {
  const deadline = Date.now() + request.timeoutMs;
  let sessionId: string | null = null;
  const pending = new Map<string, { name: string; status: number }>();
  const finished: Array<{ requestId: string; name: string; status: number }> = [];
  let wake = () => {};
  const cdp = await connect(socket, Math.min(10_000, request.timeoutMs), {
    event(message) {
      if (!sessionId || message.sessionId !== sessionId) return;
      const params = message.params ?? {};
      if (message.method === "Network.responseReceived") {
        const response = params.response as { url?: unknown; status?: unknown } | undefined;
        const name = typeof response?.url === "string" ? request.wanted(response.url) : null;
        if (name && typeof params.requestId === "string") pending.set(params.requestId, { name, status: typeof response?.status === "number" ? response.status : 0 });
      } else if (message.method === "Network.loadingFinished" && typeof params.requestId === "string") {
        const hit = pending.get(params.requestId);
        if (hit) {
          pending.delete(params.requestId);
          finished.push({ requestId: params.requestId, ...hit });
          wake();
        }
      }
    },
  });
  let targetId: string | null = null;
  try {
    const created = await cdp.send("Target.createTarget", { url: "about:blank", background: true });
    targetId = typeof created.targetId === "string" ? created.targetId : null;
    if (!targetId) throw new Error("The browser opened no tab.");
    const attached = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    sessionId = typeof attached.sessionId === "string" ? attached.sessionId : null;
    if (!sessionId) throw new Error("Could not open the tab.");
    await cdp.send("Network.enable", {}, sessionId);
    await cdp.send("Page.navigate", { url: request.url }, sessionId);
    const responses: ReadAnswer["responses"] = [];
    const names = new Set<string>();
    while (Date.now() < deadline) {
      for (const done of finished.splice(0)) {
        const body = await cdp.send("Network.getResponseBody", { requestId: done.requestId }, sessionId).catch(() => null);
        if (!body || typeof body.body !== "string") continue;
        responses.push({ name: done.name, status: done.status, body: body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body });
        names.add(done.name);
      }
      if (request.enough(names)) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now())));
        wake = () => { clearTimeout(timer); resolve(); };
      });
    }
    const info = await cdp.send("Target.getTargetInfo", { targetId }).catch(() => ({}));
    const url = typeof (info as { targetInfo?: { url?: unknown } }).targetInfo?.url === "string" ? (info as { targetInfo: { url: string } }).targetInfo.url : "";
    return { url, responses };
  } finally {
    if (targetId) await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
    cdp.close();
  }
}
