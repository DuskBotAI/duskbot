import { useEffect, useState } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";

import { loadAppCards } from "./bot-settings/useBotApps";
import { preloadConnectedApps } from "@/lib/connected-apps";
import { ServiceTile, type TileArt, type ToolkitCard } from "./ServiceIcon";
import { appLogo } from "./connect-apps/logos";
import notionMark from "@/assets/notion-mark.svg";
import { Icon } from "./Icon";
import { GROK_FOCUS, GROK_HOVER_TINT, SIMPLE_TOP_BUTTON } from "./SidebarSimpleTop";
import { ConnectAppsHost, openConnectApps, preloadConnectApps, useConnectApps } from "./connect-apps";

export type AppFace = Pick<ToolkitCard, "slug" | "label" | "logo" | "domain"> & Pick<TileArt, "image" | "padded" | "background" | "scale">;

/** The three apps the footer shows before anything is connected, each in its own colours. */
export const POPULAR_APPS: readonly AppFace[] = [
  { slug: "gmail", label: "Gmail", logo: null, domain: "mail.google.com" },
  { slug: "notion", label: "Notion", logo: null, domain: "notion.so" },
  { slug: "slack", label: "Slack", logo: null, domain: "slack.com" },
];

/** After those, the popular apps that take a connected one's place, in order. */
const MORE_APPS: readonly AppFace[] = [
  { slug: "figma", label: "Figma", logo: null, domain: "figma.com" },
  { slug: "linear", label: "Linear", logo: null, domain: "linear.app" },
  { slug: "github", label: "GitHub", logo: null, domain: "github.com" },
  { slug: "googledrive", label: "Google Drive", logo: "https://ssl.gstatic.com/images/branding/product/2x/drive_2020q4_48dp.png", domain: "drive.google.com" },
  { slug: "googlecalendar", label: "Google Calendar", logo: "https://ssl.gstatic.com/calendar/images/dynamiclogo_2020q4/calendar_31_2x.png", domain: "calendar.google.com" },
];

export const APP_FACES = 3;
/** Grok folds its footer pill to the grid button once this many apps are connected (its min_connected_apps). */
export const FOLD_AT = 4;

/** Grok's footer logos: its featured apps that are not connected yet, in its order, three at most, on grok's own art. */
export function appFaces(connected: readonly string[], cards: ReadonlyMap<string, AppFace>): AppFace[] {
  const taken = new Set(connected);
  return [...POPULAR_APPS, ...MORE_APPS].filter((app) => !taken.has(app.slug)).slice(0, APP_FACES).map((app) => {
    const card = cards.get(app.slug);
    const art = appLogo(app.slug, app.label);
    return { ...app, ...(card?.logo ? { logo: card.logo } : {}), ...(art ? { image: art.src, padded: art.padded, background: art.background, scale: art.scale } : { padded: true, scale: 0.62 }) };
  });
}

export interface SidebarApps {
  faces: AppFace[];
  /** enough apps are connected that grok folds the footer pill to its grid button */
  connected: boolean;
}

export function useSidebarApps(): SidebarApps {
  const { state } = useStore();
  const window = useConnectApps().open;
  const [apps, setApps] = useState<SidebarApps>(() => ({ faces: appFaces([], new Map()), connected: false }));
  useEffect(() => {
    if (state.pluginsOpen || window) return;
    let alive = true;
    void preloadConnectedApps()
      .then(async (inventory) => {
        const connected = Object.entries(inventory.services).filter(([, status]) => status.connected).map(([slug]) => slug).sort();
        const cards = await loadAppCards().catch(() => new Map<string, AppFace>());
        if (alive) setApps({ faces: appFaces(connected, cards), connected: connected.length >= FOLD_AT });
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [state.pluginsOpen, window]);
  return apps;
}

/**
 * A bare mark's share of the 20px tile so it reads the same size as a whole tile's mark: a tile draws at 18px with its
 * mark 36/64 of it (scripts/gen-app-logos.mjs), so about 10px.
 */
export const BARE_MARK_SCALE = (18 / 20) * (36 / 64);

/** Black marks whose tile is a white plate: drawn bare in the ink colour instead, so they read in either theme. */
const INK_MARKS: Readonly<Record<string, string>> = { notion: notionMark };

/** The footer logo: the 20px app tile on a 22px square of the page's own surface, 6px round, so overlapping tiles read apart in either theme. */
function AppFaceIcon({ face, className }: { face: AppFace; className?: string }) {
  const ink = INK_MARKS[face.slug];
  const mark = 20 * BARE_MARK_SCALE;
  return (
    <span data-app-face={face.slug} className={cn("flex size-[22px] shrink-0 items-center justify-center rounded-[7px] bg-composer p-px", className)}>
      {ink
        ? <span className="flex size-5 items-center justify-center"><span data-ink-mark="" className="bg-ink" style={{ width: mark, height: mark, maskImage: `url("${ink}")`, maskSize: "contain", maskRepeat: "no-repeat", maskPosition: "center" }} /></span>
        : <ServiceTile card={{ ...face, scale: face.scale ?? BARE_MARK_SCALE }} size={20} />}
    </span>
  );
}


/** `circle` is the collapsed rail's round button. */
export function SidebarConnectApps({ circle = false }: { circle?: boolean }) {
  return <ConnectAppsButton circle={circle} apps={useSidebarApps()} />;
}

/** The button for apps already read by its caller, as the footer does to fold it to a circle once one is connected. */
export function ConnectAppsButton({ circle, apps: { faces }, engaged = false, onEngage }: {
  circle: boolean; apps: SidebarApps;
  /** grok's folded footer button: under the pointer or focus it widens into the Connect apps pill */
  engaged?: boolean; onEngage?: (engaged: boolean) => void;
}) {
  const open = useConnectApps().open;
  const label = t("sidebar.connectApps");
  // only the footer's folded button widens; the rail's stays a glyph
  const logos = circle && onEngage ? faces : [];
  return (
    <>
    <button
      type="button"
      data-tour="nav-apps"
      data-sidebar-nav="apps"
      aria-pressed={circle ? undefined : open}
      aria-label={circle ? t("sidebar.connectApps") : undefined}
      onPointerEnter={() => { preloadConnectApps(); onEngage?.(true); }}
      onFocus={(event) => { preloadConnectApps(); if (event.currentTarget.matches(":focus-visible")) onEngage?.(true); }}
      onBlur={() => onEngage?.(false)}
      onClick={() => openConnectApps()}
      // grok's folded pill is a 36px circle (its basis), and widens to its content: 16/12 in, 12/9 beside the logos
      className={circle ? cn(SIMPLE_TOP_BUTTON, "group/apps h-10 min-w-10 w-auto shrink text-[14px] font-medium leading-5 text-ink transition-[flex-grow,padding] duration-300 ease-[cubic-bezier(.2,0,0,1)] motion-reduce:transition-none",
        engaged ? cn("grow basis-auto", logos.length ? "ps-3 pe-[9px]" : "ps-4 pe-3") : "grow-0 basis-10 px-2")
        : cn("group/apps flex h-9 min-w-0 flex-1 items-center justify-center rounded-full border border-ink/[0.08] bg-composer ps-3.5 text-[13px] font-medium leading-5 tracking-[0.01em] text-ink", faces.length ? "pe-3" : "pe-4", GROK_HOVER_TINT, GROK_FOCUS)}
    >
      {circle ? <>
        {/* grok's widened pill trades the grid glyph for the label and the app logos */}
        <span aria-hidden="true" data-connect-apps-icon="" className={cn("flex h-5 shrink-0 items-center justify-center overflow-hidden transition-[max-width,opacity] duration-300 ease-[cubic-bezier(.2,0,0,1)] motion-reduce:transition-none",
          engaged && logos.length ? "max-w-0 opacity-0" : "w-5 max-w-5 opacity-100")}><Icon name="grid-plus" size={16} /></span>
        <span aria-hidden="true" data-connect-apps-label="" className={cn("min-w-0 overflow-hidden whitespace-nowrap transition-[max-width,opacity,margin] duration-300 ease-[cubic-bezier(.2,0,0,1)] motion-reduce:transition-none",
          engaged ? cn(!logos.length && "ms-1.5", "max-w-[200px] opacity-100 [transition-duration:300ms,150ms,300ms] [transition-delay:0ms,120ms,0ms]") : "ms-0 max-w-0 opacity-0")}>{t("sidebar.connectApps")}</span>
        {/* grok's strip beside the widened label: 36px of the logos, painting 5px past its edge */}
        {logos.length > 0 && <span aria-hidden="true" data-connect-apps-faces="" className={cn("flex shrink-0 items-center [overflow-clip-margin:5px] [overflow:clip] transition-[max-width,opacity,margin] duration-300 ease-[cubic-bezier(.2,0,0,1)] motion-reduce:transition-none",
          engaged ? "ms-1.5 w-9 max-w-9 opacity-100" : "ms-0 w-9 max-w-0 opacity-0")}>
          {logos.map((face, index) => <AppFaceIcon key={face.slug} face={face} className={cn(index > 0 && "-ms-[6px]")} />)}
        </span>}
      </> : <>
        <span className="min-w-0 truncate">{label}</span>
        <span aria-hidden="true" className="ms-1.5 flex shrink-0 items-center">
          {faces.map((face, index) => <AppFaceIcon key={face.slug} face={face} className={cn(index > 0 && "-ms-[6px]")} />)}
        </span>
      </>}
    </button>
    <ConnectAppsHost />
    </>
  );
}
