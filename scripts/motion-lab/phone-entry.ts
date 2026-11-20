import { mount, type Device, type PhoneScene } from "./phone-lab";
import { PHONE_SCENES as SCENES } from "./phone-notes.mjs";

const DEVICES: Device[] = ["iphone-light", "pixel-dark"];
const params = new URLSearchParams(location.search);
const scene = (params.get("scene") ?? "push") as PhoneScene;
const size = (params.get("size") ?? "iphone-light") as Device;
const capture = params.has("capture");

document.body.style.cssText = "margin:0;background:#e9e9e7;";
if (!capture) {
  const bar = document.createElement("nav");
  bar.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;padding:14px 20px 0;font:14px -apple-system,system-ui,sans-serif;";
  for (const one of SCENES) {
    for (const device of DEVICES) {
      const link = document.createElement("a");
      link.href = `?scene=${one.name}&size=${device}`;
      link.textContent = `${one.name} (${device})`;
      link.style.cssText = `padding:6px 12px;border-radius:999px;text-decoration:none;color:#1c1c1c;background:${one.name === scene && device === size ? "#d6d6d4" : "#f6f6f5"};`;
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
Object.assign(window, {
  lab: {
    duration,
    width: Math.ceil(box.width),
    height: Math.ceil(box.height),
    seek(ms: number) {
      for (const run of document.getAnimations()) {
        run.pause();
        run.currentTime = ms;
      }
    },
  },
});
if (capture) (window as unknown as { lab: { seek: (ms: number) => void } }).lab.seek(0);
