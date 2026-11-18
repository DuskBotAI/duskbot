import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.ts";

export interface WhisperModelTier {
  id: string;
  name: string;
  sizeMb: number;
  vramMb: number;
  accuracy: "Basic" | "Good" | "High" | "Superior";
  recommendedFor: string;
  downloadUrl: string;
}

export const WHISPER_MODEL_TIERS: WhisperModelTier[] = [
  {
    id: "tiny.en",
    name: "Whisper Tiny (English)",
    sizeMb: 75,
    vramMb: 250,
    accuracy: "Basic",
    recommendedFor: "Instant low-latency dictation on low-power devices",
    downloadUrl: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin",
  },
  {
    id: "base.en",
    name: "Whisper Base (English)",
    sizeMb: 142,
    vramMb: 450,
    accuracy: "Good",
    recommendedFor: "Balanced everyday coding and conversation",
    downloadUrl: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
  },
  {
    id: "small.en",
    name: "Whisper Small (English)",
    sizeMb: 466,
    vramMb: 1000,
    accuracy: "High",
    recommendedFor: "High-accuracy transcription of technical jargon and libraries",
    downloadUrl: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin",
  },
  {
    id: "large-v3-turbo",
    name: "Whisper Large v3 Turbo",
    sizeMb: 1600,
    vramMb: 2500,
    accuracy: "Superior",
    recommendedFor: "State-of-the-art multilingual accuracy and complex code dictation",
    downloadUrl: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
  },
];

export interface VadConfig {
  energyThreshold: number; // 0.0 - 1.0
  silenceCutoffMs: number; // e.g. 1500ms
  autoStop: boolean;
}

export class WhisperModelManager {
  private modelsDir: string;
  private downloaded = new Set<string>();

  constructor(modelsDir = join(DATA_DIR, "models", "whisper")) {
    this.modelsDir = modelsDir;
    mkdirSync(this.modelsDir, { recursive: true });
    this.hydrate();
  }

  private hydrate(): void {
    for (const tier of WHISPER_MODEL_TIERS) {
      const filePath = this.getModelPath(tier.id);
      if (existsSync(filePath)) {
        this.downloaded.add(tier.id);
      }
    }
  }

  getModelPath(modelId: string): string {
    return join(this.modelsDir, `ggml-${modelId}.bin`);
  }

  isModelDownloaded(modelId: string): boolean {
    return this.downloaded.has(modelId) && existsSync(this.getModelPath(modelId));
  }

  async downloadModel(
    modelId: string,
    onProgress?: (percent: number) => void
  ): Promise<string> {
    const tier = WHISPER_MODEL_TIERS.find((t) => t.id === modelId);
    if (!tier) throw new Error(`Unknown Whisper model tier "${modelId}".`);

    const targetPath = this.getModelPath(modelId);
    
    // Simulate download steps with progress callback
    onProgress?.(25);
    onProgress?.(50);
    onProgress?.(75);
    
    // Write placeholder model envelope if not present
    writeFileSync(targetPath, `WHISPER_GGUF_PLACEHOLDER_${modelId}_${tier.sizeMb}MB`, "utf-8");
    onProgress?.(100);

    this.downloaded.add(modelId);
    return targetPath;
  }

  deleteModel(modelId: string): boolean {
    const targetPath = this.getModelPath(modelId);
    if (existsSync(targetPath)) {
      rmSync(targetPath, { force: true });
      this.downloaded.delete(modelId);
      return true;
    }
    return false;
  }

  buildPromptBias(context: {
    botName?: string;
    keywords?: string[];
    recentFiles?: string[];
  }): string {
    const terms = new Set<string>();
    
    // Standard developer vocabulary biased into Whisper initial prompt
    ["TypeScript", "GraphQL", "Python", "Docker", "Git", "GitHub", "API"].forEach((t) => terms.add(t));

    if (context.botName) terms.add(context.botName);
    if (context.keywords) context.keywords.forEach((k) => terms.add(k));
    if (context.recentFiles) {
      context.recentFiles.forEach((f) => {
        const basename = f.split(/[/\\]/).pop();
        if (basename) terms.add(basename);
      });
    }

    return Array.from(terms).join(", ");
  }

  getDefaultVadConfig(): VadConfig {
    return {
      energyThreshold: 0.35,
      silenceCutoffMs: 1500,
      autoStop: true,
    };
  }
}
