import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { imageMimeOf } from "./attachments.ts";
import { extractTurnVideoFrames, hasTurnVideos, sampleTimestampsMs, VIDEO_FRAMES_DIR_NAME } from "./turn-videos.ts";

const VIDEO_ID = "123e4567-e89b-42d3-a456-426614174000";
const SECOND_VIDEO_ID = "223e4567-e89b-42d3-a456-426614174000";
const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

const dirs: string[] = [];
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dusk-turn-videos-"));
  dirs.push(dir);
  return dir;
}

function findFfmpeg(): string | null {
  for (const bin of [process.env.DUSK_FFMPEG, "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg", "ffmpeg"]) {
    if (!bin) continue;
    try {
      execFileSync(bin, ["-version"], { stdio: "ignore" });
      return bin;
    } catch {}
  }
  return null;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("sampleTimestampsMs", () => {
  it("picks evenly spaced interior timestamps scaled by clip duration", () => {
    expect(sampleTimestampsMs(800, 6)).toEqual([400]);
    expect(sampleTimestampsMs(2_000, 6)).toEqual([500, 1500]);
    expect(sampleTimestampsMs(5_000, 6)).toEqual([625, 1875, 3125, 4375]);
    expect(sampleTimestampsMs(18_000, 6)).toHaveLength(6);
    expect(sampleTimestampsMs(18_000, 3)).toEqual([3000, 9000, 15000]);
  });
});

describe("extractTurnVideoFrames", () => {
  it("ignores fenced, inline, symlinked, and out-of-store video references", async () => {
    const root = scratchDir();
    const outside = scratchDir();
    const realOutside = join(outside, `${VIDEO_ID}.mp4`);
    writeFileSync(realOutside, Buffer.from("fake-mp4"));
    const linkPath = join(root, `${VIDEO_ID}.mp4`);
    symlinkSync(realOutside, linkPath);

    const fenced = "```\n" + `<attached-file path="${realOutside}" name="clip.mp4" />` + "\n```";
    const inline = `See <attached-file path="${realOutside}" name="clip.mp4" /> here`;
    const linked = `<attached-file path="${linkPath}" name="clip.mp4" />`;
    const external = `<attached-file path="${realOutside}" name="clip.mp4" />`;

    for (const sample of [fenced, inline, linked, external]) {
      expect(hasTurnVideos(sample, root)).toBe(false);
      const out = await extractTurnVideoFrames(sample, [], { attachmentsDir: root });
      expect(out).toEqual({ text: sample, images: [] });
    }
  });

  it("caches extracted frames, annotates the prompt, and respects image count and byte budgets", async () => {
    const root = scratchDir();
    const videoA = join(root, `${VIDEO_ID}.mp4`);
    const videoB = join(root, `${SECOND_VIDEO_ID}.mov`);
    writeFileSync(videoA, Buffer.from("video-a"));
    writeFileSync(videoB, Buffer.from("video-b"));

    let calls = 0;
    const extractor = async ({ outDir, maxFrames }: { videoPath: string; outDir: string; maxFrames: number }) => {
      calls += 1;
      const frames = [];
      for (let i = 0; i < Math.min(maxFrames, 3); i += 1) {
        const ts = (i + 1) * 1000;
        const p = join(outDir, `frame-0${i + 1}-t${ts}-d4000.jpg`);
        writeFileSync(p, TINY_JPEG);
        frames.push({ path: p, bytes: TINY_JPEG.length, timestampMs: ts });
      }
      return { frames, durationMs: 4000 };
    };

    const text = `Check this\n\n<attached-file path="${videoA}" name="demo.mp4" />`;
    expect(hasTurnVideos(text, root)).toBe(true);

    const first = await extractTurnVideoFrames(text, [], { attachmentsDir: root, extract: extractor });
    expect(calls).toBe(1);
    expect(first.images).toHaveLength(3);
    expect(first.images.every((img) => img.mime === "image/jpeg" && img.bytes === TINY_JPEG.length)).toBe(true);
    expect(first.text).toContain(`<attached-file path="${videoA}" name="demo.mp4" />`);
    expect(first.text).toContain("[Sampled 3 frames from demo.mp4 (4.0s) at 1.0s, 2.0s, 3.0s attached as images in chronological order.]");

    // Second call hits the on-disk cache without invoking the extractor again.
    const second = await extractTurnVideoFrames(text, [], { attachmentsDir: root, extract: extractor });
    expect(calls).toBe(1);
    expect(second.images).toEqual(first.images);
    expect(existsSync(join(root, VIDEO_FRAMES_DIR_NAME, `${VIDEO_ID}.mp4`))).toBe(true);

    // Existing images reduce remaining frame budget across multiple videos.
    const existing = Array.from({ length: 8 }, (_, idx) => ({ path: `/tmp/${idx}.png`, mime: "image/png" as const, bytes: 100 }));
    const both = `<attached-file path="${videoA}" name="demo.mp4" />\n\n<attached-file path="${videoB}" name="clip.mov" />`;
    const bounded = await extractTurnVideoFrames(both, existing, { attachmentsDir: root, maxCount: 10, extract: extractor });
    expect(bounded.images).toHaveLength(2);
  });

  it("degrades gracefully when ffmpeg is missing", async () => {
    const root = scratchDir();
    const video = join(root, `${VIDEO_ID}.mp4`);
    writeFileSync(video, Buffer.from("video-bytes"));
    const text = `Watch this\n\n<attached-file path="${video}" name="screen.mp4" />`;

    const out = await extractTurnVideoFrames(text, [], {
      attachmentsDir: root,
      env: { ...process.env, DUSK_FFMPEG: "/nonexistent/dusk-ffmpeg-missing", DUSK_FFPROBE: "/nonexistent/dusk-ffprobe-missing" },
    });
    expect(out.images).toEqual([]);
    expect(out.text).toContain(`<attached-file path="${video}" name="screen.mp4" />`);
    expect(out.text).toContain("requires ffmpeg on the server");
  });

  it("extracts real JPEG frames from an MP4 when ffmpeg is available", async () => {
    const ffmpeg = findFfmpeg();
    if (!ffmpeg) return;
    const root = scratchDir();
    const video = join(root, `${VIDEO_ID}.mp4`);
    execFileSync(ffmpeg, [
      "-nostdin", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc=duration=4:size=320x240:rate=10",
      "-pix_fmt", "yuv420p", "-y", video,
    ]);

    const text = `Analyze this clip\n\n<attached-file path="${video}" name="testsrc.mp4" />`;
    const out = await extractTurnVideoFrames(text, [], { attachmentsDir: root });
    expect(out.images.length).toBeGreaterThanOrEqual(2);
    expect(out.images.length).toBeLessThanOrEqual(4);
    for (const img of out.images) {
      expect(img.mime).toBe("image/jpeg");
      expect(imageMimeOf(readFileSync(img.path))).toBe("image/jpeg");
    }
    expect(out.text).toContain("Sampled");
    expect(out.text).toContain("testsrc.mp4");
  });
});
