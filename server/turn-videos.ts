import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { fromMarkdown } from "mdast-util-from-markdown";

import { ATTACHMENTS_DIR, FILE_MAX_BYTES, IMAGE_MAX_BYTES, imageMimeOf } from "./attachments.ts";
import type { TurnImageInput } from "./contracts.ts";
import { decodeAttachmentAttribute } from "./message-file.ts";
import { extractTurnImages, TURN_IMAGE_MAX_BYTES, TURN_IMAGE_MAX_COUNT } from "./turn-images.ts";

const execFileAsync = promisify(execFile);

export const VIDEO_FRAMES_DIR_NAME = ".video-frames";
export const VIDEO_MAX_FRAMES = 6;
const VIDEO_FRAME_MAX_WIDTH = 1280;
const FFPROBE_TIMEOUT_MS = 5_000;
const FFMPEG_TIMEOUT_MS = 15_000;

type MarkdownNode = {
  type: string;
  children?: MarkdownNode[];
  value?: string;
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
};

interface VideoTagCandidate {
  start: number;
  end: number;
  path: string;
  name: string;
}

interface OwnedVideo {
  path: string;
  fileName: string;
  displayName: string;
  bytes: number;
}

export interface SampledVideoFrame {
  path: string;
  bytes: number;
  timestampMs: number | null;
}

export interface VideoFrameExtractionResult {
  frames: SampledVideoFrame[];
  durationMs: number | null;
  ffmpegMissing?: boolean;
}

export type VideoFrameExtractor = (input: {
  videoPath: string;
  outDir: string;
  maxFrames: number;
  env: NodeJS.ProcessEnv;
}) => Promise<VideoFrameExtractionResult>;

export interface ExtractTurnVideoFramesOptions {
  attachmentsDir?: string;
  maxCount?: number;
  maxBytes?: number;
  maxFramesPerVideo?: number;
  env?: NodeJS.ProcessEnv;
  extract?: VideoFrameExtractor;
}

const OWNED_VIDEO_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(mp4|m4v|webm|mov)$/;
const FILE_TAG =
  /^<attached-file[\t ]+path="([^"\r\n]*)"(?:[\t ]+name="([^"\r\n]*)")?[\t ]*\/>$/;
const CACHED_FRAME_NAME = /^frame-(\d+)(?:-t(\d+))?(?:-d(\d+))?\.jpg$/;

function walk(node: MarkdownNode, visit: (node: MarkdownNode) => void): void {
  const pending = [node];
  while (pending.length > 0) {
    const current = pending.pop()!;
    visit(current);
    const children = current.children ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]!);
  }
}

function fileTagCandidates(text: string): VideoTagCandidate[] {
  const candidates: VideoTagCandidate[] = [];
  walk(fromMarkdown(text) as MarkdownNode, (node) => {
    if (node.type !== "html" || !node.value || !node.position) return;
    const start = node.position.start.offset;
    const end = node.position.end.offset;
    if (start === undefined || end === undefined) return;
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const nextLine = text.indexOf("\n", end);
    const lineEnd = nextLine < 0 ? text.length : nextLine;
    if (text.slice(lineStart, start).trim() || text.slice(end, lineEnd).trim()) return;
    const match = FILE_TAG.exec(node.value);
    if (!match) return;
    const path = decodeAttachmentAttribute(match[1]!);
    const rawName = match[2] ? decodeAttachmentAttribute(match[2]) : basename(path);
    candidates.push({ start, end, path, name: basename(rawName) || basename(path) });
  });
  return candidates;
}

function ownedVideo(path: string, displayName: string, attachmentsDir: string): OwnedVideo | null {
  if (!path || path.includes("\0")) return null;
  const fileName = path.split(/[\\/]/).at(-1) ?? "";
  if (!OWNED_VIDEO_NAME.test(fileName)) return null;

  const expected = resolve(attachmentsDir, fileName);
  if (resolve(path) !== expected) return null;

  try {
    const entry = lstatSync(expected);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size <= 0 || entry.size > FILE_MAX_BYTES) return null;
    const canonicalRoot = realpathSync(attachmentsDir);
    const canonicalFile = realpathSync(expected);
    if (dirname(canonicalFile) !== canonicalRoot) return null;
    const finalEntry = statSync(canonicalFile);
    if (!finalEntry.isFile() || finalEntry.size !== entry.size) return null;
    return { path: expected, fileName, displayName: displayName || fileName, bytes: entry.size };
  } catch {
    return null;
  }
}

function headOf(path: string): Buffer {
  const head = Buffer.alloc(12);
  const fd = openSync(path, "r");
  try {
    return head.subarray(0, readSync(fd, head, 0, head.length, 0));
  } finally {
    closeSync(fd);
  }
}

function validJpegBytes(path: string): number | null {
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size <= 0 || entry.size > IMAGE_MAX_BYTES) return null;
    if (imageMimeOf(headOf(path)) !== "image/jpeg") return null;
    return entry.size;
  } catch {
    return null;
  }
}

function resolveFfmpegBinaries(env: NodeJS.ProcessEnv): { ffmpeg: string; ffprobe: string } {
  const configured = env.DUSK_FFMPEG?.trim();
  const candidates = configured
    ? [configured]
    : ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"];
  const ffmpeg = configured
    ? configured
    : candidates.find((candidate) => existsSync(candidate)) ?? "ffmpeg";

  const configuredProbe = env.DUSK_FFPROBE?.trim();
  if (configuredProbe) return { ffmpeg, ffprobe: configuredProbe };
  if (ffmpeg.includes("/") || ffmpeg.includes("\\")) {
    const sibling = join(dirname(ffmpeg), process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
    if (existsSync(sibling)) return { ffmpeg, ffprobe: sibling };
  }
  return { ffmpeg, ffprobe: "ffprobe" };
}

function isMissingBinaryError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "EACCES";
}

async function probeDurationMs(ffprobe: string, videoPath: string, env: NodeJS.ProcessEnv): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      ffprobe,
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", videoPath],
      { timeout: FFPROBE_TIMEOUT_MS, env },
    );
    const seconds = Number(stdout.trim());
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
  } catch {
    return null;
  }
}

export function sampleTimestampsMs(durationMs: number, maxFrames: number): number[] {
  const limit = Math.max(1, maxFrames);
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [0];
  let count: number;
  if (durationMs <= 1_000) count = 1;
  else if (durationMs <= 3_000) count = Math.min(limit, 2);
  else if (durationMs <= 6_000) count = Math.min(limit, 4);
  else count = Math.min(limit, Math.max(4, Math.ceil(durationMs / 2_500)));

  if (count === 1) return [durationMs >= 200 ? Math.round(durationMs / 2) : 0];
  return Array.from({ length: count }, (_, index) =>
    Math.round((durationMs * (index + 0.5)) / count),
  );
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function frameFilename(index: number, timestampMs: number | null, durationMs: number | null): string {
  const seq = String(index + 1).padStart(2, "0");
  const tsPart = timestampMs !== null ? `-t${Math.max(0, Math.round(timestampMs))}` : "";
  const durPart = durationMs !== null ? `-d${Math.max(0, Math.round(durationMs))}` : "";
  return `frame-${seq}${tsPart}${durPart}.jpg`;
}

function readCachedFrames(dir: string): VideoFrameExtractionResult | null {
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && CACHED_FRAME_NAME.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!entries.length) return null;
    const frames: SampledVideoFrame[] = [];
    let durationMs: number | null = null;
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const bytes = validJpegBytes(fullPath);
      if (bytes === null) continue;
      const match = CACHED_FRAME_NAME.exec(entry.name);
      const timestampMs = match?.[2] ? Number(match[2]) : null;
      if (durationMs === null && match?.[3]) durationMs = Number(match[3]);
      frames.push({ path: fullPath, bytes, timestampMs });
    }
    return frames.length ? { frames, durationMs } : null;
  } catch {
    return null;
  }
}

async function extractWithFfmpeg(input: {
  videoPath: string;
  outDir: string;
  maxFrames: number;
  env: NodeJS.ProcessEnv;
}): Promise<VideoFrameExtractionResult> {
  const { ffmpeg, ffprobe } = resolveFfmpegBinaries(input.env);
  const scale = `scale='min(${VIDEO_FRAME_MAX_WIDTH},iw)':-2`;
  const durationMs = await probeDurationMs(ffprobe, input.videoPath, input.env);
  const frames: SampledVideoFrame[] = [];

  if (durationMs !== null) {
    const timestamps = sampleTimestampsMs(durationMs, input.maxFrames);
    for (let index = 0; index < timestamps.length; index += 1) {
      const tsMs = timestamps[index]!;
      const outPath = join(input.outDir, frameFilename(index, tsMs, durationMs));
      try {
        await execFileAsync(
          ffmpeg,
          [
            "-nostdin", "-hide_banner", "-loglevel", "error",
            "-ss", (tsMs / 1000).toFixed(3),
            "-i", input.videoPath,
            "-frames:v", "1",
            "-vf", scale,
            "-q:v", "4",
            "-y", outPath,
          ],
          { timeout: FFMPEG_TIMEOUT_MS, env: input.env },
        );
      } catch (error) {
        if (isMissingBinaryError(error)) return { frames: [], durationMs, ffmpegMissing: true };
        continue;
      }
      const bytes = validJpegBytes(outPath);
      if (bytes !== null) frames.push({ path: outPath, bytes, timestampMs: tsMs });
    }
    if (frames.length) return { frames, durationMs };
  }

  const pattern = join(input.outDir, "frame-%02d.jpg");
  try {
    await execFileAsync(
      ffmpeg,
      [
        "-nostdin", "-hide_banner", "-loglevel", "error",
        "-i", input.videoPath,
        "-vf", `fps=1/2,${scale}`,
        "-frames:v", String(Math.max(1, input.maxFrames)),
        "-q:v", "4",
        "-y", pattern,
      ],
      { timeout: FFMPEG_TIMEOUT_MS, env: input.env },
    );
  } catch (error) {
    if (isMissingBinaryError(error)) return { frames: [], durationMs, ffmpegMissing: true };
  }

  const found = readCachedFrames(input.outDir);
  if (found?.frames.length) return { frames: found.frames, durationMs };

  const singlePath = join(input.outDir, frameFilename(0, 0, durationMs));
  try {
    await execFileAsync(
      ffmpeg,
      [
        "-nostdin", "-hide_banner", "-loglevel", "error",
        "-i", input.videoPath,
        "-frames:v", "1",
        "-vf", scale,
        "-q:v", "4",
        "-y", singlePath,
      ],
      { timeout: FFMPEG_TIMEOUT_MS, env: input.env },
    );
  } catch (error) {
    if (isMissingBinaryError(error)) return { frames: [], durationMs, ffmpegMissing: true };
    return { frames: [], durationMs };
  }
  const bytes = validJpegBytes(singlePath);
  if (bytes !== null) frames.push({ path: singlePath, bytes, timestampMs: 0 });
  return { frames, durationMs };
}

async function loadOrExtractVideoFrames(
  video: OwnedVideo,
  attachmentsDir: string,
  maxFrames: number,
  env: NodeJS.ProcessEnv,
  extract: VideoFrameExtractor,
): Promise<VideoFrameExtractionResult> {
  const framesRoot = join(attachmentsDir, VIDEO_FRAMES_DIR_NAME);
  const cacheDir = join(framesRoot, video.fileName);
  const cached = readCachedFrames(cacheDir);
  if (cached && cached.frames.length > 0) return cached;

  mkdirSync(framesRoot, { recursive: true, mode: 0o700 });
  const stagingDir = join(framesRoot, `.staging-${video.fileName}-${randomUUID()}`);
  mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  try {
    const extracted = await extract({ videoPath: video.path, outDir: stagingDir, maxFrames, env });
    if (!extracted.frames.length) {
      rmSync(stagingDir, { recursive: true, force: true });
      return extracted;
    }
    try {
      renameSync(stagingDir, cacheDir);
    } catch {
      rmSync(stagingDir, { recursive: true, force: true });
      const raced = readCachedFrames(cacheDir);
      if (raced) return raced;
      return { frames: [], durationMs: extracted.durationMs };
    }
    return readCachedFrames(cacheDir) ?? { frames: [], durationMs: extracted.durationMs };
  } catch {
    rmSync(stagingDir, { recursive: true, force: true });
    return { frames: [], durationMs: null };
  }
}

export function hasTurnVideos(text: string, attachmentsDir = ATTACHMENTS_DIR): boolean {
  if (!text.includes("<attached-file")) return false;
  return fileTagCandidates(text).some((tag) => ownedVideo(tag.path, tag.name, attachmentsDir) !== null);
}

function videoAnnotation(displayName: string, frames: readonly SampledVideoFrame[], durationMs: number | null, ffmpegMissing?: boolean): string | null {
  if (frames.length > 0) {
    const duration = durationMs !== null ? ` (${formatSeconds(durationMs)})` : "";
    const stamps = frames
      .map((frame) => (frame.timestampMs !== null ? formatSeconds(frame.timestampMs) : null))
      .filter((value): value is string => value !== null);
    const at = stamps.length === frames.length ? ` at ${stamps.join(", ")}` : "";
    const noun = frames.length === 1 ? "frame" : "frames";
    return `[Sampled ${frames.length} ${noun} from ${displayName}${duration}${at} attached as images in chronological order.]`;
  }
  if (ffmpegMissing) {
    return `[Automatic video frame sampling for ${displayName} requires ffmpeg on the server; inspect the attached video file directly.]`;
  }
  return null;
}

/** Samples representative JPEG keyframes from owned video attachments so vision-capable engines receive frames via
 * `turn.images` while keeping `<attached-file>` intact for sandboxed tool access. */
export async function extractTurnVideoFrames(
  text: string,
  existingImages: readonly TurnImageInput[] = [],
  options: ExtractTurnVideoFramesOptions = {},
): Promise<{ text: string; images: TurnImageInput[] }> {
  if (!text.includes("<attached-file")) return { text, images: [] };

  const attachmentsDir = options.attachmentsDir ?? ATTACHMENTS_DIR;
  const maxCount = options.maxCount ?? TURN_IMAGE_MAX_COUNT;
  const maxBytes = options.maxBytes ?? TURN_IMAGE_MAX_BYTES;
  const maxFramesPerVideo = options.maxFramesPerVideo ?? VIDEO_MAX_FRAMES;
  const env = options.env ?? process.env;
  const extract = options.extract ?? extractWithFfmpeg;

  const matched = fileTagCandidates(text)
    .map((tag) => ({ tag, video: ownedVideo(tag.path, tag.name, attachmentsDir) }))
    .filter((entry): entry is { tag: VideoTagCandidate; video: OwnedVideo } => entry.video !== null);
  if (!matched.length) return { text, images: [] };

  let remainingSlots = Math.max(0, maxCount - existingImages.length);
  let remainingBytes = Math.max(0, maxBytes - existingImages.reduce((sum, image) => sum + image.bytes, 0));
  if (remainingSlots <= 0 || remainingBytes <= 0) return { text, images: [] };

  const perVideoCap = Math.max(1, Math.min(maxFramesPerVideo, Math.floor(remainingSlots / matched.length)));
  const extractedImages: TurnImageInput[] = [];
  const annotations: Array<{ at: number; note: string }> = [];

  for (const { tag, video } of matched) {
    if (remainingSlots <= 0 || remainingBytes <= 0) break;
    const cap = Math.min(perVideoCap, remainingSlots);
    const result = await loadOrExtractVideoFrames(video, attachmentsDir, cap, env, extract);
    const admitted: SampledVideoFrame[] = [];
    for (const frame of result.frames) {
      if (admitted.length >= cap || remainingSlots <= 0) break;
      if (frame.bytes > remainingBytes) continue;
      admitted.push(frame);
      extractedImages.push({ path: frame.path, mime: "image/jpeg", bytes: frame.bytes });
      remainingSlots -= 1;
      remainingBytes -= frame.bytes;
    }
    const note = videoAnnotation(video.displayName, admitted, result.durationMs, result.ffmpegMissing);
    if (note) annotations.push({ at: tag.end, note });
  }

  let annotatedText = text;
  for (const { at, note } of annotations.sort((a, b) => b.at - a.at)) {
    annotatedText = `${annotatedText.slice(0, at)}\n${note}${annotatedText.slice(at)}`;
  }
  return { text: annotatedText, images: extractedImages };
}

/** Extracts native images and sampled video frames for a room turn's queued burst and latest user message. */
export async function extractRoomTurnMedia(
  activePath: ReadonlyArray<{ id: string; role: string; kind?: string; text?: string; queueId?: string }>,
  latestUser: { id: string; text?: string; queueId?: string } | undefined,
  burstIds: ReadonlySet<string>,
  options: { enabled: boolean; cardContinuation: boolean } & ExtractTurnVideoFramesOptions,
): Promise<{
  overrides: Array<{ messageId: string; text: string }> | undefined;
  burstOverrides: Array<{ messageId: string; text: string }>;
  latestText: string;
  images: TurnImageInput[];
}> {
  const fallbackLatest = latestUser?.text ?? "";
  if (!options.enabled || options.cardContinuation) {
    return { overrides: undefined, burstOverrides: [], latestText: fallbackLatest, images: [] };
  }
  const burstOverrides: Array<{ messageId: string; text: string }> = [];
  const images: TurnImageInput[] = [];
  for (const message of activePath) {
    if (message.role !== "user" || message.kind !== "text" || !message.text) continue;
    if (!message.queueId || !burstIds.has(message.queueId)) continue;
    const img = extractTurnImages(message.text);
    images.push(...img.images);
    const vid = await extractTurnVideoFrames(img.text, images, options);
    burstOverrides.push({ messageId: message.id, text: vid.text });
    images.push(...vid.images);
  }
  const latestInBurst = latestUser?.queueId !== undefined && burstIds.has(latestUser.queueId);
  let latestText = fallbackLatest;
  const overrides = [...burstOverrides];
  if (latestUser?.text && !latestInBurst) {
    const img = extractTurnImages(latestUser.text);
    images.push(...img.images);
    const vid = await extractTurnVideoFrames(img.text, images, options);
    latestText = img.text;
    overrides.push({ messageId: latestUser.id, text: vid.text });
    images.push(...vid.images);
  }
  return { overrides: latestUser ? overrides : undefined, burstOverrides, latestText, images };
}
