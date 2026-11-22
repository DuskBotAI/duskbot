// Real Settings component + production preload, offline IPC responses only.
// Run: node scripts/verify-server-connection.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixtureFlag = "--dusk-server-connection-fixture";

if (process.versions.electron && process.argv.includes(fixtureFlag)) {
  const { app, BrowserWindow, ipcMain, Menu, session } = await import("electron");
  const { parseHostedWorkspaceLink, withEnvironment, withActive, withoutEnvironment, workspaceSummary, workspaceMenuTemplate } = createRequire(import.meta.url)("../electron/environments.cjs");
  const [url, output, serverUrl] = process.argv.slice(process.argv.indexOf(fixtureFlag) + 1);
  app.setPath("userData", join(output, "user-data"));
  app.setPath("sessionData", join(output, "user-data"));
  app.commandLine.appendSwitch("disable-background-networking");
  app.on("window-all-closed", () => {});
  const calls = [];
  let pending;
  let saved = { activeId: "local", environments: [{ id: "cloud", name: "My cloud team", origin: "https://bots.fixture.example" }] };
  let menuChoice = "workspace-connect";
  let forgetConfirmed = false;
  ipcMain.handle("companion:state", () => ({ running: false, enabled: false, devices: [], bind: null, publicUrl: null }));
  ipcMain.handle("desktop:capabilities", () => createRequire(import.meta.url)("../electron/capabilities.cjs").desktopCapabilities({ platform: process.platform }));
  const chooseWorkspace = (id) => { calls.push({ kind: "switch", id }); saved = withActive(saved, id); };
  ipcMain.handle("environments:state", () => ({ ...saved, localOrigin: new URL(url).origin, remote: false }));
  ipcMain.handle("environments:switch", (_event, id) => chooseWorkspace(id));
  ipcMain.handle("environments:forget", (_event, id) => {
    calls.push({ kind: "forget", id, confirmed: forgetConfirmed });
    if (forgetConfirmed) saved = withoutEnvironment(saved, id);
  });
  ipcMain.handle("workspaces:state", () => workspaceSummary(saved));
  ipcMain.handle("workspaces:menu", (event) => {
    const menu = Menu.buildFromTemplate(workspaceMenuTemplate(saved, {
      onSwitch: chooseWorkspace,
      onConnect: () => event.sender.send("workspaces:open-settings"),
      onForget: () => {},
    }));
    // Select the production native MenuItem; no fixture-only renderer dropdown.
    menu.getMenuItemById(menuChoice).click();
  });
  ipcMain.handle("desktop-remote:state", () => ({ active: false }));
  // Electron 43 leaves a sendSync with no listener unanswered, which freezes the page.
  for (const channel of ["desktop-language:read", "workspaces:switch-arrived", "workspaces:switch-look-take"]) ipcMain.on(channel, (event) => { event.returnValue = null; });
  ipcMain.handle("workspaces:look", () => null);
  ipcMain.handle("rail:draws-frame", () => false);
  ipcMain.handle("workspaces:places", () => ({ places: [], add: { cloud: false, link: false, address: false, organization: false } }));
  ipcMain.handle("desktop-remote:pair", (_event, endpoint, code) => {
    calls.push({ kind: "companion", endpoint, code });
    throw new Error("Fixture companion pairing rejected");
  });
  ipcMain.handle("environments:add-from-link", (_event, link, name) => {
    const parsed = parseHostedWorkspaceLink(link);
    if (!parsed) throw new Error("Enter an HTTPS server address or a full pairing link.");
    calls.push({ kind: "server", link, ...(name === undefined ? {} : { name }) });
    return new Promise((resolve, reject) => { pending = { reject, resolve: (confirmed) => {
      if (confirmed) saved = withEnvironment(saved, { origin: parsed.origin, name }, () => "new-cloud");
      resolve(confirmed);
    } }; });
  });

  app.whenReady().then(async () => {
    const blockedRequests = [];
    session.defaultSession.webRequest.onBeforeRequest((request, callback) => {
      const target = new URL(request.url);
      const allowed = target.host === new URL(url).host || target.origin === serverUrl;
      if (!allowed) blockedRequests.push(target.origin);
      callback({ cancel: !allowed });
    });
    const open = async (local) => {
      const win = new BrowserWindow({
        show: false, width: 720, height: 650,
        webPreferences: {
          preload: join(root, "electron/preload.cjs"), contextIsolation: true,
          sandbox: true, nodeIntegration: false,
          additionalArguments: [`--dusk-local-origin=${local ? new URL(url).origin : "https://remote-fixture.invalid"}`],
        },
      });
      win.webContents.on("console-message", (event) => { if (event.level === "error") console.error(event.message, event.sourceId, event.lineNumber); });
      await win.loadURL(url);
      return win;
    };
    const win = await open(true);
    const evaluate = (code) => win.webContents.executeJavaScript(code);
    const until = async (check, description) => {
      for (let attempt = 0; attempt < 300; attempt++) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      writeFileSync(join(output, "failure.png"), (await win.webContents.capturePage()).toPNG());
      console.error(await evaluate("document.body.innerText"));
      throw new Error(`Timed out: ${description}`);
    };
    const button = (label) => `[...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(label)})`;
    const input = (label) => `[...document.querySelectorAll('label')].find(el => el.textContent.trim() === ${JSON.stringify(label)})?.querySelector('input')`;
    const fill = async (label, value) => {
      await evaluate(`(() => { const el = ${input(label)}; if (!el) throw new Error('Missing input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    };
    const pairRow = `document.querySelector('[data-settings-open="companion-pair"]')`;
    await until(() => evaluate(`Boolean(${pairRow})`), "companion pairing row rendered");
    await evaluate(`${pairRow}.click()`);
    await until(() => evaluate(`Boolean(${input("Companion address")})`), "companion form rendered");
    const pair = button("Pair and switch to client mode");
    assert.equal(await evaluate(`${pair}.disabled`), true);
    await fill("Companion address", "computer.tailnet.ts.net");
    await fill("Six-digit companion code", "12a34567");
    await until(() => evaluate(`${input("Six-digit companion code")}.value === '123456'`), "six-digit companion normalization");
    await evaluate(`${pair}.click()`);
    await until(() => calls.length === 1, "companion IPC received");
    assert.deepEqual(calls[0], { kind: "companion", endpoint: "computer.tailnet.ts.net", code: "123456" });
    await until(() => evaluate(`document.querySelector('[role=alert]')?.textContent === 'Fixture companion pairing rejected'`), "companion error rendered");
    await until(() => evaluate(`!${pair}.disabled`), "companion retry possible after rejection");
    writeFileSync(join(output, "companion-form.png"), (await win.webContents.capturePage()).toPNG());
    win.setSize(390, 700);
    await until(() => evaluate("innerWidth === 390"), "narrow companion viewport");
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, "narrow layout overflow");
    writeFileSync(join(output, "companion-form-narrow.png"), (await win.webContents.capturePage()).toPNG());

    win.setSize(780, 800);
    await win.loadURL(`${url}?workspaces=1`);
    const hostedConnect = button("Connect");
    const addressLabel = "Server address or pairing link";
    const connectRow = `document.querySelector('[data-settings-open="connect-server"]')`;
    const openConnect = async () => {
      await evaluate(`${connectRow}.click()`);
      await until(() => evaluate(`Boolean(${input(addressLabel)}) && Boolean(${hostedConnect})`), "connect dialog open");
    };
    await until(() => evaluate(`Boolean(${connectRow}) && document.body.textContent.includes('My cloud team')`), "hosted workspace settings rendered");
    await evaluate("void window.duskDesktop.environments.onOpenSettings(() => { document.body.dataset.settingsRequested = 'yes'; })");
    await evaluate("document.querySelector('[aria-label=\"Switch server: This computer\"]').click()");
    await until(() => evaluate("document.body.dataset.settingsRequested === 'yes'"), "native connect item requested Settings");
    assert.equal(saved.activeId, "local", "opening connection settings did not select a server");

    await openConnect();
    await fill(addressLabel, "http://unsafe.fixture.example");
    await evaluate(`${hostedConnect}.click()`);
    await until(() => evaluate("document.querySelector('[role=alert]')?.textContent === 'Enter an HTTPS server address or a full pairing link.'"), "invalid workspace input rejected visibly");
    await fill(addressLabel, "other.fixture.example");
    await fill("Name (optional)", "Research team");
    const beforeHosted = calls.length;
    await evaluate(`(() => { ${hostedConnect}.form.requestSubmit(); ${hostedConnect}.form.requestSubmit(); })()`);
    await until(() => calls.length === beforeHosted + 1, "one hosted submission in flight");
    assert.deepEqual(calls.at(-1), { kind: "server", link: "other.fixture.example", name: "Research team" });
    pending.resolve(false);
    await until(() => evaluate(`!${input(addressLabel)}`), "cancelled hosted confirmation closes the dialog");
    assert.equal(saved.environments.length, 1);
    await openConnect();
    assert.equal(await evaluate(`${input(addressLabel)}.value`), "other.fixture.example");

    await fill(addressLabel, "https://other.fixture.example/pair#code=MNOP-QRST-UVWX");
    await evaluate(`${hostedConnect}.click()`);
    await until(() => calls.length === beforeHosted + 2, "hosted retry received");
    pending.resolve(true);
    await until(() => saved.environments.length === 2, "named workspace saved");
    // Production navigates away after confirmation. Reload our local preview
    // instead, to inspect the saved list without contacting a public server.
    await win.loadURL(`${url}?workspaces=1`);
    await until(() => evaluate(`document.body.textContent.includes('Research team') && Boolean(${connectRow})`), "saved named workspace rendered");
    assert.deepEqual(saved.environments.map(({ origin }) => origin), ["https://bots.fixture.example", "https://other.fixture.example"]);
    assert.equal(JSON.stringify(saved).includes("MNOP"), false, "pairing secret not saved with workspace");
    writeFileSync(join(output, "connected-workspaces.png"), (await win.webContents.capturePage()).toPNG());

    await evaluate("document.querySelector('[aria-label=\"Switch to My cloud team\"]').click()");
    await until(() => saved.activeId === "cloud", "Settings switch selected saved workspace");
    menuChoice = "workspace-local";
    await evaluate("document.querySelector('[aria-label^=\"Switch server:\"]').click()");
    await until(() => saved.activeId === "local", "native menu switched back to local");
    await evaluate("document.querySelector('[aria-label=\"Forget Research team\"]').click()");
    await until(() => calls.at(-1)?.kind === "forget", "forget requested");
    assert.equal(saved.environments.length, 2, "cancel forget retains saved workspace");
    await until(() => evaluate("!document.querySelector('[aria-label=\"Forget Research team\"]').disabled"), "forget cancellation reset");
    forgetConfirmed = true;
    await evaluate("document.querySelector('[aria-label=\"Forget Research team\"]').click()");
    await until(() => evaluate("!document.body.textContent.includes('Research team')"), "confirmed forget removed only selected entry");
    assert.deepEqual(saved.environments.map(({ id }) => id), ["cloud"]);
    assert.equal(saved.activeId, "local");
    win.setSize(390, 800);
    await until(() => evaluate("innerWidth === 390"), "narrow workspace viewport");
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, "workspace narrow layout overflow");
    writeFileSync(join(output, "connected-workspaces-narrow.png"), (await win.webContents.capturePage()).toPNG());

    // Real app shell, Settings navigation and onboarding against a disposable
    // fake-engine server. Opening the page must not require local AI setup.
    // Connecting a server opens the guided setup; only sharing this computer with one lands on Settings.
    const serversSettings = `document.querySelector('[role=dialog] [data-settings-block="remote-client"]')`;
    win.setSize(1180, 850);
    await win.loadURL(`${url}?app=1&desktop-settings=workspaces&share-computer=1`);
    await until(() => evaluate(`Boolean(${serversSettings})`), "app opens top-level workspace Settings");
    assert.equal(await evaluate("location.search.includes('desktop-settings')"), false, "Settings deep link consumed");
    writeFileSync(join(output, "workspace-settings-in-app.png"), (await win.webContents.capturePage()).toPNG());
    await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await until(() => evaluate(`!${serversSettings}`), "Settings closes normally");
    win.webContents.send("workspaces:open-settings");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await evaluate(`!${serversSettings}`), true, "connecting a server does not open Settings");
    win.webContents.send("workspaces:open-settings", "fixture-computer");
    await until(() => evaluate(`Boolean(${serversSettings})`), "native share request reopens workspace Settings");

    const remote = await open(false);
    assert.deepEqual(await remote.webContents.executeJavaScript("({ server: typeof window.duskDesktop?.environments, companion: typeof window.duskDesktop?.remoteClient, node: typeof window.require, switcher: ['state', 'menu'].every((name) => typeof window.duskDesktop?.workspaces?.[name] === 'function') })"),
      { server: "undefined", companion: "undefined", node: "undefined", switcher: true });
    assert.deepEqual(blockedRequests, [], "unexpected external request attempted");
    // Exercise Chromium's actual HttpOnly cookie jar and main-process fetch.
    // The server is the isolated fake-engine fixture, never the user's app.
    const opened = await fetch(`${serverUrl}/api/auth/pairing`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "Electron fixture", scopes: ["client"] }) }).then(response => response.json());
    const paired = await session.defaultSession.fetch(`${serverUrl}/api/auth/pair`, { method: "POST", credentials: "include", headers: { "content-type": "application/json", origin: serverUrl }, body: JSON.stringify({ code: opened.code, cookie: true }) });
    assert.equal(paired.status, 200);
    const receipt = { passed: true, renderer: ["RemoteComputerSection", "ConnectedWorkspacesSettings", "DesktopWorkspaceSwitcher"], preload: "electron/preload.cjs", calls,
      checks: ["companion pairing row opens its form", "companion six-digit routing", "companion rejection shown, retry possible", "390px overflow", "one hosted submission in flight", "hosted cancel reset", "full hosted pairing link", "remote-safe bridge", "native connect menu item requests Settings", "hosted URL validation", "optional name", "pairing code excluded from saved list", "switch local/cloud", "cancel/confirm forget", "real app Settings deep link", "connect request opens no Settings", "native share request opens Settings"],
      limitation: "UI IPC replaces native dialogs, workspace persistence and navigation. No public DNS/TLS tested." };
    writeFileSync(join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(JSON.stringify(receipt));
    app.exit(0);
  }).catch((error) => {
    console.error(error);
    app.exit(1);
  });
} else {
  const { createServer } = await import("vite");
  const { default: react } = await import("@vitejs/plugin-react");
  const { default: tailwindcss } = await import("@tailwindcss/vite");
  const { launchVerificationServer } = await import("./control-dusk.ts");
  const fixture = await launchVerificationServer();
  const output = mkdtempSync(join(tmpdir(), "dusk-server-connection-"));
  for (const dir of ["home", "user-data"]) mkdirSync(join(output, dir));
  const ui = await createServer({
    // its own deps cache: the developer's running dev server keeps node_modules/.vite
    cacheDir: `${root}/.dusk-scratch/vite-server-connection`,
    configFile: false, root, resolve: { alias: { "@": join(root, "src") } },
    server: { host: "127.0.0.1", port: 0, proxy: { "/api": { target: fixture.info.url } } },
    plugins: [react(), tailwindcss(), {
      name: "server-connection-fixture",
      resolveId(id) { if (id === "virtual:server-connection") return `\0${id}`; },
      load(id) {
        if (id === "\0virtual:server-connection") return `import React from 'react'; import { createRoot } from 'react-dom/client'; import { setLocale } from '/src/lib/i18n.ts'; import { StoreProvider } from '/src/state/store.tsx'; import { RemoteComputerSection } from '/src/components/RemoteComputerSection.tsx'; import { ConnectedWorkspacesSettings } from '/src/components/ConnectedWorkspacesSettings.tsx'; import { DesktopWorkspaceSwitcher } from '/src/components/DesktopWorkspaceSwitcher.tsx'; import '/src/styles.css'; setLocale('en'); localStorage.setItem('dusk-analytics-opt-out', '1'); const root = createRoot(document.getElementById('root')); if (location.search.includes('app=1')) { document.body.classList.remove('p-4'); import('/src/App.tsx').then(({default: App}) => root.render(React.createElement(App))); } else root.render(React.createElement(StoreProvider, null, location.search.includes('workspaces=1') ? React.createElement('div', { className: 'flex flex-col gap-5 max-w-2xl mx-auto' }, React.createElement(DesktopWorkspaceSwitcher), React.createElement('h1', { className: 'text-lg font-semibold text-ink' }, 'Servers'), React.createElement(ConnectedWorkspacesSettings)) : React.createElement(RemoteComputerSection)));`;
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== "/__server-connection.html") return next();
          void server.transformIndexHtml(req.url, '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Isolated server connection verification</title></head><body class="bg-app p-4"><div id="root"></div><script type="module" src="/@id/virtual:server-connection"></script></body></html>')
            .then((html) => { res.setHeader("content-type", "text/html"); res.end(html); }).catch(next);
        });
      },
    }],
  });
  try {
    await ui.listen();
    const url = `${ui.resolvedUrls.local[0]}__server-connection.html`;
    console.log(JSON.stringify({ previewUrl: url, evidence: output }));
    const electron = createRequire(import.meta.url)("electron");
    const child = spawn(electron, [fileURLToPath(import.meta.url), fixtureFlag, url, output, fixture.info.url], {
      env: { PATH: process.env.PATH, HOME: join(output, "home"), XDG_CONFIG_HOME: join(output, "home"),
        TMPDIR: output, TEMP: output, TMP: output, DISPLAY: process.env.DISPLAY, SystemRoot: process.env.SystemRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => {
      appendFileSync(join(output, "electron.log"), data);
      process.stdout.write(data);
    });
    const stop = () => child.kill("SIGTERM");
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const timeout = setTimeout(stop, 180_000);
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); })
      .finally(() => { clearTimeout(timeout); process.off("SIGINT", stop); process.off("SIGTERM", stop); });
    assert.equal(code, 0, `Electron smoke failed; inspect ${join(output, "electron.log")}`);
    assert.equal(JSON.parse(readFileSync(join(output, "receipt.json"), "utf8")).passed, true, "Electron smoke ended without its receipt");
  } finally {
    await ui.close();
    await fixture.close();
    for (const dir of ["home", "user-data", "native-profile", "shared-folder"]) rmSync(join(output, dir), { recursive: true, force: true });
  }
}
