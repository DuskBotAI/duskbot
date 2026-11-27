import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { usePlaceLook } from "@/lib/place-look";
import { useStore } from "@/state/store";
import { PlaceMark } from "./PlaceMark";

type WorkspaceState = Awaited<ReturnType<NonNullable<NonNullable<typeof window.duskDesktop>["workspaces"]>["state"]>>;

/** The place this window shows, as main tells this page: null in a browser, on a remote client, or until main answers. */
export function useWindowPlace(): WorkspaceState | null {
  const [place, setPlace] = useState<WorkspaceState | null>(null);
  useEffect(() => {
    const workspaces = window.duskDesktop?.remoteClient?.active ? undefined : window.duskDesktop?.workspaces;
    if (!workspaces) return;
    let alive = true;
    const read = () => void workspaces.state().then((next) => { if (alive) setPlace(next); }).catch(() => {});
    read();
    const off = workspaces.onChanged?.(read);
    return () => { alive = false; off?.(); };
  }, []);
  return place;
}

/** What the window's top bar calls the place: This computer, My Cloud while it is the window's only home (a team's name
 * on a team's Cloud), else the name it was saved under. */
export function windowPlaceName(place: WorkspaceState, team: string | undefined): string {
  if (place.home) return team || t("cloudSetup.myCloud");
  if (place.local && !place.localPath) return t("rail.thisComputer");
  return place.name;
}

export function windowPlaceMark(place: WorkspaceState, team: string | undefined, color?: unknown): {
  kind: "computer" | "cloud" | "team";
  name: string;
  color: unknown;
} {
  return {
    kind: place.local ? "computer" : place.role ? "team" : "cloud",
    name: windowPlaceName(place, team),
    color: color ?? place.color ?? null,
  };
}

/** The middle of the window frame's top bar: the place on screen, its mark as the rail draws it and its name, quiet. It
 * stays part of the bar's drag region. */
export function WindowPlaceTitle() {
  const place = useWindowPlace();
  const look = usePlaceLook();
  const { state } = useStore();
  if (!place) return <span aria-hidden="true" />;
  const mark = windowPlaceMark(place, state.config?.team?.name, look?.color);
  return <div data-window-place className="flex min-w-0 items-center justify-center gap-1.5 px-2 text-[12px] font-medium text-ink-secondary">
    <PlaceMark place={mark} size={16} />
    <span className="min-w-0 truncate">{mark.name}</span>
  </div>;
}
