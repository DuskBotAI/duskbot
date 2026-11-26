import { useCallback, useEffect, useState } from "react";

import { cloudAsleep, cloudPaused, onCloudPower } from "@/lib/cloud-power";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";

import { endCloudHowTo, openServerMenu, useWorkspacePlace } from "./DesktopWorkspaceSwitcher";
import { Icon, type IconName } from "./Icon";
import { SidebarPopoverMenu, type SidebarMenuItem } from "./SidebarPopoverMenu";
import { RECONNECTING_AFTER_MS } from "./LiveConnectionStrip";
import { SIMPLE_TOP_BUTTON } from "./SidebarSimpleTop";

export type PlaceKind = "computer" | "cloud" | "server";
export type PlaceStatus = "online" | "asleep" | "offline";

export function placeKind(current: { local: boolean; home?: boolean; role?: string } | null, { cloudHome = false, team = false } = {}): PlaceKind {
  if (current?.local !== false) return cloudHome && !current ? "cloud" : "computer";
  return cloudHome || team || current.home || current.role ? "cloud" : "server";
}

const ICON = { computer: "laptop", cloud: "cloud", server: "server" } as const;
const DOT = { online: "bg-success", asleep: "bg-ink-tertiary", offline: "bg-danger" } as const;
const WORD = { online: "slack.state.online", asleep: "runsOn.status.asleep", offline: "runsOn.status.offline" } as const;

const DOT_SEEN = "dusk-place-dot-seen";
/** The green "online" dot shows until the person has opened the list of places once; a grey or red one always shows. */
export function placeDotSeen(): boolean {
  try { return localStorage.getItem(DOT_SEEN) === "1"; } catch { return false; }
}
function markPlaceDotSeen(): void {
  try { localStorage.setItem(DOT_SEEN, "1"); } catch { /* storage off: seen for this page only */ }
}

export function usePlaceStatus(waking: boolean): PlaceStatus {
  const { state } = useStore();
  const [paused, setPaused] = useState(cloudPaused);
  const [late, setLate] = useState(false);
  const [network, setNetwork] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false);
  useEffect(() => onCloudPower(() => setPaused(cloudPaused())), []);
  useEffect(() => {
    const on = () => setNetwork(true), off = () => setNetwork(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);
  const down = state.hydrated === true && !state.connected;
  useEffect(() => {
    setLate(false);
    if (!down) return;
    const timer = setTimeout(() => setLate(true), RECONNECTING_AFTER_MS);
    return () => clearTimeout(timer);
  }, [down]);
  // only the owner's own pause reads as asleep; a sleep we chose to save cost reads live, and its wake is quiet
  if (paused) return "asleep";
  if (waking) return "online";
  return !network || (down && late && !cloudAsleep()) ? "offline" : "online";
}

export function switchPlaceCommand(): (() => void) | null {
  const bridge = typeof window === "undefined" ? undefined : window.duskDesktop?.workspaces;
  return bridge ? () => void openServerMenu(bridge).catch(() => {}) : null;
}

/** Security: on a page a server connected by hand may have written, the list of places is main's native menu and the page
 * learns only the place it is on (cloud-rail.mjs); only this app's own page draws the list itself (PlaceMenu). */
export function SidebarPlaceButton() {
  const { state, dispatch } = useStore();
  const cloudHome = state.config?.cloudHome === true;
  const place = useWorkspacePlace({ cloudHome, howTo: state.cloudHowTo, onMenuClosed: () => endCloudHowTo(dispatch) });
  const status = usePlaceStatus(place.waking !== "");
  const [seen, setSeen] = useState(placeDotSeen);
  if (!place.bridge) return null;
  const openMenu = () => { if (!seen) { markPlaceDotSeen(); setSeen(true); } place.openMenu(); };
  const dot = status !== "online" || !seen;
  const kind = placeKind(place.current, { cloudHome, team: Boolean(state.config?.team) });
  const name = place.current?.name ?? (cloudHome ? state.config?.team?.name || t("cloudSetup.myCloud") : t("rail.thisComputer"));
  const said = `${name} · ${t(WORD[status])}${place.onLine ? ` · ${place.onLine}` : ""}`;
  const title = place.current?.origin ? `${said} · ${place.current.origin}` : said;
  const face = <>
    <Icon name={ICON[kind]} size={16} />
    {dot && <span aria-hidden="true" data-place-dot className={cn("absolute right-[7px] top-[7px] size-[7px] rounded-full", DOT[status])} />}
  </>;
  if (place.bridge.menuRows && place.bridge.menuPick) {
    return <div data-sidebar-place data-place-kind={kind} data-place-status={status} className="relative flex">
      <PlaceMenu rows={place.bridge.menuRows} pick={place.bridge.menuPick} label={t("sidebar.switchServer", { name: said })} title={title}
        onOpen={() => { if (!seen) { markPlaceDotSeen(); setSeen(true); } }} face={face} />
    </div>;
  }
  const button = <div data-sidebar-place className="relative flex">
    <button type="button" data-tour="server-switcher" data-place-kind={kind} data-place-status={status}
      aria-label={t("sidebar.switchServer", { name: said })} aria-haspopup="menu" aria-expanded={place.open}
      title={title} onClick={openMenu} className={cn(SIMPLE_TOP_BUTTON, "relative")}>
      {face}
    </button>
    {place.error && <p role="alert" className="absolute right-0 top-full z-40 mt-1.5 w-56 rounded-md bg-menu px-2 py-1 text-[11px] text-danger shadow-lg">{place.error}</p>}
  </div>;
  return button;
}

/** Glyphs for main's action rows, so every row's label starts on one edge beside the places' own icons. */
const ACTION_ICON: Record<string, IconName> = {
  "workspace-places": "info", "workspace-copy-to-cloud": "copy", "workspace-cloud-move": "cloud", "workspace-add-cloud": "cloud",
  "workspace-connect": "plus", "workspace-forget": "trash",
};

/** Main's list of places as menu rows: a separator becomes a gap before the next row, a place keeps its kind's icon and a
 * check on the one on screen, and a line main serves to read (no id, or disabled) cannot be picked. */
export function placeMenuItems(rows: WorkspaceMenuRow[], pick: (id: string) => Promise<void>): SidebarMenuItem[] {
  const items: SidebarMenuItem[] = [];
  let gap = false;
  for (const row of rows) {
    if (row.type === "separator") { gap = items.length > 0; continue; }
    if (!row.label) continue;
    const id = row.id;
    const glyph = row.kind ? ICON[row.kind] : id ? ACTION_ICON[id] : undefined;
    items.push({
      key: id ?? `line-${items.length}`,
      label: row.label,
      ...(row.sublabel ? { subtitle: row.sublabel } : {}),
      ...(gap ? { separatorBefore: true } : {}),
      ...(glyph ? { icon: <Icon name={glyph} size={14} /> } : {}),
      ...(row.type === "radio" ? { checked: row.checked === true, ...(row.checked ? { trailing: <Icon name="check" size={14} className="ms-2 shrink-0" /> } : {}) } : {}),
      ...(row.enabled === false || !id ? { disabled: true, wrap: true } : {}),
      onSelect: () => { if (id) void pick(id).catch(() => {}); },
    });
    gap = false;
  }
  return items;
}

/** The list of places as this app's own menu, in the look of the sidebar's other menus. Main serves the rows' words and
 * kinds and runs the row picked; a page that is not this app's own never gets `menuRows` and keeps the native menu. */
function PlaceMenu({ rows, pick, label, title, onOpen, face }: {
  rows: () => Promise<WorkspaceMenuRow[]>;
  pick: (id: string) => Promise<void>;
  label: string;
  title: string;
  onOpen: () => void;
  face: React.ReactNode;
}) {
  const [served, setServed] = useState<WorkspaceMenuRow[]>([]);
  const load = useCallback(() => { void rows().then(setServed).catch(() => {}); }, [rows]);
  useEffect(load, [load]);
  return <SidebarPopoverMenu grok items={placeMenuItems(served, pick)} ariaLabel={label} triggerLabel={label} triggerTitle={title}
    triggerTour="server-switcher" triggerClassName={cn(SIMPLE_TOP_BUTTON, "relative")}
    onOpenChange={(open) => { if (open) { onOpen(); load(); } }} renderTrigger={() => face} />;
}
