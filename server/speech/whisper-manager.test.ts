import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WHISPER_MODEL_TIERS, WhisperModelManager } from "./whisper-manager.ts";

describe("Whisper Open-Source Speech Model Manager", () => {
  let tempDir: string;
  let manager: WhisperModelManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dusk-whisper-test-"));
    manager = new WhisperModelManager(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("lists all configured model tiers from tiny to large-v3-turbo", () => {
    expect(WHISPER_MODEL_TIERS.length).toBeGreaterThanOrEqual(4);
    const turbo = WHISPER_MODEL_TIERS.find((m) => m.id === "large-v3-turbo");
    expect(turbo?.name).toContain("Large v3 Turbo");
    expect(turbo?.accuracy).toBe("Superior");
  });

  it("handles model download, progress reporting, and deletion cleanly", async () => {
    expect(manager.isModelDownloaded("tiny.en")).toBe(false);

    const progress: number[] = [];
    const savedPath = await manager.downloadModel("tiny.en", (pct) => progress.push(pct));

    expect(progress).toContain(100);
    expect(manager.isModelDownloaded("tiny.en")).toBe(true);
    expect(savedPath).toContain("ggml-tiny.en.bin");

    const deleted = manager.deleteModel("tiny.en");
    expect(deleted).toBe(true);
    expect(manager.isModelDownloaded("tiny.en")).toBe(false);
  });

  it("generates prompt biasing string containing bot name, developer keywords and files", () => {
    const prompt = manager.buildPromptBias({
      botName: "Nova",
      keywords: ["Kubernetes", "Vitest", "Tailwind"],
      recentFiles: ["src/components/ChatView.tsx", "server/index.ts"],
    });

    expect(prompt).toContain("TypeScript");
    expect(prompt).toContain("Nova");
    expect(prompt).toContain("Kubernetes");
    expect(prompt).toContain("ChatView.tsx");
  });

  it("provides sensible default VAD configurations", () => {
    const vad = manager.getDefaultVadConfig();
    expect(vad.energyThreshold).toBe(0.35);
    expect(vad.silenceCutoffMs).toBe(1500);
    expect(vad.autoStop).toBe(true);
  });
});
