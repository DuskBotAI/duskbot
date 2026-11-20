/** The longest an exit copy stays on the page. */
export const GHOST_MAX_MS = 1000;

/** Plays an unmounted element's way out on a copy of it in `host`, so its owner can go at once: the copy has no ids or
 * roles, takes no input, is hidden from assistive tech, and is removed once every animation `play` starts on it has
 * ended, or after GHOST_MAX_MS at the latest. */
export function playGhostExit(el: HTMLElement | null, host: HTMLElement | null, play: (ghost: HTMLElement) => Animation[], place?: (ghost: HTMLElement) => void): void {
  if (!el || !host?.isConnected || typeof el.animate !== "function") return;
  const ghost = el.cloneNode(true) as HTMLElement;
  for (const node of [ghost, ...ghost.querySelectorAll<HTMLElement>("[id], [role]")]) {
    node.removeAttribute("id");
    node.removeAttribute("role");
  }
  ghost.inert = true;
  ghost.setAttribute("aria-hidden", "true");
  ghost.dataset.exitGhost = "";
  ghost.style.pointerEvents = "none";
  place?.(ghost);
  host.appendChild(ghost);
  const runs = play(ghost);
  const gone = () => ghost.remove();
  if (!runs.length) { gone(); return; }
  setTimeout(gone, GHOST_MAX_MS);
  Promise.all(runs.map((run) => run.finished)).then(gone, gone);
}

export function motionReduced(): boolean {
  if (typeof document === "undefined") return true;
  return document.documentElement.dataset.reducedMotion === "true" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}
