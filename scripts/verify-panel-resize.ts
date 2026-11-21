// The bot panel's resizable edge in the full app: a real pointer drag, a double-click and the arrow keys against a
// disposable fake-engine server, photographed narrow, default and wide in light and dark with a headless Chrome in a
// throwaway profile. Run: node --experimental-strip-types scripts/verify-panel-resize.ts <dir>
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { launchVerificationServer, runControlDusk } from "./control-dusk.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./testing/preview-fixture.ts";

const shots = resolve(process.argv[2] ?? "panel-resize-shots");
const CHROME = process.env.DUSK_CDP_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [WIDTH, HEIGHT] = [1440, 900];

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
  const mouse = (type: string, x: number, y: number, clickCount = 1) =>
    send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount });
  const shoot = async (file: string) => {
    const { data } = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 } });
    writeFileSync(file, Buffer.from(data, "base64"));
  };
  return { send, evaluate, until, mouse, shoot, close() { socket.close(); chrome.kill(); } };
}

const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;
try {
  await runControlDusk(["new-bot", "--name", "Research", "--url", fixture.info.url]);
  const api = fixtureApi(fixture.info.url, { headers: { origin: fixture.info.url } });
  await api("PATCH", "/api/config", { language: "en" }).catch(() => {});
  const { bots } = await api("GET", "/api/bots?messages=0") as { bots: Array<{ id: string }> };
  await api("PATCH", `/api/bots/${bots[0]!.id}`, { color: "blue" });
  ui = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__threads.html", title: "Panel resize", logLevel: "warn" });
  mkdirSync(shots, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), "dusk-panel-resize-chrome-"));
  const chrome = await openChrome(profile);
  try {
    await chrome.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    const failures: string[] = [];
    const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok" : "FAIL"} ${what}`); if (!ok) failures.push(what); };
    const edgeX = () => chrome.evaluate(`document.querySelector('#bot-panel [role="separator"]').getBoundingClientRect().left + 3`) as Promise<number>;
    const panelWidth = () => chrome.evaluate(`Math.round(document.querySelector('#bot-panel').getBoundingClientRect().width)`) as Promise<number>;
    const open = async (skin: string, stored: number | null, tab = "Details") => {
      await chrome.send("Page.navigate", { url: ui!.previewUrl });
      await chrome.until(`Boolean(document.querySelector('main'))`, "the chat");
      await chrome.evaluate(`localStorage.setItem('dusk-skin', ${JSON.stringify(skin)}); ${stored === null ? "localStorage.removeItem('dusk-bot-panel-width')" : `localStorage.setItem('dusk-bot-panel-width', '${stored}')`}`);
      await chrome.send("Page.reload");
      await chrome.until(`Boolean(document.querySelector('button[aria-label="Open Research\\'s profile"]'))`, "the profile button");
      await delay(800);
      await chrome.evaluate(`void (document.querySelector('#bot-panel') || document.querySelector('button[aria-label="Open Research\\'s profile"]').click())`);
      await chrome.until(`document.querySelector('[data-panel-slot="open"]')?.getBoundingClientRect().width >= 280`, "the panel");
      await chrome.evaluate(`[...document.querySelectorAll('#bot-panel [role="tab"]')].find((t) => t.textContent === ${JSON.stringify(tab)})?.click()`);
      await delay(1200);
    };

    await open("daylight", null);
    check(await panelWidth() === 320, "opens at its usual 320px");
    const hits = await chrome.evaluate(`(() => { const edge = document.querySelector('#bot-panel [role="separator"]'); const r = edge.getBoundingClientRect();
      return [r.left + 1, r.left + r.width - 1].every((x) => [40, 300, 850].every((y) => document.elementFromPoint(x, y) === edge)) && r.width === 8 && getComputedStyle(edge).cursor === 'col-resize'; })()`);
    check(hits === true, "the 8px edge takes the pointer top to bottom, with the col-resize cursor");
    let x = await edgeX();
    await chrome.mouse("mouseMoved", x, 400);
    await delay(250);
    check(await chrome.evaluate(`getComputedStyle(document.querySelector('#bot-panel [role="separator"]'), '::after').backgroundColor !== 'rgba(0, 0, 0, 0)'`) === true, "a hover draws its line");
    await chrome.mouse("mousePressed", x, 400);
    for (let step = 1; step <= 12; step++) { await chrome.mouse("mouseMoved", x - step * 15, 400); await delay(16); }
    await chrome.mouse("mouseReleased", x - 180, 400);
    await delay(300);
    check(await panelWidth() === 500, `a drag of 180px leaves it at 500px (${await panelWidth()})`);
    check(await chrome.evaluate(`localStorage.getItem('dusk-bot-panel-width')`) === "500", "and keeps 500 for the next open");
    x = await edgeX();
    await chrome.mouse("mousePressed", x, 400);
    for (let step = 1; step <= 20; step++) { await chrome.mouse("mouseMoved", x - step * 60, 400); await delay(16); }
    await chrome.mouse("mouseReleased", x - 1200, 400);
    await delay(300);
    const chat = await chrome.evaluate(`Math.round(document.querySelector('main').getBoundingClientRect().width)`) as number;
    check(chat >= 420, `dragged far left, the chat keeps ${chat}px`);
    x = await edgeX();
    await chrome.mouse("mousePressed", x, 400, 1);
    await chrome.mouse("mouseReleased", x, 400, 1);
    await chrome.mouse("mousePressed", x, 400, 2);
    await chrome.mouse("mouseReleased", x, 400, 2);
    await delay(300);
    check(await panelWidth() === 320, "a double-click puts it back at 320px");
    await chrome.evaluate(`document.querySelector('#bot-panel [role="separator"]').focus()`);
    await chrome.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 });
    await chrome.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 });
    await delay(200);
    check(await chrome.evaluate(`document.querySelector('#bot-panel [role="separator"]').getAttribute('aria-valuenow')`) === "336", "the left arrow widens it by 16px, and says so");

    await open("daylight", 360, "Computer");
    const before = await chrome.evaluate(`Math.round(document.querySelector('#bot-panel [role="tabpanel"]')?.getBoundingClientRect().width ?? 0)`) as number;
    x = await edgeX();
    await chrome.mouse("mousePressed", x, 400);
    for (let step = 1; step <= 10; step++) { await chrome.mouse("mouseMoved", x - step * 20, 400); await delay(16); }
    await chrome.mouse("mouseReleased", x - 200, 400);
    await delay(400);
    const after = await chrome.evaluate(`Math.round(document.querySelector('#bot-panel [role="tabpanel"]')?.getBoundingClientRect().width ?? 0)`) as number;
    check(after - before === 200, `the Computer tab follows the edge (${before} to ${after}px)`);

    const sizes: Array<[string, number | null]> = [["narrow", 280], ["default", null], ["wide", 700]];
    for (const skin of ["daylight", "midnight"]) for (const [name, stored] of sizes) {
      await open(skin, stored);
      const file = join(shots, `panel-resize-${name}-${skin === "daylight" ? "light" : "dark"}.png`);
      await chrome.shoot(file);
      console.log(file, await panelWidth());
    }
    await open("midnight", 500, "Computer");
    await chrome.mouse("mouseMoved", await edgeX(), 400);
    await delay(300);
    await chrome.shoot(join(shots, "panel-resize-computer-hover-dark.png"));
    if (failures.length) { process.exitCode = 1; console.log(`${failures.length} failed`); }
  } finally {
    chrome.close();
    await delay(500);
    rmSync(profile, { recursive: true, force: true });
  }
} finally {
  await ui?.close();
  await fixture.close();
}
