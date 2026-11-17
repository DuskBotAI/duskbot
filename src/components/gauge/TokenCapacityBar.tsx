import { Scissors, Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";

export function TokenCapacityBar({
  usedTokens,
  maxTokens,
  cacheHitPercent = 0,
  onCompact,
  className,
}: {
  usedTokens: number;
  maxTokens: number;
  cacheHitPercent?: number;
  onCompact?: () => void;
  className?: string;
}) {
  const percentage = Math.min(100, Math.round((usedTokens / Math.max(1, maxTokens)) * 100));
  const isHigh = percentage >= 85;
  const isMedium = percentage >= 70 && percentage < 85;

  return (
    <div
      className={cn(
        "flex items-center gap-3 px-3 py-1.5 bg-raised/40 border border-inset rounded-xl text-xs font-mono select-none",
        className
      )}
    >
      <div className="flex-1 flex flex-col gap-1 min-w-0">
        <div className="flex items-center justify-between text-[11px] text-ink-secondary">
          <span className="truncate">
            Context: <strong className="text-ink">{usedTokens.toLocaleString()}</strong> /{" "}
            {maxTokens.toLocaleString()} tokens ({percentage}%)
          </span>
          {cacheHitPercent > 0 && (
            <span className="flex items-center gap-1 text-emerald-500 font-semibold shrink-0">
              <Sparkles size={11} />
              {cacheHitPercent}% cache hit
            </span>
          )}
        </div>
        <div className="w-full h-1.5 bg-inset rounded-full overflow-hidden">
          <div
            className={cn(
              "h-full transition-all duration-300 rounded-full",
              isHigh ? "bg-rose-500" : isMedium ? "bg-warning" : "bg-accent"
            )}
            style={{ width: `${percentage}%` }}
          />
        </div>
      </div>

      {onCompact && (
        <button
          onClick={onCompact}
          title="Proactively compact conversation context"
          className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg bg-surface hover:bg-raised text-ink border border-inset transition-colors shrink-0 shadow-sm"
        >
          <Scissors size={12} className="text-warning" />
          <span>Compact</span>
        </button>
      )}
    </div>
  );
}
