import { DESKTOP_SCENES, mountDesktop, type DesktopScene, type Theme } from "./desktop-lab";

declare global {
  interface Window { lab: { duration: number; width: number; height: number; seek: (ms: number) => void } }
}

const params = new URLSearchParams(location.search);
const scene = (params.get("scene") ?? "palette") as DesktopScene;
const theme = (params.get("theme") ?? "light") as Theme;
const capture = params.has("capture");

document.body.style.cssText = `margin:0;background:${theme === "dark" ? "#0a0a0a" : "#e9e9e7"};`;
if (!capture) {
  const bar = document.createElement("nav");
  bar.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;padding:14px 16px 0;font:14px -apple-system,system-ui,sans-serif;";
  for (const name of DESKTOP_SCENES) {
    for (const one of ["light", "dark"] as Theme[]) {
      const link = document.createElement("a");
      link.href = `?scene=${name}&theme=${one}`;
      link.textContent = `${name} (${one})`;
      link.style.cssText = `padding:6px 12px;border-radius:999px;text-decoration:none;color:#1c1c1c;background:${name === scene && one === theme ? "#d6d6d4" : "#f6f6f5"};`;
      bar.appendChild(link);
    }
  }
  const replay = document.createElement("button");
  replay.textContent = "replay";
  replay.style.cssText = "padding:6px 14px;border-radius:999px;border:0;background:#1c1c1c;color:#fdfdfc;font:inherit;cursor:pointer;";
  replay.onclick = () => location.reload();
  bar.appendChild(replay);
  document.body.appendChild(bar);
}

const root = document.createElement("div");
document.body.appendChild(root);
const duration = mountDesktop(root, scene, theme);
const box = root.getBoundingClientRect();
window.lab = {
  duration,
  width: Math.ceil(box.width),
  height: Math.ceil(box.height),
  seek(ms: number) {
    for (const run of document.getAnimations()) {
      run.pause();
      run.currentTime = ms;
    }
  },
};
if (capture) window.lab.seek(0);
