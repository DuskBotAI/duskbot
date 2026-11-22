// The bot panel's Computer tab and real key presses: a key's activation is only provable in a browser.
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlDusk } from "../control-dusk.ts";
import { UI_TOOLS_DIR } from "./control-dusk-ui.ts";
import { clickByName } from "./grok-nav.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const binary = resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env });
const enabled = process.env.DUSK_UI_E2E === "1" || Boolean(binary);
if (!enabled) console.info("skipping computer panel focus UI e2e: set DUSK_UI_E2E=1 to install the pinned browser");

(enabled ? it : it.skip)("answers Enter on a bot's screen as it answers a click, and keeps the keyboard there", async () => {
  let child: ChildProcess | undefined;
  let info: { ui: string; url: string; botId: string } | undefined;
  try {
    let stdout = "", stderr = "";
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/control-dusk.ts"), "ui", "launch"], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    child.on("error", error => { stderr += error.message; });
    await expect.poll(() => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`UI launcher exited: ${stderr}`);
      try { info = JSON.parse(stdout); return Boolean(info?.ui); } catch { return false; }
    }, { timeout: binary ? 180_000 : 600_000, interval: 250 }).toBe(true);
    const ui = (verb: string, ...args: string[]) => runControlDusk(["ui", verb, "--ui", info!.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const screen = '[data-panel-action="open-computer"]';
    const visible = () => evaluate(`Boolean(document.querySelector(${JSON.stringify(screen)}))`);

    // A bot on this computer leads its Computer tab with its browser; a bot on its own computer leads with its screen.
    const placed = await fetch(`${info!.url}/api/bots/${info!.botId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ computer: "vm" }) });
    expect(placed.ok).toBe(true);
    const openComputerTab = async () => {
      await clickByName(ui, /^Open Pepper's profile/, "button");
      await clickByName(ui, "Computer", "tab");
      await expect.poll(visible, { timeout: 15_000 }).toBe(true);
      await expect.poll(() => evaluate("document.querySelector('[data-inline-computer]')?.dataset.stage ?? null"), { timeout: 15_000 }).not.toBe(null);
    };
    const after = async () => {
      await expect.poll(() => evaluate(`document.querySelector(${JSON.stringify(screen)})?.getAttribute('aria-busy') ?? 'settled'`), { timeout: 15_000 }).toBe("settled");
      return evaluate(`(() => {
        const button = document.querySelector(${JSON.stringify(screen)});
        return {
          stage: document.querySelector('[data-inline-computer]')?.dataset.stage ?? null,
          label: button?.getAttribute('aria-label') ?? null,
          panels: document.querySelectorAll('[data-computer-panel-close]').length,
          focused: document.activeElement === button,
        };
      })()`);
    };

    await openComputerTab();
    await evaluate(`(() => { document.querySelector(${JSON.stringify(screen)}).focus(); return true; })()`);
    expect(await evaluate("document.activeElement.dataset.panelAction")).toBe("open-computer");
    await ui("press", "--keys", "Enter");
    const byKey = await after();
    expect(byKey).toMatchObject({ panels: 0, focused: true });

    await ui("press", "--keys", "Escape");
    await openComputerTab();
    const name = await evaluate(`document.querySelector(${JSON.stringify(screen)}).getAttribute('aria-label')`) as string;
    await clickByName(ui, name, "button");
    const byClick = await after();
    expect(byClick).toEqual(byKey);
  } finally {
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
  }
}, binary ? 300_000 : 720_000);
