// Main-process side of "Let my cloud bots use this Mac" (cloud-mac.mjs): the bridge's IPC for this app's own page and
// its own My Cloud page, the native confirm before it turns on, the folder picker, and the indicator's updates.
// Both are on unless the person turned them off. Security invariant: turning either back on from off always passes a
// native dialog on this Mac, so a page alone can never turn one on. While a cloud bot uses the screen a menu bar (tray) item says so, with Stop.
// DUSK_MAC_CONTROL=off leaves it out.
import path from "node:path";

import { createCloudMac } from "./cloud-mac.mjs";
import { createScreenDriver } from "./cloud-screen.mjs";
import { trayIcon } from "./system-tray.mjs";
import { macLogFile } from "./mac-control-tools.mjs";

export const CLOUD_MAC_CHANNELS = Object.freeze(["state", "setEnabled", "setMode", "setLimitFolders", "addFolder", "removeFolder", "openLog", "setScreen", "stopScreen"]);
const FOLLOW_MS = 5_000;
const STRICTNESS = { never: 0, auto: 1, ask: 2 };

/** Whether this change lets cloud bots do more without asking: a laxer When to ask, or Only these folders turned off.
 * Security invariant: such a change from the cloud's page passes a native dialog on this Mac. */
export function loosens(view, change, value) {
  if (change === "setMode") return Object.hasOwn(STRICTNESS, value) && STRICTNESS[value] < STRICTNESS[view.mode];
  if (change === "setLimitFolders") return view.limitFolders && value !== true;
  return false;
}

/**
 * @param {{
 *   ipcMain: Electron.IpcMain, dialog: Electron.Dialog, shell: Electron.Shell,
 *   allowed(event: Electron.IpcMainInvokeEvent): boolean,
 *   window(): Electron.BrowserWindow | null,
 *   fetch: typeof fetch, label(): string, userData: string,
 *   jsonFile(file: string): { read(): any, write(value: any): void },
 *   myCloud(): string | null, cloudAwake(): boolean,
 *   linkKey(): Promise<string | null>, reauth(origin: string): Promise<boolean>,
 *   log(line: string): void,
 *   driver(): any, computerUse(): Promise<unknown>,
 *   Tray: typeof Electron.Tray, Menu: typeof Electron.Menu, nativeImage: typeof Electron.nativeImage, resourcesDir: string,
 * }} deps `driver`: this app's computer-control connection (cua.mjs); `computerUse` turns it on, asking for its grants.
 */
export function installCloudMac(deps) {
  if (process.env.DUSK_MAC_CONTROL === "off") return null;
  let indicator = null;
  const showIndicator = (view) => {
    if (!view.onScreen) { indicator?.destroy(); indicator = null; return; }
    try {
      indicator ??= new deps.Tray(trayIcon(deps.nativeImage, deps.resourcesDir));
      const words = `${view.onScreen.bot} is using this ${process.platform === "darwin" ? "Mac" : "computer"}'s screen`;
      indicator.setToolTip(words);
      if (process.platform === "darwin") indicator.setTitle(" Cloud bot on screen");
      indicator.setContextMenu(deps.Menu.buildFromTemplate([
        { label: words, enabled: false },
        { label: "Stop", click: () => core.stopScreen() },
      ]));
    } catch (error) { deps.log(`cloud mac: the screen indicator did not show (${error?.message ?? error})`); }
  };
  const send = (view) => {
    showIndicator(view);
    const win = deps.window();
    if (win && !win.isDestroyed()) win.webContents.send("cloud-mac:changed", view);
  };
  const core = createCloudMac({
    fetch: deps.fetch, name: deps.label, log: deps.log,
    prefs: deps.jsonFile(path.join(deps.userData, "cloud-mac.json")),
    cloud: () => ({ origin: deps.myCloud(), awake: deps.cloudAwake() }),
    linkKey: deps.linkKey, reauth: deps.reauth, onChange: send,
    screen: createScreenDriver({ connection: deps.driver, log: deps.log, requestAccess: deps.computerUse }),
  });
  const parent = () => { const win = deps.window(); return win && !win.isDestroyed() ? win : undefined; };

  async function confirmOn() {
    const options = {
      type: "warning", buttons: ["Let them use this Mac", "Cancel"], defaultId: 1, cancelId: 1, noLink: true,
      message: "Let your cloud bots use this Mac?",
      detail: "Bots on your dusk cloud will be able to run any command, download files, open apps and links, and read and change your files on this Mac, as you. By default they ask you first only for risky things. You can change that, or keep them to some folders, in Settings, and turn this off any time.",
    };
    const win = parent();
    const { response } = win ? await deps.dialog.showMessageBox(win, options) : await deps.dialog.showMessageBox(options);
    return response === 0;
  }

  async function confirmLoosen(what) {
    const options = {
      type: "warning", buttons: ["Change it", "Cancel"], defaultId: 1, cancelId: 1, noLink: true,
      message: what === "mode" ? "Let your cloud bots ask you less often on this Mac?" : "Let your cloud bots use any folder on this Mac?",
      detail: what === "mode" ? "More of what bots on your dusk cloud do on this Mac will run without a card first. It all still shows in the chat and the log."
        : "Bots on your dusk cloud will be able to read and change files anywhere on this Mac, not only in the folders you listed.",
    };
    const win = parent();
    const { response } = win ? await deps.dialog.showMessageBox(win, options) : await deps.dialog.showMessageBox(options);
    return response === 0;
  }

  async function confirmScreen() {
    const options = {
      type: "warning", buttons: ["Let them use the screen", "Cancel"], defaultId: 1, cancelId: 1, noLink: true,
      message: "Let your cloud bots use this Mac's screen?",
      detail: "Bots on your dusk cloud will be able to see the apps on this Mac and click and type in them, as you, when you ask them to. While one does, the menu bar says so, with Stop.",
    };
    const win = parent();
    const { response } = win ? await deps.dialog.showMessageBox(win, options) : await deps.dialog.showMessageBox(options);
    return response === 0;
  }

  const handlers = {
    state: () => core.view(),
    async setEnabled(on) { return on === true && !(await confirmOn()) ? core.view() : core.setEnabled(on === true); },
    async setMode(mode) { return loosens(core.view(), "setMode", String(mode)) && !(await confirmLoosen("mode")) ? core.view() : core.setMode(String(mode)); },
    async setLimitFolders(on) { return loosens(core.view(), "setLimitFolders", on === true) && !(await confirmLoosen("folders")) ? core.view() : core.setLimitFolders(on === true); },
    async addFolder() {
      const win = parent();
      const options = { properties: ["openDirectory", "createDirectory"], buttonLabel: "Allow this folder" };
      const picked = win ? await deps.dialog.showOpenDialog(win, options) : await deps.dialog.showOpenDialog(options);
      return picked.canceled || !picked.filePaths[0] ? core.view() : core.addFolder(picked.filePaths[0]);
    },
    removeFolder: (folder) => core.removeFolder(String(folder)),
    async openLog() { await deps.shell.openPath(macLogFile()); },
    async setScreen(on) {
      if (on !== true) return core.setScreen(false);
      if (!(await confirmScreen())) return core.view();
      const view = core.setScreen(true);
      if (!view.screenReady) await deps.computerUse().catch((error) => deps.log(`cloud mac: computer control did not start (${error?.message ?? error})`));
      return core.view();
    },
    stopScreen: () => core.stopScreen(),
  };
  for (const name of CLOUD_MAC_CHANNELS) {
    deps.ipcMain.handle(`cloud-mac:${name}`, (event, ...args) => {
      if (!deps.allowed(event)) throw new Error(`cloud-mac:${name} is only available in this app's window`);
      return handlers[name](...args);
    });
  }
  const tick = () => void core.sync().catch((error) => deps.log(`cloud mac: ${error?.message ?? error}`));
  tick();
  const timer = setInterval(tick, FOLLOW_MS);
  timer.unref?.();
  return { view: core.view, close() { clearInterval(timer); core.close(); indicator?.destroy(); indicator = null; } };
}
