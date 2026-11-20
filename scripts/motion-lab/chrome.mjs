// A headless Chrome in a throwaway profile, driven over the DevTools protocol.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export async function openChrome() {
  const profile = mkdtempSync(join(tmpdir(), "motion-app-"));
  const chrome = spawn(CHROME, ["--headless=new", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--password-store=basic",
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdio: "ignore" });
  let port = "";
  for (let i = 0; i < 100 && !port; i++) { await delay(100); try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0].trim(); } catch {} }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const socket = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  let next = 0;
  const waiting = new Map();
  const listeners = [];
  socket.onmessage = (event) => {
    const m = JSON.parse(String(event.data));
    if (m.method) { for (const l of listeners) l(m); return; }
    const call = waiting.get(m.id); if (!call) return; waiting.delete(m.id);
    if (m.error) call.fail(new Error(m.error.message)); else call.done(m.result);
  };
  const send = (method, params = {}) => new Promise((done, fail) => { const id = ++next; waiting.set(id, { done, fail }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  };
  const until = async (cond, what, ms = 30000) => {
    const end = Date.now() + ms;
    while (!(await evaluate(cond).catch(() => false))) { if (Date.now() > end) throw new Error(`${what} never showed`); await delay(150); }
  };
  const close = async () => {
    const exited = new Promise((d) => chrome.once("exit", d)); chrome.kill(); await exited;
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { send, evaluate, until, close, on: (fn) => listeners.push(fn) };
}
