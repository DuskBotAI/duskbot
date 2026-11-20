// The camera housing of each notched display, as AppKit measures it: Electron 43 exposes no safe area, so main asks
// AppKit through JavaScript for Automation. NSScreenNumber is the CGDirectDisplayID Electron uses as a display's id on
// macOS; auxiliaryTopLeftArea and auxiliaryTopRightArea (macOS 12+) are the menu bar on either side of the housing.
import { execFile } from "node:child_process";

const SCRIPT = `ObjC.import("AppKit");
const screens = $.NSScreen.screens, out = [];
for (let i = 0; i < screens.count; i++) {
  const screen = screens.objectAtIndex(i);
  if (!screen.respondsToSelector("auxiliaryTopLeftArea")) continue;
  const left = screen.auxiliaryTopLeftArea, right = screen.auxiliaryTopRightArea;
  out.push({ id: ObjC.unwrap(screen.deviceDescription.objectForKey("NSScreenNumber")), left: left.origin.x + left.size.width, right: right.origin.x, top: screen.safeAreaInsets.top });
}
JSON.stringify(out);`;

const TIMEOUT_MS = 4_000;

/** Display id to the housing's size in points, for the displays that have one. */
export function parseNotches(text) {
  let rows;
  try { rows = JSON.parse(String(text ?? "").trim()); } catch { return {}; }
  if (!Array.isArray(rows)) return {};
  const notches = {};
  for (const row of rows) {
    const width = Number(row?.right) - Number(row?.left), height = Number(row?.top);
    if (!Number.isFinite(row?.id) || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > 400) continue;
    notches[row.id] = { width, height };
  }
  return notches;
}

const osascript = () => new Promise((resolve, reject) => {
  execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", SCRIPT], { timeout: TIMEOUT_MS }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
});

/** Never throws: anywhere but macOS, or when AppKit cannot be asked, there are no measured notches. */
export async function measureNotches({ platform = process.platform, run = osascript } = {}) {
  if (platform !== "darwin") return {};
  try { return parseNotches(await run()); } catch { return {}; }
}
