// The desktop window shows this app's own build of the UI for every place it opens: a page at a server's origin is
// answered from the bundle here (or the dev server), while /api and /.well-known stay with that server. The page keeps
// the server's origin, so its cookies, CSRF checks, WebSockets and every origin rule in main work exactly as before.
// It rides the Chrome DevTools Protocol Fetch domain on the window's own webContents (Electron 43: webContents.debugger).
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/** Paths a server always answers itself: its API (WebSockets included) and its public descriptors. */
const SERVER_PATH = /^\/(?:api|\.well-known)(?:\/|$)/;
/** Requests a page makes for its own files; an API call is a Fetch, XHR or EventSource and is never paused. */
const FILE_TYPES = Object.freeze(["Script", "Stylesheet", "Image", "Font", "Other"]);
/** Where this app's sounds and videos live: the bundle's /assets, and in development Vite's source and dependency paths.
 * Media elsewhere (a bot's files under /api) never pauses. */
const MEDIA_PATHS = Object.freeze(["/assets/*", "/src/*", "/@fs/*", "/node_modules/*"]);
/** Pages with an entry of their own, as server/static-files.ts serves them. */
const PAGES = Object.freeze({ "/": "/index.html", "/rail": "/rail.html" });

const MIME = Object.freeze({
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".woff": "font/woff",
  ".ttf": "font/ttf", ".wasm": "application/wasm", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".mp4": "video/mp4", ".webm": "video/webm",
});
/** Never framed and no Referer, as the server's own pages (server/static-files.ts PAGE_HEADERS). */
/** What CDP says of a paused request that no longer exists. */
const GONE = /invalid interceptionid/i;
const PAGE_HEADERS = Object.freeze({ "content-security-policy": "frame-ancestors 'none'", "x-frame-options": "DENY", "referrer-policy": "no-referrer" });

/** The http(s) origin of `value`, or null. */
export function originOf(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch { return null; }
}

/** The places whose pages come from this app: each server origin once, never this computer's own page. */
export function servedOrigins(candidates, local = []) {
  const own = new Set(local.map(originOf).filter(Boolean));
  const out = new Set();
  for (const candidate of candidates) {
    const origin = originOf(candidate);
    if (origin && !own.has(origin)) out.add(origin);
  }
  return [...out].sort();
}

/** CDP Fetch patterns: a place's pages once its server has answered (so its redirects and errors still count), its
 * files before they leave. */
export function uiPatterns(origins) {
  return origins.flatMap((origin) => [
    { urlPattern: `${origin}/*`, resourceType: "Document", requestStage: "Response" },
    ...FILE_TYPES.map((resourceType) => ({ urlPattern: `${origin}/*`, resourceType, requestStage: "Request" })),
    ...MEDIA_PATHS.map((at) => ({ urlPattern: `${origin}${at}`, resourceType: "Media", requestStage: "Request" })),
  ]);
}

/**
 * What to do with one paused request: "page" (this app's page in place of the server's), "file" (this app's file when it
 * has one), or "network" (the server's own answer, untouched).
 * @param {{ url: string, resourceType: string, responseStatusCode?: number, responseErrorReason?: string,
 *   responseHeaders?: Array<{ name: string, value: string }> }} paused
 * @param {readonly string[]} origins
 */
export function uiRoute(paused, origins) {
  let url;
  try { url = new URL(paused.url); } catch { return "network"; }
  if (!origins.includes(url.origin) || SERVER_PATH.test(url.pathname)) return "network";
  if (paused.resourceType === "Document") {
    if (paused.responseErrorReason || !(paused.responseStatusCode >= 200 && paused.responseStatusCode < 300)) return "network";
    const type = paused.responseHeaders?.find((header) => header.name.toLowerCase() === "content-type")?.value ?? "";
    return /^text\/html\b/i.test(type) ? "page" : "network";
  }
  if (paused.responseStatusCode !== undefined || paused.responseErrorReason) return "network";
  return "file";
}

const contentType = (file) => MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";

/** The packaged bundle (resources/ui): the same files and headers the local server would answer with. */
export function bundleSource(dir, { read = readFile, info = stat } = {}) {
  const root = path.resolve(dir);
  async function load(name, page) {
    const file = path.resolve(root, `.${name}`);
    if (file !== root && !file.startsWith(`${root}${path.sep}`)) return null;
    try {
      if (!(await info(file)).isFile()) return null;
      const body = await read(file);
      const type = contentType(file);
      const cache = type === "text/html" ? "no-cache" : name.startsWith("/assets/") ? "public, max-age=31536000, immutable" : null;
      return { status: 200, headers: { "content-type": type, ...(page ? PAGE_HEADERS : {}), ...(cache ? { "cache-control": cache } : {}) }, body };
    } catch { return null; }
  }
  return {
    kind: "bundle",
    file: async (url) => {
      let name;
      try { name = decodeURIComponent(new URL(url).pathname); } catch { return null; }
      return PAGES[name] ? null : load(name, false);
    },
    page: (url) => {
      let name = "/";
      try { name = new URL(url).pathname; } catch {}
      return load(PAGES[name] ?? "/index.html", true);
    },
  };
}

/** Requests to the dev server at once. A page asks for hundreds of modules together; one connection each, against a
 * Vite still busy optimizing, overflowed its listen backlog (128 on macOS) and the rest were reset, so those modules
 * went to the place's server, which has no /src, and the app's import failed. */
const DEV_CONNECTIONS = 24;
const DEV_TRIES = 4;
const HOP_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

function conditionalHeaders(accept, requestHeaders) {
  const headers = { accept };
  if (requestHeaders) {
    for (const [name, value] of Object.entries(requestHeaders)) {
      const lower = name.toLowerCase();
      if ((lower === "if-none-match" || lower === "if-modified-since") && value) headers[lower] = String(value);
    }
  }
  return headers;
}

/** `pnpm dev:app`: the files come from the Vite dev server, which also answers a page path with its own index. */
export function devSource(devOrigin, { fetch: fetchImpl = fetch, connections = DEV_CONNECTIONS, tries = DEV_TRIES, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const origin = originOf(devOrigin);
  let busy = 0;
  const waiting = [];
  const take = () => (busy < connections ? (busy += 1, Promise.resolve()) : new Promise((resolve) => waiting.push(resolve)));
  const give = () => { const next = waiting.shift(); if (next) next(); else busy -= 1; };

  /** Vite's answer, read whole while holding a connection; a dropped connection is asked again. */
  async function ask(target, headers) {
    for (let attempt = 1; ; attempt += 1) {
      await take();
      try {
        const response = await fetchImpl(target, { headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
        const responseHeaders = {};
        for (const [name, value] of response.headers) if (!HOP_HEADERS.has(name)) responseHeaders[name] = value;
        const body = response.status === 304 ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer());
        return { status: response.status, headers: responseHeaders, body };
      } catch (error) {
        if (attempt >= tries) throw error;
      } finally { give(); }
      await pause(100 * 2 ** (attempt - 1));
    }
  }

  async function load(url, accept, requestHeaders) {
    let at;
    try { at = new URL(url); } catch { return null; }
    return ask(`${origin}${at.pathname}${at.search}`, conditionalHeaders(accept, requestHeaders));
  }
  const html = (answer) => /^text\/html\b/i.test(answer.headers["content-type"] ?? "");
  return {
    kind: "dev",
    // Vite answers a name it does not have with its index page (200, text/html) or 404: that file is the server's. Any
    // other answer is Vite's own, errors included (a transform error, an outdated optimized dependency), exactly as the
    // page would get it from Vite directly; the place's server has no copy of a dev module to fall back on.
    file: async (url, requestHeaders) => {
      const answer = await load(url, "*/*", requestHeaders);
      return !answer || answer.status === 404 || html(answer) ? null : answer;
    },
    page: async (url) => {
      const answer = await load(url, "text/html").catch(() => null);
      return answer && answer.status >= 200 && answer.status < 300 && html(answer) ? { ...answer, headers: { ...answer.headers, ...PAGE_HEADERS } } : null;
    },
  };
}

/**
 * Serves this app's UI to the window's pages at the servers `origins()` names.
 * @param {{ source: ReturnType<typeof bundleSource> | ReturnType<typeof devSource>, origins(): string[], log?(line: string): void }} deps
 */
export function createLocalUi({ source, origins, log = () => {} }) {
  let contents = null, applied = "", served = [], attached = false;

  const send = (method, params) => contents.debugger.sendCommand(method, params);
  const pass = (requestId) => send("Fetch.continueRequest", { requestId }).catch(() => {});

  async function onPaused(paused) {
    const route = uiRoute({ ...paused.request, resourceType: paused.resourceType, responseStatusCode: paused.responseStatusCode,
      responseErrorReason: paused.responseErrorReason, responseHeaders: paused.responseHeaders }, served);
    if (route === "network") return pass(paused.requestId);
    let answer = null;
    try { answer = route === "page" ? await source.page(paused.request.url) : await source.file(paused.request.url, paused.request.headers); }
    catch (error) { log(`local ui: ${error?.message ?? error}`); }
    // nothing here by that name (a file only the server's own page asks for): the server answers, as it always did
    if (!answer) return pass(paused.requestId);
    await send("Fetch.fulfillRequest", {
      requestId: paused.requestId, responseCode: answer.status,
      responseHeaders: Object.entries(answer.headers).map(([name, value]) => ({ name, value: String(value) })),
      ...(answer.status === 304 ? {} : { body: Buffer.from(answer.body).toString("base64") }),
    }).catch((error) => {
      // the page let go of it first (a reload or a navigation cancels every module still on its way): nobody is left to
      // answer, and saying so was 3592 lines in two days that buried everything else in the log
      if (GONE.test(String(error?.message ?? error))) return;
      log(`local ui: could not answer ${route} (${error?.message ?? error})`);
      return pass(paused.requestId);
    });
  }

  function onMessage(_event, method, params) {
    if (method === "Fetch.requestPaused") void onPaused(params);
  }

  function onDetach(_event, reason) {
    attached = false;
    applied = "";
    log(`local ui: detached (${reason}); pages come from their servers until the window loads again`);
  }

  async function refresh() {
    if (!contents || contents.isDestroyed()) return;
    if (!attached) {
      try {
        if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
        attached = true;
      } catch (error) {
        log(`local ui: could not attach (${error?.message ?? error}); pages come from their servers`);
        return;
      }
    }
    const next = origins();
    const key = JSON.stringify(next);
    if (key === applied) return;
    applied = key;
    served = next;
    try {
      if (next.length) await send("Fetch.enable", { patterns: uiPatterns(next) });
      else await send("Fetch.disable", {});
    } catch (error) {
      applied = "";
      log(`local ui: could not set what it serves (${error?.message ?? error})`);
    }
  }

  return {
    /** Takes over the window's pages; a second window replaces the first. */
    attach(webContents) {
      if (contents === webContents) return refresh();
      if (contents && !contents.isDestroyed()) {
        contents.debugger.removeListener("message", onMessage);
        contents.debugger.removeListener("detach", onDetach);
      }
      contents = webContents;
      attached = false;
      applied = "";
      contents.debugger.on("message", onMessage);
      contents.debugger.on("detach", onDetach);
      // a detach (another tool took the window) is undone by the next load
      contents.on("did-start-navigation", (details) => { if (details?.isMainFrame && !attached) void refresh(); });
      return refresh();
    },
    /** The places changed: from now on their pages are this app's. */
    refresh,
    origins: () => served,
  };
}
