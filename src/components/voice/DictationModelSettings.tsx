import { useState } from "react";
import { Mic, Download, HardDrive, Sliders } from "lucide-react";
import { cn } from "@/lib/cn";

export interface SpeechModelCard {
  id: string;
  name: string;
  sizeMb: number;
  vramMb: number;
  accuracy: "Basic" | "Good" | "High" | "Superior";
  desc: string;
  downloaded?: boolean;
}

export const SPEECH_TIERS: SpeechModelCard[] = [
  { id: "tiny.en", name: "Whisper Tiny (English)", sizeMb: 75, vramMb: 250, accuracy: "Basic", desc: "Instant low-latency transcription for quick voice notes" },
  { id: "base.en", name: "Whisper Base (English)", sizeMb: 142, vramMb: 450, accuracy: "Good", desc: "Balanced everyday coding and speech dictation" },
  { id: "small.en", name: "Whisper Small (English)", sizeMb: 466, vramMb: 1000, accuracy: "High", desc: "High accuracy across developer syntax and acronyms" },
  { id: "large-v3-turbo", name: "Whisper Large v3 Turbo", sizeMb: 1600, vramMb: 2500, accuracy: "Superior", desc: "State-of-the-art multilingual and complex technical speech" },
];

export function DictationModelSettings({
  selectedModelId = "base.en",
  onSelectModel,
  onDownloadModel,
  _onDeleteModel,
  className,
}: {
  selectedModelId?: string;
  onSelectModel?: (id: string) => void;
  onDownloadModel?: (id: string) => Promise<void> | void;
  _onDeleteModel?: (id: string) => Promise<void> | void;
  className?: string;
}) {
  const [engine, setEngine] = useState<"whisper" | "system">("whisper");
  const [activeModel, setActiveModel] = useState(selectedModelId);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [silenceMs, setSilenceMs] = useState(1500);
  const [customVocab, setCustomVocab] = useState("TypeScript, GraphQL, Next.js, Kubernetes");

  const handleDownload = async (id: string) => {
    setDownloadingId(id);
    try {
      await onDownloadModel?.(id);
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <div className={cn("p-4 rounded-2xl border border-inset bg-surface shadow-sm space-y-4", className)}>
      <div className="flex items-center justify-between border-b border-inset pb-3">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-accent/10 text-accent">
            <Mic size={18} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-ink">Dictation & Speech-to-Text Engine</h3>
            <p className="text-xs text-ink-secondary">
              Use local open-source Whisper models or native platform speech APIs.
            </p>
          </div>
        </div>

        <div className="flex items-center bg-inset p-0.5 rounded-lg border border-inset text-xs font-medium">
          <button
            onClick={() => setEngine("whisper")}
            className={cn(
              "px-3 py-1 rounded-md transition-colors",
              engine === "whisper" ? "bg-surface text-ink shadow-sm" : "text-ink-secondary hover:text-ink"
            )}
          >
            Local Whisper
          </button>
          <button
            onClick={() => setEngine("system")}
            className={cn(
              "px-3 py-1 rounded-md transition-colors",
              engine === "system" ? "bg-surface text-ink shadow-sm" : "text-ink-secondary hover:text-ink"
            )}
          >
            System Native
          </button>
        </div>
      </div>

      {engine === "whisper" && (
        <div className="space-y-4">
          <div>
            <div className="text-xs font-medium text-ink mb-2 flex items-center justify-between">
              <span>Installed Speech Models:</span>
              <span className="text-[11px] text-ink-secondary">Quantized GGUF / Metal & DirectML accelerated</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {SPEECH_TIERS.map((tier) => {
                const isSelected = activeModel === tier.id;
                const isBusy = downloadingId === tier.id;
                return (
                  <div
                    key={tier.id}
                    className={cn(
                      "p-3 rounded-xl border flex flex-col justify-between transition-colors",
                      isSelected ? "border-accent bg-accent/5 shadow-sm" : "border-inset bg-raised/20 hover:bg-raised/40"
                    )}
                  >
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-ink">{tier.name}</span>
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-raised text-ink-secondary">
                          {tier.sizeMb} MB
                        </span>
                      </div>
                      <p className="text-[11px] text-ink-secondary mt-1">{tier.desc}</p>
                    </div>

                    <div className="flex items-center justify-between mt-3 pt-2 border-t border-inset">
                      <div className="flex items-center gap-1.5 text-[10px] text-ink-tertiary">
                        <HardDrive size={11} /> {tier.vramMb}MB RAM
                        <span className="text-accent font-medium">· {tier.accuracy}</span>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => {
                            setActiveModel(tier.id);
                            onSelectModel?.(tier.id);
                          }}
                          className={cn(
                            "px-2.5 py-1 text-xs font-medium rounded-lg transition-colors",
                            isSelected
                              ? "bg-accent text-white"
                              : "bg-surface text-ink border border-inset hover:bg-raised"
                          )}
                        >
                          {isSelected ? "Active" : "Select"}
                        </button>
                        <button
                          onClick={() => handleDownload(tier.id)}
                          disabled={isBusy}
                          className="p-1 text-ink-secondary hover:text-ink rounded-lg hover:bg-raised transition-colors"
                          title="Download Weights"
                        >
                          <Download size={13} className={isBusy ? "animate-bounce text-accent" : ""} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="p-3.5 rounded-xl border border-inset bg-raised/20 space-y-3">
            <div>
              <label className="text-xs font-medium text-ink block mb-1">
                Developer Vocabulary & Prompt Biasing:
              </label>
              <input
                type="text"
                value={customVocab}
                onChange={(e) => setCustomVocab(e.target.value)}
                placeholder="Comma separated coding terms to bias Whisper transcription..."
                className="w-full px-3 py-1.5 text-xs rounded-xl bg-surface border border-inset text-ink outline-none"
              />
              <p className="text-[10px] text-ink-tertiary mt-1">
                Biased terms prevent Whisper from misinterpreting specialized library names and syntax.
              </p>
            </div>

            <div>
              <div className="flex items-center justify-between text-xs font-medium text-ink mb-1">
                <span className="flex items-center gap-1.5">
                  <Sliders size={13} className="text-ink-secondary" />
                  Voice Activity Detection (VAD) Silence Timeout:
                </span>
                <span className="font-mono text-ink-secondary">{(silenceMs / 1000).toFixed(1)}s</span>
              </div>
              <input
                type="range"
                min="500"
                max="3000"
                step="100"
                value={silenceMs}
                onChange={(e) => setSilenceMs(parseInt(e.target.value, 10))}
                className="w-full accent-accent cursor-pointer"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
