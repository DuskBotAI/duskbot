import { Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { lazyScreen, TeamLibraryPanel } from "../lazy-screens";
import { phoneApp } from "@/lib/store-app";
import { warmTeamCatalog } from "@/lib/team-catalog-cache";
import { sheetsUp } from "@/mobile/chrome";
import { Sheet } from "@/mobile/Sheet";
import { SheetPush } from "@/mobile/SheetPush";
import { markTemplatesHandoff, openTemplates } from "../SidebarTemplates";
import { closeConnectApps, useConnectApps, type ConnectAppsPage } from "./open";

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
  const lastOpen = useRef<{ page: ConnectAppsPage; nonce: number } | null>(null);
  const prevOpen = useRef(false);
  const phoneMode = useRef<"push" | "sheet">("sheet");
  const phone = phoneApp();
  if (open) {
    lastOpen.current = { page, nonce };
    if (phone && !prevOpen.current) {
      const sheetVisible = sheetsUp.count > 0 || sheetsUp.system || Boolean(document.querySelector(".mobile-sheet-layer"));
      phoneMode.current = sheetVisible ? "push" : "sheet";
    }
  }
  prevOpen.current = open;
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
  const openTemplatesWindow = () => {
    closeConnectApps();
    if (!openTemplates(true)) { markTemplatesHandoff(); setTemplates(true); }
  };
  const shown = open ? { page, nonce } : lastOpen.current;
  const phoneWindow = shown && (
    <Suspense fallback={<div className="h-full w-full bg-(--m-sheet-page)" />}>
      <ConnectAppsWindow page={shown.page} nonce={shown.nonce} onClose={closeConnectApps} onTemplates={openTemplatesWindow} />
    </Suspense>
  );
  return (
    <>
      {phone ? (
        shown && (phoneMode.current === "push" ? (
          <SheetPush open={open} onClose={closeConnectApps} bare flush>
            {phoneWindow}
          </SheetPush>
        ) : (
          <Sheet open={open} onClose={closeConnectApps} full flush bodyClassName="overflow-hidden pt-0! pb-0">
            {phoneWindow}
          </Sheet>
        ))
      ) : open && createPortal(
        <ConnectAppsWindow page={page} nonce={nonce} onClose={closeConnectApps} onTemplates={openTemplatesWindow} />,
        document.body,
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
