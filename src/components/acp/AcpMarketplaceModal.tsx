import { useState, useMemo } from "react";
import { Search, Download, Trash2, ExternalLink, Box, Tag } from "lucide-react";
import { cn } from "@/lib/cn";

export interface AcpMarketplaceAgent {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  homepage?: string;
  tags: string[];
  runtime: "node" | "python" | "binary";
  installed?: boolean;
  supportedModels: Array<{ id: string; label: string }>;
}

export function AcpMarketplaceModal({
  isOpen,
  agents = [],
  onInstall,
  onUninstall,
  onClose,
}: {
  isOpen: boolean;
  agents: AcpMarketplaceAgent[];
  onInstall?: (agentId: string) => Promise<void> | void;
  onUninstall?: (agentId: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedTag, setSelectedTag] = useState("All");
  const [installingId, setInstallingId] = useState<string | null>(null);

  const tags = useMemo(() => {
    const set = new Set<string>(["All"]);
    for (const a of agents) {
      for (const t of a.tags) set.add(t);
    }
    return Array.from(set);
  }, [agents]);

  const filtered = useMemo(() => {
    return agents.filter((a) => {
      const matchesTag = selectedTag === "All" || a.tags.includes(selectedTag);
      const q = query.trim().toLowerCase();
      const matchesQuery =
        !q ||
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        a.author.toLowerCase().includes(q);
      return matchesTag && matchesQuery;
    });
  }, [agents, selectedTag, query]);

  const handleInstall = async (id: string) => {
    setInstallingId(id);
    try {
      await onInstall?.(id);
    } finally {
      setInstallingId(null);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="ACP Agent Marketplace"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[85vh] bg-surface border border-inset rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-inset bg-raised/30">
          <div className="flex items-center gap-2">
            <Box size={18} className="text-accent" />
            <h2 className="text-sm font-semibold text-ink">ACP Agent Marketplace</h2>
            <span className="text-xs text-ink-secondary">· Discover and install community agents</span>
          </div>
          <button onClick={onClose} className="text-xs text-ink-secondary hover:text-ink">
            Esc to close
          </button>
        </div>

        <div className="p-4 border-b border-inset flex flex-col gap-3">
          <div className="flex items-center gap-2 px-3 py-2 bg-raised/50 border border-inset rounded-xl">
            <Search size={16} className="text-ink-tertiary" />
            <input
              type="text"
              placeholder="Search community agents by name, tag, or author..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full bg-transparent text-xs text-ink placeholder:text-ink-tertiary outline-none"
            />
          </div>

          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs">
            {tags.map((tag) => (
              <button
                key={tag}
                onClick={() => setSelectedTag(tag)}
                className={cn(
                  "px-2.5 py-1 rounded-lg font-medium transition-colors whitespace-nowrap",
                  selectedTag === tag
                    ? "bg-accent text-white shadow-sm"
                    : "bg-raised/60 text-ink-secondary hover:text-ink"
                )}
              >
                {tag}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {filtered.length === 0 ? (
            <div className="text-center py-12 text-xs text-ink-secondary">
              No community agents match your criteria.
            </div>
          ) : (
            filtered.map((agent) => {
              const isBusy = installingId === agent.id;
              return (
                <div
                  key={agent.id}
                  className="p-4 rounded-xl border border-inset bg-raised/20 hover:bg-raised/40 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div className="space-y-1.5 min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-ink">{agent.name}</span>
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-inset text-ink-secondary">
                        v{agent.version}
                      </span>
                      <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-accent/10 text-accent">
                        {agent.runtime}
                      </span>
                      {agent.homepage && (
                        <a
                          href={agent.homepage}
                          target="_blank"
                          rel="noreferrer"
                          className="text-ink-tertiary hover:text-ink transition-colors"
                          title="Visit Homepage"
                        >
                          <ExternalLink size={12} />
                        </a>
                      )}
                    </div>
                    <p className="text-xs text-ink-secondary leading-relaxed">{agent.description}</p>
                    <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                      {agent.tags.map((t) => (
                        <span key={t} className="flex items-center gap-1 text-[10px] text-ink-tertiary">
                          <Tag size={9} /> {t}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {agent.installed ? (
                      <button
                        onClick={() => onUninstall?.(agent.id)}
                        className="px-3 py-1.5 text-xs font-medium rounded-xl border border-rose-500/30 text-rose-500 hover:bg-rose-500/10 flex items-center gap-1.5 transition-colors"
                      >
                        <Trash2 size={13} /> Uninstall
                      </button>
                    ) : (
                      <button
                        onClick={() => handleInstall(agent.id)}
                        disabled={isBusy}
                        className="px-3.5 py-1.5 text-xs font-medium rounded-xl bg-accent text-white hover:bg-accent/90 disabled:opacity-50 flex items-center gap-1.5 shadow-sm transition-colors"
                      >
                        <Download size={13} /> {isBusy ? "Installing..." : "Install Agent"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
