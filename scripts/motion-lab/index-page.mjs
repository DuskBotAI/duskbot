// The lab's index: every clip with what each speed changes. Run alone to rewrite it from <out dir>/clips.json.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const CHANGES = {
  push: ["System spring 600/54, a tap leaves at 10 widths/s: settled in 500 ms", "Spring 306/42, leaves at 7.1 widths/s: settled in 780 ms, no overshoot", "Spring 185/35 (critical), leaves at 5.6 widths/s: settled in 1120 ms"],
  sheet: ["Same system spring: up in 530 ms, the page behind steps back with it", "Spring 306/42: up in 870 ms", "Spring 185/35: up in 1220 ms"],
  overlay: ["Menu 120 ms in, 80 ms out. Dialog 200 ms in from .96, scrim 160 ms, 120 ms out", "Menu 168 / 112 ms. Dialog 280 ms in, scrim 224 ms, 168 ms out, on the softer out curve", "Menu 216 / 144 ms. Dialog 360 ms in, scrim 288 ms, 216 ms out, on the softest out curve"],
  reply: ["Working line fades 140 ms; reply grows from .94 on spring 420/32 (465 ms, a hair of give); column follows 240 ms", "Line 196 ms; reply on 214/29 (635 ms, no give); column 336 ms", "Line 252 ms; reply on 130/23 (1020 ms, no give); column 432 ms"],
  error: ["Slot opens 200 ms ease-in-out, card fades in 140 ms; leaves with a 140 ms fade while the slot closes 200 ms", "Slot 280 ms, fade 196 ms, softer in-out curve", "Slot 360 ms, fade 252 ms, softest in-out curve"],
  send: ["Bubble from .9 and 16 px low, 200 ms ease-out; the column follows on the same clock", "280 ms on the softer out curve", "360 ms on the softest out curve"],
  sidebar: ["Width 288 to 80 px over 500 ms on the soft spring curve", "700 ms, same curve", "900 ms, same curve"],
};

const CURVES = [
  ["A", "as shipped: each place keeps its own curve"],
  ["B", "every duration x1.4; springs 1.4x slower at the same damping ratio, then 8% more damping and never past critical; ease-out cubic-bezier(0.25, 0.85, 0.3, 1), in-out cubic-bezier(0.45, 0.05, 0.25, 1)"],
  ["C", "every duration x1.8; springs 1.8x slower, 15% more damping, never past critical; ease-out cubic-bezier(0.3, 0.8, 0.25, 1), in-out cubic-bezier(0.4, 0.05, 0.2, 1)"],
];

const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function writeIndex(out, clips) {
  const scenes = [...new Map(clips.map((clip) => [clip.scene, clip])).values()];
  const sections = scenes.map(({ scene, title }, i) => {
    const videos = clips.filter((clip) => clip.scene === scene).map((clip) => `
      <figure><video src="${esc(clip.file)}" autoplay loop muted playsinline controls></video><figcaption>${clip.size === "phone" ? "iPhone 390 x 844" : "desktop 960 x 600, shown at 62%"}</figcaption></figure>`).join("");
    const rows = (CHANGES[scene] ?? []).map((text, n) => `<li><b>${"ABC"[n]}</b> ${esc(text)}</li>`).join("");
    return `<section><h2>${i + 1}. ${esc(title)}</h2><ul>${rows}</ul>${videos}</section>`;
  }).join("");
  writeFileSync(join(out, "index.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>motion lab, 2026-11-20</title>
<style>
:root { color-scheme: light; --ink: #1c1c1c; --soft: #5f5f5d; --ground: #f6f6f5; --tone: #e9e9e7; --accent: #1084fe; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--ground); color: var(--ink); font: 15px/1.6 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; }
header, section { max-width: 1440px; margin: 0 auto; padding: 32px 32px 8px; }
h1 { font-size: 26px; line-height: 1.2; margin: 0 0 8px; letter-spacing: -0.01em; }
h2 { font-size: 18px; margin: 0 0 6px; }
p, li { color: var(--soft); max-width: 75ch; }
ul { padding: 0; margin: 0 0 16px; list-style: none; }
li b { display: inline-block; width: 1.4em; color: var(--ink); }
figure { margin: 0 0 20px; }
video { display: block; max-width: 100%; height: auto; border-radius: 12px; background: var(--tone); }
figcaption { font-size: 13px; color: var(--soft); margin-top: 6px; }
.rate { display: flex; gap: 8px; margin: 16px 0 4px; }
.rate button { font: inherit; min-height: 44px; padding: 0 18px; border: 0; border-radius: 999px; background: var(--tone); color: var(--ink); cursor: pointer; }
.rate button[aria-pressed="true"] { background: var(--ink); color: var(--ground); }
.rate button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
a { color: var(--ink); }
</style>
<header>
  <h1>Motion lab: slower and smoother</h1>
  <p>Each clip plays the same transition three times side by side, rendered frame by frame at 60 fps. Every variant starts on the frame of the tap; only how long it glides and how gently it lands differ. The surfaces are drawn stand-ins, not the app itself, but every duration, spring and curve comes from the app's own motion code.</p>
  <ul>${CURVES.map(([key, text]) => `<li><b>${key}</b> ${esc(text)}</li>`).join("")}</ul>
  <p>Pick A, B or C per row (mixing is fine). <a href="live.html">Open the live version</a> to watch them run in the browser at its own refresh rate.</p>
  <div class="rate" role="group" aria-label="playback speed">
    <button type="button" data-rate="1" aria-pressed="true">Real speed</button>
    <button type="button" data-rate="0.5" aria-pressed="false">Half speed</button>
    <button type="button" data-rate="0.25" aria-pressed="false">Quarter speed</button>
  </div>
</header>
${sections}
<script>
for (const button of document.querySelectorAll("[data-rate]")) button.addEventListener("click", () => {
  for (const other of document.querySelectorAll("[data-rate]")) other.setAttribute("aria-pressed", String(other === button));
  for (const video of document.querySelectorAll("video")) video.playbackRate = Number(button.dataset.rate);
});
</script>
</html>
`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = resolve(process.argv[2] ?? "");
  writeIndex(out, JSON.parse(readFileSync(join(out, "clips.json"), "utf8")));
}
