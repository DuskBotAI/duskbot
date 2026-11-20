// Renders the motion lab: every scene at speeds a, b and c side by side, frame by frame at 60 fps in headless Chrome,
// into mp4 clips, a live page and an index. Run: node scripts/motion-lab/record.mjs <out dir> [scene ...]
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { recordClips } from "./capture.mjs";
import { writeIndex } from "./index-page.mjs";

const out = resolve(process.argv[2] ?? "motion-lab-out");
const only = process.argv.slice(3);
const SCENES = [
  ["push", ["phone"], "Open and close a chat"],
  ["sheet", ["phone"], "A sheet opening and closing"],
  ["overlay", ["desktop"], "A menu, then a dialog, opening and closing"],
  ["reply", ["phone", "desktop"], "The working line giving way to the reply"],
  ["error", ["phone", "desktop"], "The error card coming in and leaving"],
  ["send", ["phone", "desktop"], "Sending: the bubble out of the composer"],
  ["sidebar", ["desktop"], "The sidebar closing to avatars and opening again"],
].filter(([name]) => !only.length || only.includes(name));

const jobs = SCENES.flatMap(([scene, sizes, title]) => sizes.map((size) => ({ query: `scene=${scene}&size=${size}`, file: `${scene}-${size}.mp4`, scale: size === "phone" ? 2 : 1.5, scene, size, title })));
const done = await recordClips(out, new URL("./entry.ts", import.meta.url).pathname, jobs);
const clips = jobs.map(({ scene, size, title, file }) => ({ scene, size, title, file, frames: done.find((clip) => clip.file === file)?.frames }));
writeFileSync(join(out, "clips.json"), JSON.stringify(clips, null, 2));
if (!only.length) writeIndex(out, clips);
