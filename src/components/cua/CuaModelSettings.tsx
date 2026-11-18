import { useState } from "react";
import { Monitor, Cpu, Cloud, Sliders, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/cn";

export interface CuaModelConfig {
  backend: "cloud" | "local";
  modelId: string;
  localEndpoint: string;
  resolution: "1024x768" | "1280x800" | "native";
  coordinateMode: "normalized-1000" | "pixels";
  takeoverOnCaptcha: boolean;
}

export const POPULAR_LOCAL_CUA_MODELS = [
  { id: "ui-tars-7b", name: "UI-TARS (7B)", provider: "ByteDance", desc: "Specialized GUI reasoning & action model" },
  { id: "qwen2.5-vl-7b", name: "Qwen 2.5 VL (7B)", provider: "Alibaba", desc: "Fine-grained visual coordinate grounding" },
  { id: "showui-2b", name: "ShowUI (2B)", provider: "ShowUI Team", desc: "Ultra-fast lightweight desktop navigation" },
];

export function CuaModelSettings({
  initialConfig,
  onSave,
  className,
}: {
  initialConfig?: Partial<CuaModelConfig>;
  onSave?: (config: CuaModelConfig) => void;
  className?: string;
}) {
  const [config, setConfig] = useState<CuaModelConfig>({
    backend: initialConfig?.backend ?? "cloud",
    modelId: initialConfig?.modelId ?? "claude-3-7-sonnet",
    localEndpoint: initialConfig?.localEndpoint ?? "http://localhost:11434/v1",
    resolution: initialConfig?.resolution ?? "1280x800",
    coordinateMode: initialConfig?.coordinateMode ?? "normalized-1000",
    takeoverOnCaptcha: initialConfig?.takeoverOnCaptcha ?? true,
  });

  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    onSave?.(config);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className={cn("p-4 rounded-2xl border border-inset bg-surface shadow-sm space-y-4", className)}>
      <div className="flex items-center justify-between border-b border-inset pb-3">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-accent/10 text-accent">
            <Monitor size={18} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-ink">Computer Use (CUA) Model & Grounding</h3>
            <p className="text-xs text-ink-secondary">
              Choose between proprietary cloud models or local open-source vision agents like UI-TARS.
            </p>
          </div>
        </div>

        <button
          onClick={handleSave}
          className="px-3.5 py-1.5 text-xs font-medium rounded-xl bg-accent text-white hover:bg-accent/90 shadow-sm transition-colors flex items-center gap-1.5"
        >
          {saved ? <CheckCircle2 size={13} className="text-white" /> : null}
          {saved ? "Saved" : "Save Changes"}
        </button>
      </div>

      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 p-1 bg-raised/40 rounded-xl border border-inset">
          <button
            onClick={() => setConfig((c) => ({ ...c, backend: "cloud", modelId: "claude-3-7-sonnet" }))}
            className={cn(
              "flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-medium transition-colors",
              config.backend === "cloud" ? "bg-surface text-ink shadow-sm" : "text-ink-secondary hover:text-ink"
            )}
          >
            <Cloud size={14} /> Cloud (Claude 3.7 Sonnet)
          </button>
          <button
            onClick={() => setConfig((c) => ({ ...c, backend: "local", modelId: "ui-tars-7b" }))}
            className={cn(
              "flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-medium transition-colors",
              config.backend === "local" ? "bg-surface text-ink shadow-sm" : "text-ink-secondary hover:text-ink"
            )}
          >
            <Cpu size={14} /> Local Open-Source Vision
          </button>
        </div>

        {config.backend === "local" && (
          <div className="space-y-3 p-3.5 rounded-xl border border-inset bg-raised/20">
            <div>
              <label className="text-xs font-medium text-ink block mb-1">Local Vision Model:</label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {POPULAR_LOCAL_CUA_MODELS.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => setConfig((c) => ({ ...c, modelId: m.id }))}
                    className={cn(
                      "p-2.5 rounded-xl border text-left transition-colors",
                      config.modelId === m.id
                        ? "border-accent bg-accent/5 text-ink shadow-sm"
                        : "border-inset bg-surface hover:bg-raised/60 text-ink-secondary hover:text-ink"
                    )}
                  >
                    <div className="text-xs font-semibold">{m.name}</div>
                    <div className="text-[10px] text-ink-tertiary">{m.provider}</div>
                    <div className="text-[11px] text-ink-secondary mt-1">{m.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-ink block mb-1">Local Inference Endpoint (Ollama / vLLM):</label>
              <input
                type="text"
                value={config.localEndpoint}
                onChange={(e) => setConfig((c) => ({ ...c, localEndpoint: e.target.value }))}
                placeholder="http://localhost:11434/v1"
                className="w-full px-3 py-1.5 text-xs rounded-xl bg-surface border border-inset text-ink outline-none"
              />
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
          <div>
            <label className="text-xs font-medium text-ink block mb-1 flex items-center gap-1.5">
              <Sliders size={13} className="text-ink-secondary" />
              Vision Downscaling Resolution:
            </label>
            <select
              value={config.resolution}
              onChange={(e) => setConfig((c) => ({ ...c, resolution: e.target.value as CuaModelConfig["resolution"] }))}
              className="w-full px-3 py-1.5 text-xs rounded-xl bg-surface border border-inset text-ink outline-none cursor-pointer"
            >
              <option value="1024x768">1024x768 (Fastest inference)</option>
              <option value="1280x800">1280x800 (Balanced UI accuracy)</option>
              <option value="native">Native Display Resolution</option>
            </select>
          </div>

          <div>
            <label className="text-xs font-medium text-ink block mb-1">Grounding Coordinate System:</label>
            <select
              value={config.coordinateMode}
              onChange={(e) => setConfig((c) => ({ ...c, coordinateMode: e.target.value as CuaModelConfig["coordinateMode"] }))}
              className="w-full px-3 py-1.5 text-xs rounded-xl bg-surface border border-inset text-ink outline-none cursor-pointer"
            >
              <option value="normalized-1000">Normalized 0–1000 Scale (UI-TARS & OpenBot standard)</option>
              <option value="pixels">Raw Screen Pixel Coordinates</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}
