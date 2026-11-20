// The desktop lab's index: every clip, what each pick plays, and the reference principle behind it. Run alone to
// rewrite it from <out dir>/clips.json.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Per scene: a title, then for A, B and C what plays and the principle it applies. Times are as seen, after the global B speed (x1.4). */
export const DESKTOP_NOTES = {
  palette: ["The ⌘K palette: open, three rows down, typing \"setti\", Escape", [
    ["Opens and closes raw; the highlight jumps; filtered rows swap at once.", "Emil: a keyboard-opened palette used 100+ times a day gets no animation (Raycast)."],
    ["140 ms fade from .98 with 2 px of blur clearing, centred; closes in 126 ms back toward .98; highlight still jumps; rows swap at once both ways.", "Emil: never from scale 0, modals stay centred, exit faster than enter; list navigation stays near-imperceptible."],
    ["210 ms spring-shaped from .96, 8 px drop, 4 px blur; closes in 140 ms toward .97, lifting 4 px; the highlight glides 154 ms; rows fade in 126 ms on a shrinking 22 ms stagger, five rows at most, and a row the query drops fades out in 126 ms where it stood.", "Impeccable: one authored moment; it knowingly breaks Emil's no-stagger-on-palettes rule, so it is the expressive pick."],
  ]],
  settings: ["Settings: open, two sections, close", [
    ["280 ms from .96 on the softer out curve, scrim 224 ms; a section rises 4 px in 180 ms; leaves as a 168 ms fade.", "As shipped."],
    ["280 ms from .97 with 3 px blur clearing; sections crossfade 168 ms with 2 px blur, no travel; leaves 140 ms toward .985.", "Emil: blur masks a crossfade; tab content swaps often so it barely moves; exits are shorter and simpler."],
    ["Spring-shaped (380/28) from .94 with an 8 px rise and 6 px blur; sections rise 8 px through 4 px blur over 280 ms; leaves 147 ms toward .97.", "Emil: springs read as alive for occasional surfaces; impeccable: material change (focus via blur) carries the depth."],
  ]],
  panel: ["The bot panel: open, Details to Library, close", [
    ["The column grows 0 to 320 px over 260 ms on (0.2, 0, 0, 1); a tab rises 6 px over 220 ms.", "As shipped."],
    ["340 ms on Emil's drawer curve (0.32, 0.72, 0, 1); a tab crossfades 168 ms with 2 px blur.", "Emil: drawers are the documented over-300 ms exception, on the iOS drawer curve."],
    ["476 ms on the soft spring; a tab rises 8 px through 4 px blur over 280 ms.", "Choreograph: the panel is the lead, its content rides along (one entrance per container)."],
  ]],
  menus: ["A bot's menu out of its row, then the + menu opening upward", [
    ["168 ms from .97 with 4 px travel toward the trigger; out 112 ms at .98.", "As shipped (origin at the trigger)."],
    ["154 ms from .96 out of the trigger corner, no travel; out 98 ms toward .97.", "Emil: origin-aware scale does the work; dropdowns 150 to 250 ms; exit faster than enter."],
    ["252 ms spring-shaped from .94 with 6 px travel and 3 px blur; out 126 ms.", "Emil: springs for something that should feel alive, bounce kept small."],
  ]],
  dialogs: ["A confirm, then New bot", [
    ["280 ms from .96, scrim 224 ms; out 168 ms at .98.", "As shipped."],
    ["280 ms from .97 with 3 px blur; out 140 ms toward .985.", "Emil: modal 200 to 500 ms from .95 to .97, centred, the scrim on the same clock."],
    ["Spring 380/28 from .94 with an 8 px rise and 6 px blur, scrim 280 ms; out 147 ms with a 4 px drift.", "Emil: springs for occasional surfaces, overshoot under 0.3 bounce."],
  ]],
  sidebar: ["The sidebar to avatars and back, then another chat opened", [
    ["Width over 700 ms on the soft spring; another chat is there at once.", "As shipped."],
    ["420 ms on the drawer curve; the new transcript comes up from 50 % in 140 ms with 2 px blur.", "Emil: prevent a jarring change, but a tens-a-day action stays barely there; blur hides the seam."],
    ["588 ms on the soft spring; the transcript fades from 0, rises 6 px through 4 px blur over 252 ms.", "Impeccable: continuity through navigation, the new view arriving as one move."],
  ]],
  toasts: ["Two toasts, each in and out", [
    ["There at once, gone at once.", "As shipped (Grok's toast)."],
    ["Rises its own height on plain ease over 400 ms, as a transition so a second toast turns back mid-way; drops back the way it came in 280 ms.", "Emil: Sonner's 400 ms ease from translateY(100%); transitions, not keyframes, for anything re-triggered."],
    ["Spring 420/26 from 16 px low at .96 over 448 ms, a hair of overshoot; leaves 8 px down toward .97 in 224 ms.", "Emil: a little bounce is allowed for a light acknowledgement."],
  ]],
  press: ["A sidebar row hovered and pressed, then the send button pressed twice", [
    ["Buttons give to .96 in 160 ms and come back with a hair of overshoot in 200 ms; rows .985.", "As shipped (bencho's press)."],
    [".97 in 100 ms, back in 160 ms on (0.23, 1, 0.32, 1), no overshoot; rows .99.", "Emil: press feedback at .97, 100 to 160 ms, his strong ease-out."],
    [".95, springing back over 380 ms with visible overshoot; rows .98.", "Emil: springs for tactile things you press; bounce reserved for playful moments."],
  ]],
};

const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function writeDesktopIndex(out, clips) {
  const sections = Object.entries(DESKTOP_NOTES).map(([scene, [title, picks]], i) => {
    const rows = picks.map(([what, why], n) => `<li><b>${"ABC"[n]}</b> <span>${esc(what)}</span><em>${esc(why)}</em></li>`).join("");
    const videos = clips.filter((clip) => clip.scene === scene).map((clip) => `
      <figure><video src="${esc(clip.file)}" autoplay loop muted playsinline controls></video><figcaption>${clip.theme}: A, B, C left to right</figcaption></figure>`).join("");
    return `<section id="${scene}"><h2>${i + 1}. ${esc(title)}</h2><ul>${rows}</ul>${videos}</section>`;
  }).join("");
  writeFileSync(join(out, "index.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>desktop motion lab, 2026-11-20</title>
<style>
:root { color-scheme: light; --ink: #1c1c1c; --soft: #5f5f5d; --ground: #f6f6f5; --tone: #e9e9e7; --accent: #1084fe; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--ground); color: var(--ink); font: 15px/1.6 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; }
header, section { max-width: 1440px; margin: 0 auto; padding: 32px 32px 8px; }
header { position: sticky; top: 0; z-index: 2; background: color-mix(in srgb, var(--ground) 94%, transparent); backdrop-filter: blur(12px); padding-bottom: 12px; }
h1 { font-size: 26px; line-height: 1.2; margin: 0 0 8px; letter-spacing: -0.01em; }
h2 { font-size: 18px; margin: 0 0 6px; }
p { color: var(--soft); max-width: 80ch; margin: 0 0 8px; }
ul { padding: 0; margin: 0 0 16px; list-style: none; }
li { display: grid; grid-template-columns: 1.6em 1fr; column-gap: 4px; margin-bottom: 6px; max-width: 110ch; }
li b { color: var(--ink); }
li span { color: var(--ink); }
li em { grid-column: 2; font-style: normal; font-size: 13px; color: var(--soft); }
figure { margin: 0 0 20px; }
video { display: block; max-width: 100%; height: auto; border-radius: 12px; background: var(--tone); }
figcaption { font-size: 13px; color: var(--soft); margin-top: 6px; }
nav { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
nav a { font-size: 13px; padding: 4px 10px; border-radius: 999px; background: var(--tone); color: var(--ink); text-decoration: none; }
.rate { display: flex; gap: 8px; margin: 10px 0 0; }
.rate button { font: inherit; min-height: 44px; padding: 0 18px; border: 0; border-radius: 999px; background: var(--tone); color: var(--ink); cursor: pointer; }
.rate button[aria-pressed="true"] { background: var(--ink); color: var(--ground); }
:is(.rate button, a):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
a { color: var(--ink); }
</style>
<header>
  <h1>Desktop motion lab</h1>
  <p>Each clip plays one desktop surface three times side by side, frame by frame at 60 fps: <b>A</b> as dev ships it now, <b>B</b> fast and soft on Emil Kowalski's rules, <b>C</b> more expressive (springs, a gliding highlight, a small stagger). All three sit on your global pick B (every duration x1.4, ease-out cubic-bezier(0.25, 0.85, 0.3, 1)), so B and C only change what moves and how. The surfaces are drawn stand-ins; every duration, scale, blur and curve comes from src/lib/desktop-motion.ts, the same values the app plays. Pick A, B or C per row (mixing is fine). <a href="live.html">Open the live version</a>.</p>
  <nav aria-label="scenes">${Object.entries(DESKTOP_NOTES).map(([scene, [title]], i) => `<a href="#${scene}">${i + 1}. ${esc(title.split(":")[0].split(",")[0])}</a>`).join("")}</nav>
  <div class="rate" role="group" aria-label="playback speed">
    <button type="button" data-rate="1" aria-pressed="true">Real speed</button>
    <button type="button" data-rate="0.5" aria-pressed="false">Half speed</button>
    <button type="button" data-rate="0.25" aria-pressed="false">Quarter speed</button>
    <button type="button" data-rate="0.1" aria-pressed="false">Tenth speed</button>
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
  writeDesktopIndex(out, JSON.parse(readFileSync(join(out, "clips.json"), "utf8")));
}
