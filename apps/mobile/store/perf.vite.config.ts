import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "vite";
import base from "./vite.config.ts";

// the phone build perf.ts profiles: the production bundle, unminified so React's commits name their components, with a
// recording stand-in for the native glass bridge so the page runs the same glass loop it runs on an iPhone
const recordingGlass: Plugin = {
  name: "perf-recording-glass",
  transform(code, id) {
    if (!id.endsWith("apps/mobile/src/main.tsx")) return null;
    return code.replace(": webPlatform();", ": { ...webPlatform(), glass: globalThis.__perfGlass };");
  },
};

const port = Number(process.env.DUSK_MOBILE_PORT) || 5320;
export default {
  ...base,
  // android has no native glass: its page draws its own chrome
  plugins: [...(base.plugins ?? []), ...(process.env.DUSK_STAGE_PLATFORM === "android" ? [] : [recordingGlass])],
  cacheDir: join(tmpdir(), "dusk-perf-vite"),
  build: { ...base.build, outDir: process.env.DUSK_PERF_OUT ?? join(tmpdir(), "dusk-perf-build"), minify: false },
  preview: { host: "127.0.0.1", port, strictPort: true, proxy: base.server?.proxy },
};
