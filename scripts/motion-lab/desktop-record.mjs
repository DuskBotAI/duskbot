// Renders the desktop motion lab: every desktop surface at picks a, b and c of src/lib/desktop-motion.ts side by side,
// light and dark, as 60 fps clips with an index. Run: node scripts/motion-lab/desktop-record.mjs <out dir> [scene ...]
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { recordClips } from "./capture.mjs";
import { DESKTOP_NOTES, writeDesktopIndex } from "./desktop-index.mjs";

const out = resolve(process.argv[2] ?? "desktop-motion-lab-out");
const only = process.argv.slice(3);
const scenes = Object.keys(DESKTOP_NOTES).filter((scene) => !only.length || only.includes(scene));
const jobs = scenes.flatMap((scene) => ["light", "dark"].map((theme) => ({ query: `scene=${scene}&theme=${theme}`, file: `${scene}-${theme}.mp4`, scale: 1.25, scene, theme })));
const done = await recordClips(out, new URL("./desktop-entry.ts", import.meta.url).pathname, jobs);
const clips = jobs.map(({ scene, theme, file }) => ({ scene, theme, file, frames: done.find((clip) => clip.file === file)?.frames }));
writeFileSync(join(out, "clips.json"), JSON.stringify(clips, null, 2));
if (!only.length) writeDesktopIndex(out, clips);
