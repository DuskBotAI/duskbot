import { useEffect, useRef, useState } from "react";
import { useChrome } from "@/mobile/chrome";
import { useNativeTrail } from "@/mobile/native-push";
import type { ConnectAppsPage } from "./open";

/** The window's page and the pages under it. An app's page and Your apps go over the page they were opened from; on a
 * phone that pushes pages the system's way, the system slides them in and its back swipe takes them off. */
export function useConnectAppsNav(requested: ConnectAppsPage, nonce: number) {
  const [page, setPage] = useState<ConnectAppsPage>(requested);
  const [trail, setTrail] = useState<ConnectAppsPage[]>([]);
  const pageRef = useRef(page);
  pageRef.current = page;
  const [view, setView] = useState(0);
  // how the last page change went, so the new page slides in from the side it came from, as settings' panes do
  const [nav, setNav] = useState<"push" | "pop" | "swap" | null>(null);
  const nativeTrail = useNativeTrail<ConnectAppsPage>(useChrome(), (removed, remaining) => {
    setPage(removed[0]!);
    setTrail(remaining);
    setNav(null);
    setView((count) => count + 1);
  });
  // home and the categories share one pane, so the title, search and chips stay mounted while the list under them changes
  const browsing = page.kind === "home" || page.kind === "category";

  const opened = useRef({ requested, nonce });
  useEffect(() => {
    nativeTrail.clear();
    setPage(requested);
    setTrail([]);
    setNav(null);
    // a new open of a mounted window is a new view; the mount itself keeps the layout its first frame drew
    if (opened.current.requested === requested && opened.current.nonce === nonce) return;
    opened.current = { requested, nonce };
    setView((count) => count + 1);
  }, [requested, nonce, nativeTrail]);

  const go = (next: ConnectAppsPage) => {
    const isPush = next.kind === "detail" || next.kind === "yours";
    const pushedNatively = isPush && nativeTrail.push(() => pageRef.current, (prev, pushedTrail) => {
      setTrail(pushedTrail ?? ((past) => [...past, prev]));
      setNav(null);
      setPage(next);
      setView((count) => count + 1);
    });
    if (pushedNatively) return;
    if (!isPush) nativeTrail.clear();
    setTrail((past) => isPush ? [...past, page] : []);
    const staysBrowsing = browsing && (next.kind === "home" || next.kind === "category");
    setNav(isPush ? "push" : staysBrowsing ? null : "swap");
    setPage(next);
    setView((count) => count + 1);
  };
  const back = () => {
    if (nativeTrail.back()) return;
    setPage(trail.at(-1) ?? { kind: "home" });
    setTrail((past) => past.slice(0, -1));
    setNav("pop");
    setView((count) => count + 1);
  };

  return { page, trail, view, nav, browsing, go, back };
}
