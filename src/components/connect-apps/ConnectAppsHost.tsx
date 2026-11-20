import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { lazyScreen, TeamLibraryPanel } from "../lazy-screens";
import { phoneApp } from "@/lib/store-app";
import { warmTeamCatalog } from "@/lib/team-catalog-cache";
import { markTemplatesHandoff, openTemplates } from "../SidebarTemplates";
import { closeConnectApps, useConnectApps } from "./open";

const FIRST_FRAME_WAIT_MS = 600;
const IDLE_PREFETCH_MS = 4_000;
const ConnectAppsWindow = lazyScreen("ConnectAppsWindow", async () => {
  const screen = await import("./ConnectAppsWindow");
  await Promise.race([screen.prepareConnectApps(), new Promise((resolve) => setTimeout(resolve, FIRST_FRAME_WAIT_MS))]);
  return screen.ConnectAppsWindow;
});

const hosts: Array<(owns: boolean) => void> = [];
const settle = () => hosts.forEach((own, index) => own(index === 0));

/** Draws the Connect Apps window and the Bot templates it leads to. Mount it once, anywhere under the store; a second
 * host stays empty, so a button that carries one cannot open the window twice. */
export function ConnectAppsHost() {
  const { open, page, nonce } = useConnectApps();
  const [first, setFirst] = useState(false);
  const [templates, setTemplates] = useState(false);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    hosts.push(setFirst);
    settle();
    return () => {
      hosts.splice(hosts.indexOf(setFirst), 1);
      settle();
    };
  }, []);
  // read the catalog, the snapshot and what is connected once the app is idle after boot, so the first open is complete
  useEffect(() => {
    if (!first) return;
    if (typeof window.requestIdleCallback === "function") {
      const idle = window.requestIdleCallback(preloadConnectApps, { timeout: IDLE_PREFETCH_MS });
      return () => window.cancelIdleCallback(idle);
    }
    const timer = setTimeout(preloadConnectApps, IDLE_PREFETCH_MS);
    return () => clearTimeout(timer);
  }, [first]);
  if (!first) return null;
  const portalRoot = phoneApp() ? (document.querySelector?.(".dusk-mobile") ?? document.body) : document.body;
  return (
    <>
      {open && createPortal(
        <ConnectAppsWindow page={page} nonce={nonce} onClose={closeConnectApps} onTemplates={() => { closeConnectApps(); if (!openTemplates(true)) { markTemplatesHandoff(); setTemplates(true); } }} />,
        portalRoot,
      )}
      {templates && (
        <TeamLibraryPanel returnFocusRef={back} onClose={() => setTemplates(false)} onImported={() => setTemplates(false)} />
      )}
    </>
  );
}

export function preloadConnectApps(): void {
  void ConnectAppsWindow.preload().catch(() => {});
  // the Templates button swaps this window for it in one commit, so its code and list are already here
  void TeamLibraryPanel.preload().catch(() => {});
  warmTeamCatalog();
}
