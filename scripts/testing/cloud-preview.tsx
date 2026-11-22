import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { LocalComputerSection } from "../../src/components/LocalComputerSection";
import { ComputerPanel } from "../../src/components/ComputerPanel";
import { BotSettingsDialog } from "../../src/components/BotSettingsDialog";
import { SubPageContext } from "../../src/components/ListRows";
import { StoreProvider, useStore, type Bot } from "../../src/state/store";
import { rememberComputerPanelOpen } from "../../src/lib/computer-panel-focus";
import { applySkin, readSkin } from "../../src/lib/skins";
import { publishLiveFrame } from "../../src/lib/live-events";
import { CLOUD_COMPUTER_BUSY_ERROR } from "../../shared/computer-contention";
import "../../src/styles.css";
import "../../src/styles/overlays.css";
import "../../src/styles/motion.css";

function frame(label: string, color: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 400;
  const context = canvas.getContext("2d")!;
  context.fillStyle = color;
  context.fillRect(0, 0, 640, 400);
  context.fillStyle = "white";
  context.font = "28px sans-serif";
  context.fillText(label, 70, 210);
  return canvas.toDataURL("image/png").split(",")[1];
}
const screenshot = frame("Cloud screen connected", "#134e4a");
const vmScreenshot = `data:image/png;base64,${frame("Local VM connected", "#1e3a8a")}`;
let mode = "connected";
let surfaceScenario = "default";
let vmRunning = false;
let vmDesktopReady = false;
const vmResumeStatus = () => ({
  platform: "linux", runtime: "docker", available: ["docker"], mode: "shared", daemonUp: true,
  image: true, create_supported: true, container: vmRunning ? "running" : "stopped", resumable: !vmRunning,
  imageMatches: true, managed: true, network: "loopback", security: "hardened", persistence: "durable",
  desktopReady: vmDesktopReady, ready: vmDesktopReady, stop_reason: vmRunning ? null : "idle",
  problem: vmDesktopReady ? null : vmRunning ? "Desktop is starting" : "The Local VM is stopped",
  viewer_url: "http://127.0.0.1/fixture-viewer", idle_timeout_ms: 480 * 60_000, max_instances: 2,
  commands: {}, workspace_path: "/fixture/workspace", workspace_guest_path: "/home/cua/workspace",
});
// A host capture outlives an aborted renderer fetch. Keep this work pending
// until explicitly released, so reconnects exercise real lifecycle contention.
const transport = {
  documentId: crypto.randomUUID(),
  resetVm: () => { vmRunning = false; vmDesktopReady = false; }, vmStarts: 0, vmReadinessReads: 0, requests: 0, aborted: 0, conflicts: 0, capturing: false,
  controlCalls: 0,
  releaseCapture: () => {},
  screenshot: `data:image/png;base64,${screenshot}`,
  vmScreenshot, paths: [] as string[], vmRequests: 0, vmPending: false, releaseVm: () => {},
};
Object.assign(window, { cloudPreviewFixture: transport });
let turnActive = false;
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const requested = typeof input === "string" ? input : "";
  const path = requested.split("?")[0];
  if (path.includes("/computer") || path.includes("/local-computer")) transport.paths.push(requested);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
  if (/^\/api\/bots\/[\w-]+\/computer$/.test(path)) return json({ surface: surfaceScenario === "auto-vm" ? "vm" : "cloud", backend: "vps", configured: true, ready: true, managed: true, imageMatches: true, container: "running", problem: null });
  if (path.endsWith("/local-computer/start")) {
    transport.vmStarts++;
    vmRunning = true;
    return json(vmResumeStatus());
  }
  if (path.endsWith("/local-computer") && surfaceScenario === "vm-stopped") {
    if (vmRunning && !vmDesktopReady) transport.vmReadinessReads++;
    return json(vmResumeStatus());
  }
  if (path.endsWith("/local-computer")) return json({ daemonUp: true, mode: "per-bot", max_instances: 2, image: true, create_supported: true,
    container: "running", imageMatches: true, managed: true, network: "loopback", security: "hardened", persistence: "durable",
    desktopReady: true, ready: true, problem: null, viewer_url: "http://127.0.0.1/fixture-viewer" });
  if (path.endsWith("/local-computer/screenshot")) {
    transport.vmRequests++;
    if (mode === "held") {
      transport.vmPending = true;
      // Deliberately finish even after cancellation to prove an old frame
      // cannot replace the next conversation's preview.
      await new Promise<void>((resolve) => { transport.releaseVm = () => { transport.vmPending = false; resolve(); }; });
    }
    return json({ image: vmScreenshot });
  }
  // the real server refuses provision/sleep while a turn owns the cloud desktop.
  if (path.endsWith("/computer/provision")) {
    if (turnActive) return json({ error: CLOUD_COMPUTER_BUSY_ERROR }, 409);
    return json({ configured: true, ready: true, managed: true, imageMatches: true, container: "running", problem: null });
  }
  if (path.endsWith("/computer/screenshot")) {
    transport.requests++;
    const selectedMode = mode;
    if (transport.capturing || selectedMode === "contended") {
      transport.conflicts++;
      return json({ error: "this bot's cloud computer is being changed: wait for it to finish" }, 409);
    }
    if (selectedMode === "held") {
      transport.capturing = true;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { transport.aborted++; reject(init?.signal?.reason); };
        transport.releaseCapture = () => {
          transport.capturing = false;
          init?.signal?.removeEventListener("abort", abort);
          resolve();
        };
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
      return json({ png: frame("Released old capture", "#881337"), format: "png" });
    }
    if (selectedMode === "slow" || selectedMode === "timeout") {
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(init?.signal?.reason); };
        const timer = setTimeout(() => {
          init?.signal?.removeEventListener("abort", abort);
          resolve();
        }, selectedMode === "slow" ? 12_000 : 120_000);
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (selectedMode === "failed") return json({ error: "The computer is temporarily unavailable" }, 503);
    if (selectedMode === "unconfigured") return json({ error: "VPS is not configured" }, 409);
    return json({ png: selectedMode === "corrupt" ? "bm90IGFuIGltYWdl" : screenshot, format: "png" });
  }
  if (path.endsWith("/computer/control") && init?.method === "POST") {
    transport.controlCalls++;
    return json({ held: JSON.parse(String(init.body)).action === "take", helpReason: null });
  }
  if (path.endsWith("/computer/join") || path.startsWith("/api/desktop-viewer/")) {
    return json({ error: "This fixture exercises screenshot fallback" }, 409);
  }
  // Never allow the fixture's lifecycle actions to reach a real provider.
  if (path.endsWith("/computer/sleep")) {
    return json({ error: "This fixture tests previews only" }, 409);
  }
  return originalFetch(input, init);
};

function SettingsPane() {
  const [at, setAt] = useState<string | undefined>();
  return <SubPageContext.Provider value={{ at, open: (id) => setAt(id), back: () => setAt(undefined) }}>
    <LocalComputerSection />
  </SubPageContext.Provider>;
}

function Fixture() {
  const { state, dispatch } = useStore();
  const bot = state.bots[0];
  const [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [panel, setPanel] = useState("computer");
  // the app has no separate screen panel any more: this harness alone still mounts ComputerPanel outside the bot panel,
  // so its close button, a no-op in the app's store, closes it here
  const [panelOpen, setPanelOpen] = useState(false);
  const [scenario, setScenario] = useState("default");
  useEffect(() => {
    if (bot) {
      dispatch({ type: "updateBot", botId: bot.id, patch: { computer: "cloud", cloudBackend: "vps" } });
      setPanelOpen(true);
    }
  }, [bot?.id, dispatch]);
  // the store keeps no open state for a panel mounted outside the bot panel, so its close button closes it here, after
  // the panel's own handler has handed focus back
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-computer-panel-close]")) setPanelOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);
  useEffect(() => {
    if (state.config && state.config.features?.browser !== true) {
      dispatch({ type: "configStatus", config: { ...state.config, features: { ...state.config.features, browser: true },
        browserEngine: { kind: "unavailable", installable: true } } });
    }
  }, [state.config, dispatch]);
  const fixtureBot: Bot | undefined = bot && (scenario === "default"
    ? { ...bot, busy, tasks: bot.tasks?.map((task) => ({ ...task, busy })) }
    : { ...bot, busy: false, browser: true,
      computer: scenario === "vm-stopped" ? "vm" : scenario === "auto-vm" ? undefined : scenario === "cloud-pin" ? "local" : scenario === "off" ? "off" : "cloud",
      modelSelection: scenario === "vm-pin" ? { ...bot.modelSelection, instanceId: "unavailable-profile-engine" } : bot.modelSelection,
      threadId: `fixture-${scenario}`,
      tasks: [{ threadId: `fixture-${scenario}`, title: scenario, createdAt: 1, busy: false, modelSelection: bot.modelSelection,
        ...(scenario === "auto-vm" ? {} : { surface: scenario === "browser-pin" ? "browser" : scenario === "cloud-pin" ? "cloud" : "vm" }) }],
    });
  return <div className="flex h-screen justify-center" onClick={(event) => {
    if ((event.target as Element).closest("[data-computer-panel-close]")) setPanelOpen(false);
  }}>
    <div className="fixed left-2 top-2 grid max-w-32 gap-3 text-sm">
      <label>Screenshot response<select aria-label="Screenshot response" defaultValue={mode} onChange={(e) => { mode = e.target.value; }}>
        {["connected", "slow", "held", "contended", "failed", "unconfigured", "corrupt", "timeout"].map((value) => <option key={value}>{value}</option>)}
      </select></label>
      <label>Panel<select aria-label="Panel" value={panel} onChange={(event) => setPanel(event.target.value)}>
        <option value="computer">Computer</option><option value="settings">VM settings</option>
      </select></label>
      {/* Stays mounted while the panel is up, like the chat header's own button. */}
      <button onClick={(event) => {
        if (fixtureBot) rememberComputerPanelOpen({ botId: fixtureBot.id, opener: event.currentTarget, tabs: event.detail === 0 });
        setPanelOpen(true);
      }}>Open computer panel</button>
      <label>Conversation<select aria-label="Conversation surface" value={scenario} onChange={(event) => {
        const previousScenario = surfaceScenario;
        surfaceScenario = event.target.value; vmRunning = false; vmDesktopReady = false;
        if (bot && (surfaceScenario === "vm-stopped" || previousScenario === "vm-stopped")) {
          dispatch({ type: "updateBot", botId: bot.id, patch: { computer: surfaceScenario === "vm-stopped" ? "vm" : "cloud" } });
        }
        setScenario(surfaceScenario);
      }}>
        {["default", "vm-stopped", "vm-pin", "auto-vm", "cloud-pin", "browser-pin", "off"].map((value) => <option key={value}>{value}</option>)}
      </select></label>
      <button onClick={() => setGeneration((n) => n + 1)}>Reconnect panel</button>
      <button onClick={() => { turnActive = !busy; setBusy(!busy); }}>Busy: {String(busy)}</button>
      <button onClick={() => transport.releaseCapture()}>Release held capture</button>
      <button onClick={() => transport.releaseVm()}>Release VM capture</button>
      <button onClick={() => { vmDesktopReady = true; }}>Finish VM startup</button>
      <button disabled={!fixtureBot} onClick={() => fixtureBot && publishLiveFrame({
        kind: "screen", botId: fixtureBot.id, threadId: fixtureBot.threadId, png: frame("New live frame", "#312e81"), mime: "image/png",
      })}>Publish live frame</button>
    </div>
    {state.settingsOpen && bot && <BotSettingsDialog key={bot.id} bot={bot} />}
    {panelOpen && fixtureBot && (panel === "computer"
      ? <ComputerPanel key={generation} bot={fixtureBot} />
      : <div className="w-[720px] overflow-y-auto"><SettingsPane /></div>)}
  </div>;
}
applySkin(readSkin());
createRoot(document.getElementById("root")!).render(<StoreProvider><Fixture /></StoreProvider>);
