import { useState } from "react";
import { Code, Eye, Copy, Check, Download } from "lucide-react";
import { cn } from "@/lib/cn";

export interface ArtifactFile {
  title: string;
  language: string;
  content: string;
}

export function SandpackArtifact({
  artifact,
  className,
}: {
  artifact: ArtifactFile;
  className?: string;
}) {
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(artifact.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const handleDownload = () => {
    const blob = new Blob([artifact.content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${artifact.title.replace(/\s+/g, "_")}.${artifact.language === "html" ? "html" : "txt"}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const isHtml = artifact.language.toLowerCase() === "html" || artifact.content.trim().startsWith("<!DOCTYPE") || artifact.content.trim().startsWith("<html");

  return (
    <div
      className={cn(
        "my-3 rounded-2xl border border-inset bg-surface shadow-sm overflow-hidden flex flex-col",
        className
      )}
    >
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-inset bg-raised/40">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-semibold text-ink truncate">{artifact.title}</span>
          <span className="text-[10px] font-mono uppercase bg-inset px-1.5 py-0.5 rounded text-ink-secondary">
            {artifact.language}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {isHtml && (
            <div className="flex items-center bg-inset p-0.5 rounded-lg border border-inset mr-1">
              <button
                onClick={() => setTab("preview")}
                className={cn(
                  "px-2 py-0.5 rounded text-xs flex items-center gap-1 transition-colors font-medium",
                  tab === "preview" ? "bg-surface text-ink shadow-sm" : "text-ink-secondary hover:text-ink"
                )}
              >
                <Eye size={13} /> Preview
              </button>
              <button
                onClick={() => setTab("code")}
                className={cn(
                  "px-2 py-0.5 rounded text-xs flex items-center gap-1 transition-colors font-medium",
                  tab === "code" ? "bg-surface text-ink shadow-sm" : "text-ink-secondary hover:text-ink"
                )}
              >
                <Code size={13} /> Code
              </button>
            </div>
          )}

          <button
            onClick={handleCopy}
            className="p-1.5 text-ink-secondary hover:text-ink rounded-lg hover:bg-raised transition-colors"
            title="Copy Code"
          >
            {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
          </button>
          <button
            onClick={handleDownload}
            className="p-1.5 text-ink-secondary hover:text-ink rounded-lg hover:bg-raised transition-colors"
            title="Download File"
          >
            <Download size={14} />
          </button>
        </div>
      </div>

      <div className="relative min-h-[220px] max-h-[500px] overflow-auto">
        {tab === "preview" && isHtml ? (
          <iframe
            title={artifact.title}
            srcDoc={artifact.content}
            sandbox="allow-scripts allow-modals"
            className="w-full h-[360px] border-none bg-white"
          />
        ) : (
          <pre className="p-4 font-mono text-xs text-neutral-200 bg-neutral-950 whitespace-pre-wrap leading-relaxed overflow-x-auto">
            {artifact.content}
          </pre>
        )}
      </div>
    </div>
  );
}
