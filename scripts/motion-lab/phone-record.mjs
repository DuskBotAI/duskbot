// Renders the phone motion lab: every phone interaction at feels b, b+ and b++ of src/mobile/phone-feel.ts side by side,
// at iPhone light and Pixel dark, as 60 fps clips with an index. Run: node scripts/motion-lab/phone-record.mjs <out dir> [scene ...]
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { recordClips } from "./capture.mjs";
import { writePhoneIndex } from "./phone-index.mjs";
import { PHONE_SCENES } from "./phone-notes.mjs";

const out = resolve(process.argv[2] ?? "phone-motion-lab-out");
const only = process.argv.slice(3);
const scenes = PHONE_SCENES.filter(({ name }) => !only.length || only.includes(name));
const jobs = scenes.flatMap(({ name, title, lines }) => ["iphone-light", "pixel-dark"].map((size) => ({ query: `scene=${name}&size=${size}`, file: `${name}-${size}.mp4`, scale: 1.5, scene: name, size, title, lines })));
const done = await recordClips(out, new URL("./phone-entry.ts", import.meta.url).pathname, jobs);
const clips = jobs.map(({ scene, size, title, lines, file }) => ({ scene, size, title, lines, file, frames: done.find((clip) => clip.file === file)?.frames }));
writeFileSync(join(out, "clips.json"), JSON.stringify(clips, null, 2));
if (!only.length) writePhoneIndex(out, clips, ["B", "B+", "B++"]);
