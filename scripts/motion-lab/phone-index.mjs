// The phone lab's index: every interaction at b, b+ and b++, with the principle each variant applies.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const PICKS = ["b", "b+", "b++"];
const DEVICE = { "iphone-light": "iPhone 390 x 844, light", "pixel-dark": "Pixel 412 x 915, dark" };

export function writePhoneIndex(out, clips, picks) {
  const scenes = [...new Map(clips.map((clip) => [clip.scene, clip])).values()];
  const sections = scenes.map(({ scene, title, lines }, i) => {
    const rows = PICKS.map((pick, n) => `<li><b>${esc(picks[n]?.split("  ")[0] ?? pick)}</b> ${esc(lines?.[pick] ?? "")}</li>`).join("");
    const videos = clips.filter((clip) => clip.scene === scene).map((clip) => `
      <figure><video src="${esc(clip.file)}" autoplay loop muted playsinline controls preload="metadata"></video><figcaption>${esc(DEVICE[clip.size] ?? clip.size)}</figcaption></figure>`).join("");
    return `<section><h2>${i + 1}. ${esc(title)}</h2><ul>${rows}</ul><div class="clips">${videos}</div></section>`;
  }).join("");
  writeFileSync(join(out, "index.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>phone motion lab 2, 2026-11-20</title>
<style>
:root { color-scheme: light; --ink: #1c1c1c; --soft: #5f5f5d; --ground: #f6f6f5; --tone: #e9e9e7; --accent: #1084fe; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--ground); color: var(--ink); font: 15px/1.6 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; }
header, section { max-width: 1500px; margin: 0 auto; padding: 32px 32px 8px; }
h1 { font-size: 26px; line-height: 1.2; margin: 0 0 8px; letter-spacing: -0.01em; }
h2 { font-size: 18px; margin: 0 0 6px; }
p, li { color: var(--soft); max-width: 80ch; }
ul { padding: 0; margin: 0 0 16px; list-style: none; }
li b { display: inline-block; min-width: 3em; color: var(--ink); }
.clips { display: grid; gap: 20px; }
figure { margin: 0; }
video { display: block; max-width: 100%; height: auto; border-radius: 12px; background: var(--tone); }
figcaption { font-size: 13px; color: var(--soft); margin-top: 6px; }
.rate { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0 4px; }
.rate button { font: inherit; min-height: 44px; padding: 0 18px; border: 0; border-radius: 999px; background: var(--tone); color: var(--ink); cursor: pointer; }
.rate button[aria-pressed="true"] { background: var(--ink); color: var(--ground); }
.rate button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
a { color: var(--ink); }
.tag { display: inline-block; padding: 1px 8px; border-radius: 999px; background: #f59e0b; color: #1c1c1c; font-size: 12px; font-weight: 600; }
</style>
<header>
  <h1>Phone motion lab 2: B, B+ and B++</h1>
  <p>Each clip plays the same interaction three times side by side, rendered frame by frame at 60 fps. <b>B</b> is the phone as it moves now. <b>B+</b> applies Emil Kowalski's rules: motion starts from where you touched (menus from the held bubble, pictures from their thumbnail, the sent bubble from the composer), springs carry the finger's speed so anything can be caught mid-flight, exits are quicker than entrances, nothing grows from zero, and clip reveals replace scaling where text is involved. <b>B++</b> keeps B+ and adds a little expression: a hair of give after a drag, deeper focus blur, staggered menu items and reply lines, a stretchy pill, stacked toasts and a mascot peek.</p>
  <p>The grey circle is your finger. The <span class="tag">haptic</span> tag shows when the phone taps your hand: B taps at the press; B+ waits for the motion's peak (the bubble's lift, the sheet catching its detent); B++ taps at the press and again, harder, at the peak. Haptics only show where the app has one today (long press, sheet detent, pull to refresh).</p>
  <p>The phones are drawn stand-ins, not the app itself; the springs, durations and curves are the ones each feel would ship with. Pick per row (mixing is fine). <a href="live.html">Live version</a> plays them in the browser at its own refresh rate.</p>
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
  writePhoneIndex(out, JSON.parse(readFileSync(join(out, "clips.json"), "utf8")), ["B", "B+", "B++"]);
}
