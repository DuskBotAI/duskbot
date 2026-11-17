import { useState } from "react";
import { Check, X, FileCode, Columns2, Rows2 } from "lucide-react";
import { cn } from "@/lib/cn";

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: Array<{
    type: "add" | "del" | "context";
    content: string;
  }>;
}

export interface DiffFile {
  path: string;
  hunks: DiffHunk[];
}

export function DiffReviewModal({
  isOpen,
  file,
  onAccept,
  onReject,
  onClose,
}: {
  isOpen: boolean;
  file: DiffFile | null;
  onAccept?: () => void;
  onReject?: () => void;
  onClose: () => void;
}) {
  const [viewMode, setViewMode] = useState<"unified" | "split">("unified");

  if (!isOpen || !file) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Diff Review"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl max-h-[85vh] bg-surface border border-inset rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-inset bg-raised/30">
          <div className="flex items-center gap-2 min-w-0">
            <FileCode size={18} className="text-accent shrink-0" />
            <span className="font-mono text-sm font-semibold text-ink truncate">{file.path}</span>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center bg-inset p-0.5 rounded-lg border border-inset mr-2">
              <button
                onClick={() => setViewMode("unified")}
                className={cn(
                  "p-1 rounded-md text-xs flex items-center gap-1 transition-colors",
                  viewMode === "unified" ? "bg-surface text-ink shadow-sm" : "text-ink-secondary hover:text-ink"
                )}
                title="Unified Diff View"
              >
                <Rows2 size={14} />
              </button>
              <button
                onClick={() => setViewMode("split")}
                className={cn(
                  "p-1 rounded-md text-xs flex items-center gap-1 transition-colors",
                  viewMode === "split" ? "bg-surface text-ink shadow-sm" : "text-ink-secondary hover:text-ink"
                )}
                title="Split Diff View"
              >
                <Columns2 size={14} />
              </button>
            </div>

            <button
              onClick={() => {
                onReject?.();
                onClose();
              }}
              className="px-3 py-1.5 text-xs font-medium text-rose-500 hover:bg-rose-500/10 rounded-xl flex items-center gap-1.5 transition-colors"
            >
              <X size={14} /> Revert Changes
            </button>
            <button
              onClick={() => {
                onAccept?.();
                onClose();
              }}
              className="px-3.5 py-1.5 text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-700 rounded-xl flex items-center gap-1.5 transition-colors shadow-sm"
            >
              <Check size={14} /> Accept Hunks
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-4 font-mono text-xs bg-neutral-950 text-neutral-200 space-y-4">
          {file.hunks.map((hunk, hIdx) => (
            <div key={hIdx} className="rounded-xl border border-neutral-800 overflow-hidden bg-neutral-900/60">
              <div className="bg-neutral-900 px-3 py-1 text-neutral-400 text-[11px] select-none border-b border-neutral-800 font-semibold">
                @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
              </div>
              <div className="divide-y divide-neutral-900/40">
                {hunk.lines.map((line, lIdx) => {
                  const isAdd = line.type === "add";
                  const isDel = line.type === "del";
                  return (
                    <div
                      key={lIdx}
                      className={cn(
                        "flex items-start px-3 py-0.5 whitespace-pre leading-5 font-mono",
                        isAdd && "bg-emerald-950/40 text-emerald-300",
                        isDel && "bg-rose-950/40 text-rose-300"
                      )}
                    >
                      <span className="w-5 select-none opacity-50 shrink-0 font-bold">
                        {isAdd ? "+" : isDel ? "-" : " "}
                      </span>
                      <span className="flex-1 break-all">{line.content}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
