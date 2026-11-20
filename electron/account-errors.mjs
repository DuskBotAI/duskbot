// privacy: a report carries an error's type, message and stack, the page path, the app version and the os, nothing
// else; it is sent without the account token or cookies, and only while the person keeps error reports on. the account
// service scrubs every field again.
import { scrubText, stackFrames } from "./error-report.mjs";
import { exitCodeText } from "./process-exit.mjs";

const MAX_PER_HOUR = 10;
const REQUEST_MS = 10_000;
const CRASHES = new Set(["crashed", "oom", "launch-failed", "integrity-failure", "abnormal-exit"]);
const SOURCES = new Set(["desktop", "desktop-main"]);

const text = (value, max) => typeof value === "string" ? value.slice(0, max) : "";
/** home folders, secrets, addresses and quoted text leave the device scrubbed, not only on the service */
const cleanStack = stack => stackFrames(`Error\n${stack}`).reverse().map(frame => `    at ${frame.function} (${frame.filename}:${frame.lineno}:${frame.colno})`).join("\n");

/** the desktop app's errors, main process and renderer, to the account service's POST /v1/errors */
export function createAccountErrors({ origin, enabled, platform, release, version, fetch: fetcher = globalThis.fetch, now = Date.now }) {
  const endpoint = `${new URL(origin).origin}/v1/errors`;
  const os = `${String(platform)} ${String(release ?? "")}`.trim().slice(0, 40);
  const seen = new Set();
  const sent = [];

  function post(report) {
    try {
      if (!enabled()) return false;
      const key = `${report.source}|${report.type}|${report.message}|${report.stack.split("\n")[0] ?? ""}`;
      if (seen.has(key)) return false;
      const time = now();
      while (sent.length && sent[0] <= time - 3_600_000) sent.shift();
      if (sent.length >= MAX_PER_HOUR) return false;
      seen.add(key);
      if (seen.size > 200) seen.delete(seen.values().next().value);
      sent.push(time);
      const clean = { ...report, message: scrubText(report.message), stack: cleanStack(report.stack) };
      void Promise.resolve(fetcher(endpoint, { method: "POST", redirect: "error", credentials: "omit", cache: "no-store", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...clean, version: String(version).slice(0, 40), os }), signal: AbortSignal.timeout(REQUEST_MS) }))
        .then(response => response?.body?.cancel?.().catch(() => {}), () => {});
      return true;
    } catch { return false; }
  }

  function capture(error, source = "desktop-main") {
    const err = error instanceof Error ? error : new Error(typeof error === "string" ? error : "non-error thrown");
    return post({ source, type: /^[A-Za-z_$][\w$]{0,60}$/.test(err.name) ? err.name : "Error", message: text(err.message, 500), stack: text((err.stack ?? "").split("\n").slice(1, 31).join("\n"), 4000), path: "" });
  }

  return {
    /** one renderer report: `{ type, message, stack, path }`; anything else is dropped */
    send(input) {
      if (!input || typeof input !== "object") return false;
      return post({ source: SOURCES.has(input.source) ? input.source : "desktop", type: /^[A-Za-z_$][\w$]{0,60}$/.test(text(input.type, 61)) ? text(input.type, 61) : "Error",
        message: text(input.message, 500), stack: text(input.stack, 4000), path: text(input.path, 120).replace(/[^\w/.:-]/g, "") });
    },
    capture,
    /** the main process's own fatal errors and its pages' and helpers' crashes */
    watch(app, proc = process, { ending = () => false, platform = process.platform } = {}) {
      const gone = (what, details) => new Error(`${what} ${details.reason} (exit ${exitCodeText(details.exitCode, platform)})${ending() ? " while quitting" : ""}`);
      proc.on("uncaughtExceptionMonitor", error => capture(error));
      app.on("render-process-gone", (_event, _contents, details) => { if (CRASHES.has(details?.reason)) capture(gone("page process", details)); });
      app.on("child-process-gone", (_event, details) => { if (CRASHES.has(details?.reason)) capture(gone(`${details.type} process${details.name ? ` ${scrubText(details.name).slice(0, 40)}` : ""}`, details)); });
    },
  };
}
