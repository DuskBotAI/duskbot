// The key field's check before saving, photographed light and dark with a headless Chrome in a throwaway profile against a
// disposable server and a fake OpenAI-compatible provider on loopback that answers by the pasted key (no real provider).
// Run: node --experimental-strip-types scripts/verify-key-check.ts <dir>
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { launchVerificationServer } from "./control-dusk.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./testing/preview-fixture.ts";

const shots = resolve(process.argv[2] ?? "key-check-shots");
const CHROME = process.env.DUSK_CDP_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [WIDTH, HEIGHT, CLIP_W] = [1000, 700, 520];
const MODELS = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"];

const provider = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const key = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
  const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (key.includes("wrong")) return send(401, { error: { message: "Incorrect API key provided.", code: "invalid_api_key" } });
  if (req.url === "/v1/models") return send(200, { data: MODELS.map((id) => ({ id })) });
  const model = (JSON.parse(raw || "{}") as { model?: string }).model ?? "";
  if (!MODELS.includes(model)) return send(404, { error: { message: `The model \`${model}\` does not exist.`, code: "model_not_found" } });
  if (key.includes("nocredit")) return send(402, { error: { message: "Insufficient Balance" } });
  if (key.includes("busy")) return send(429, { error: { message: "Rate limit reached, please try again in 2s.", code: "rate_limit_exceeded" } });
  return send(200, { choices: [{ message: { role: "assistant", content: "ok" } }] });
});
await new Promise<void>((ready) => provider.listen(0, "127.0.0.1", ready));
const providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;

const paste = (key: string) => `const input = document.querySelector('[data-key-input]'); input.focus();
  const data = new DataTransfer(); data.setData('text/plain', ${JSON.stringify(key)});
  input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))`;
const fill = (values: Record<string, string>) => `const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  for (const [label, value] of Object.entries(${JSON.stringify(values)})) {
    const input = document.querySelector('input[aria-label="' + label + '"]'); set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  await new Promise((done) => setTimeout(done, 200));
  [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Add server')).click()`;

const VIEWS: Array<{ name: string; view: "row" | "server"; url?: string; act: string; after?: string }> = [
  { name: "works", view: "row", act: paste("fx-works-key") },
  { name: "busy", view: "row", act: paste("fx-busy-key") },
  { name: "wrong-key", view: "row", act: paste("fx-wrong-key") },
  { name: "no-credit", view: "row", act: paste("fx-nocredit-key") },
  { name: "no-credit-saved-anyway", view: "row", act: paste("fx-nocredit-key"), after: "document.querySelector('[data-key-check-anyway]')?.click()" },
  { name: "unreachable", view: "row", url: "http://127.0.0.1:9/v1", act: paste("fx-works-key") },
  { name: "wrong-model", view: "server", act: fill({ "Display name": "Lab box", "Base URL": providerUrl, "API key": "fx-works-key", "Model IDs, separated by commas (optional)": "llama-3.3-70b" }) },
];

async function openChrome(profile: string) {
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--password-store=basic",
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdio: "ignore" });
  let port = "";
  for (let i = 0; i < 100 && !port; i++) {
    await delay(100);
    try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]!.trim(); } catch {}
  }
  if (!port) { chrome.kill(); throw new Error("Chrome did not start"); }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const socket = new WebSocket(targets.find((target) => target.type === "page")!.webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  let next = 0;
  const waiting = new Map<number, { done: (value: any) => void; fail: (error: Error) => void }>();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    const call = waiting.get(message.id);
    if (!call) return;
    waiting.delete(message.id);
    if (message.error) call.fail(new Error(message.error.message)); else call.done(message.result);
  };
  const send = (method: string, params: object = {}) => new Promise<any>((done, fail) => {
    const id = ++next;
    const timer = setTimeout(() => { waiting.delete(id); fail(new Error(`${method} got no answer`)); }, 30_000);
    waiting.set(id, { done: (value) => { clearTimeout(timer); done(value); }, fail: (error) => { clearTimeout(timer); fail(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression: string) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };
  const settle = async (condition: string, ms: number) => {
    const end = Date.now() + ms;
    while (!(await evaluate(condition).catch(() => false)) && Date.now() < end) await delay(250);
  };
  return {
    async shoot(url: string, file: string, act: string, after?: string, height = 420) {
      await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false });
      await send("Page.navigate", { url });
      await settle(`Boolean(document.querySelector('[data-key-input], input[aria-label="API key"]'))`, 60_000);
      await delay(2_000);
      await evaluate(`(async () => { ${act}; })()`);
      // an app without the check shows its own answer instead: give it the same time
      await settle(`Boolean(document.querySelector('[data-key-check]'))`, 30_000);
      if (after) { await evaluate(`(async () => { ${after}; })()`); await settle(`Boolean(document.querySelector('[data-key-masked]'))`, 15_000); }
      await delay(1_200);
      const { data } = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: CLIP_W, height, scale: 1 } });
      writeFileSync(file, Buffer.from(data, "base64"));
    },
    close() { socket.close(); chrome.kill(); },
  };
}

const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;
try {
  const api = fixtureApi(fixture.info.url, { headers: { origin: fixture.info.url } });
  ui = await mountPreview(fixture, { entry: "/scripts/testing/key-check-preview.tsx", route: "/__key-check.html", title: "Key check", logLevel: "warn" });
  mkdirSync(shots, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), "dusk-key-check-chrome-"));
  const chrome = await openChrome(profile);
  try {
    for (const view of VIEWS) for (const skin of ["daylight", "midnight"]) {
      await api("PUT", "/api/config", { openaiCompat: { url: view.url ?? providerUrl, key: "" } });
      const file = join(shots, `${view.name}-${skin === "daylight" ? "light" : "dark"}.png`);
      await chrome.shoot(`${ui.previewUrl}?view=${view.view}&skin=${skin}`, file, view.act, view.after, view.view === "server" ? 470 : 420);
      console.log(file);
    }
  } finally {
    chrome.close();
    await delay(500);
    rmSync(profile, { recursive: true, force: true });
  }
} finally {
  await ui?.close();
  await fixture.close();
  provider.close();
}
