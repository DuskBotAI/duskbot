// The notch island: a window across the top middle of its display, big enough for the panel it opens into, with the
// island itself drawn by its page around the notch (or as a floating pill on a display without one).
import { islandLayout } from "./ambient-geometry.mjs";
import { createAmbientWindow } from "./ambient-window.mjs";
import { measureNotches } from "./notch-probe.mjs";

const displayKey = display => `${display.id}:${display.bounds.width}x${display.bounds.height}:${display.workArea.y - display.bounds.y}`;

export function createIslandWindow({ BrowserWindow, url, platform = process.platform, onMessage, log, trace = null, measure = () => measureNotches({ platform }) }) {
  // above the menu bar, under the system's own alerts
  const overlay = createAmbientWindow({ BrowserWindow, surface: "island", url, level: "pop-up-menu", platform, onMessage, log, trace });
  let notches = {}, measuredFor = "", last = null;

  function lay(display, size) {
    const layout = islandLayout(display, { platform, size, measured: notches[display.id] ?? null });
    overlay.place(layout.window);
    overlay.send("ambient:layout", { surface: "island", width: layout.window.width, height: layout.window.height, collapsed: layout.collapsed, tile: layout.tile, size: layout.size });
    return layout;
  }

  // the housing is measured again whenever the display or its scale changes; until then the menu bar's estimate holds
  function remeasure(display) {
    const key = displayKey(display);
    if (platform !== "darwin" || display.internal !== true || key === measuredFor) return;
    measuredFor = key;
    void measure().then((found) => {
      notches = found ?? {};
      if (measuredFor === key && last && notches[last.display.id] && overlay.shown()) lay(last.display, last.size);
    });
  }

  return {
    ...overlay,
    /** Lays the island out on `display` and tells its page the shape. */
    layout(display, { size }) {
      last = { display, size };
      remeasure(display);
      return lay(display, size);
    },
  };
}
