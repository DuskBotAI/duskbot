import { mount, sizesOf, type SceneName, type Size } from "./lab";

declare global {
  interface Window { lab: { duration: number; width: number; height: number; seek: (ms: number) => void } }
}

const params = new URLSearchParams(location.search);
const scene = (params.get("scene") ?? "push") as SceneName;
const size = (params.get("size") ?? sizesOf(scene)[0]) as Size;
const capture = params.has("capture");

document.body.style.cssText = "margin:0;background:#e9e9e7;";
if (!capture) {
  const bar = document.createElement("nav");
  bar.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;padding:14px 20px 0;font:14px -apple-system,system-ui,sans-serif;";
  for (const name of ["push", "sheet", "overlay", "reply", "error", "send", "sidebar"] as SceneName[]) {
    for (const one of sizesOf(name)) {
      const link = document.createElement("a");
      link.href = `?scene=${name}&size=${one}`;
      link.textContent = `${name} (${one})`;
      link.style.cssText = `padding:6px 12px;border-radius:999px;text-decoration:none;color:#1c1c1c;background:${name === scene && one === size ? "#d6d6d4" : "#f6f6f5"};`;
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
const duration = mount(root, scene, size);
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
