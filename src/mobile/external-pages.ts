import { useEffect } from "react";
import { setExternalPages } from "@/lib/app-links";
import type { MobilePlatform } from "./platform";

/** Sign-in pages the shared flows open (an app's OAuth, an MCP server's sign-in, a vendor's key page) show in the phone's
 * in-app browser and close by themselves once the app is connected. A phone browser keeps its own tabs. */
export function useExternalPages(platform: MobilePlatform): void {
  useEffect(() => {
    if (!platform.native) return;
    setExternalPages({ open: (url) => platform.openExternal(url), close: () => platform.closeBrowser?.() });
    return () => setExternalPages(null);
  }, [platform]);
}
