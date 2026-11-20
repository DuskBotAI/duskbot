// The bot's Model card, its Advanced settings with the Backup AI switch, and the Connect an AI note, photographed light and dark with a headless Chrome in
// a throwaway profile against a disposable fake-engine server. Run: node --experimental-strip-types scripts/verify-backup-row.ts <dir>
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { launchVerificationServer, runControlDusk } from "./control-dusk.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./testing/preview-fixture.ts";

const shots = resolve(process.argv[2] ?? "backup-row-shots");
const CHROME = process.env.DUSK_CDP_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [WIDTH, HEIGHT, CLIP] = [1280, 900, 720];
const VIEWS: Array<{ name: string; view: string; act?: string; ready?: string }> = [
  { name: "details-model", view: "details", ready: "[data-panel-row='model']" },
  { name: "advanced-backup-ai", view: "advanced", ready: "[data-panel-row='backup-ai']" },
  { name: "connect-ai-note", view: "note", ready: "[data-connect-ai-note]" },
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
  const until = async (condition: string, what: string) => {
    const end = Date.now() + 60_000;
    while (!(await evaluate(condition).catch(() => false))) {
      if (Date.now() > end) throw new Error(`${what} never showed`);
      await delay(250);
    }
  };
  return {
    async shoot(url: string, file: string, act: string | undefined, ready: string | undefined, _ids: Record<string, string>, width = CLIP) {
      await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false });
      await send("Page.navigate", { url });
      await until(`Boolean(document.querySelector('[data-preview-ready]'))`, `${url}: the preview`);
      await delay(900);
      if (act) await evaluate(`(async () => { ${act}; })()`);
      if (ready) await until(`Boolean(document.querySelector(${JSON.stringify(ready)}))`, `${url}: ${ready}`);
      await delay(700);
      const { data } = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width, height: HEIGHT, scale: 1 } });
      writeFileSync(file, Buffer.from(data, "base64"));
    },
    close() { socket.close(); chrome.kill(); },
  };
}

const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;
try {
  await runControlDusk(["new-bot", "--name", "Research", "--url", fixture.info.url]);
  // a bot panel paints its switches in the bot's colour; blue, as most bots are, so the shot is not read as a warning
  const api = fixtureApi(fixture.info.url, { headers: { origin: fixture.info.url } });
  const { bots } = await api("GET", "/api/bots?messages=0") as { bots: Array<{ id: string; color?: string }> };
  console.log(`fixture bot colour was ${bots[0]!.color ?? "unset"}`);
  await api("PATCH", `/api/bots/${bots[0]!.id}`, { color: "blue" });
  ui = await mountPreview(fixture, { entry: "/scripts/testing/backup-row-preview.tsx", route: "/__backup-row.html", title: "Backup model row", logLevel: "warn" });
  mkdirSync(shots, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), "dusk-backup-row-chrome-"));
  const chrome = await openChrome(profile);
  try {
    for (const view of VIEWS) for (const skin of ["daylight", "midnight"]) {
      const file = join(shots, `${view.name}-${skin === "daylight" ? "light" : "dark"}.png`);
      await chrome.shoot(`${ui.previewUrl}?view=${view.view}&skin=${skin}`, file, view.act, view.ready, {});
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
}
