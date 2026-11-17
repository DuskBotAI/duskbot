import { useEffect, useState, useMemo } from "react";
import { Bot, Scissors, Settings, Search, X } from "lucide-react";

export interface PaletteBotItem {
  id: string;
  name: string;
  role?: string;
}

export function GlobalCommandPalette({
  bots = [],
  onSelectBot,
  onTriggerCompact,
  onOpenSettings,
}: {
  bots?: PaletteBotItem[];
  onSelectBot?: (id: string) => void;
  onTriggerCompact?: () => void;
  onOpenSettings?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  const filteredBots = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return bots;
    return bots.filter(
      (b) => b.name.toLowerCase().includes(q) || (b.role && b.role.toLowerCase().includes(q))
    );
  }, [bots, query]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command Palette"
      className="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-lg bg-surface border border-inset rounded-2xl shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-inset">
          <Search size={18} className="text-ink-tertiary shrink-0" />
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search bots, actions, commands... (Esc to close)"
            className="flex-1 bg-transparent text-sm text-ink placeholder:text-ink-tertiary outline-none"
          />
          <button
            onClick={() => setOpen(false)}
            className="p-1 text-ink-tertiary hover:text-ink rounded-lg transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="max-h-80 overflow-y-auto p-2 space-y-3">
          <div>
            <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">
              Bots & Teammates
            </div>
            {filteredBots.length === 0 ? (
              <div className="px-3 py-2 text-xs text-ink-secondary">No matching bots found</div>
            ) : (
              <ul className="space-y-0.5">
                {filteredBots.map((bot) => (
                  <li key={bot.id}>
                    <button
                      onClick={() => {
                        onSelectBot?.(bot.id);
                        setOpen(false);
                      }}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-sm rounded-xl text-ink hover:bg-raised transition-colors"
                    >
                      <Bot size={16} className="text-accent shrink-0" />
                      <span className="font-medium">{bot.name}</span>
                      {bot.role && (
                        <span className="text-xs text-ink-secondary truncate">· {bot.role}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">
              Quick Actions
            </div>
            <ul className="space-y-0.5">
              <li>
                <button
                  onClick={() => {
                    onTriggerCompact?.();
                    setOpen(false);
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-sm rounded-xl text-ink hover:bg-raised transition-colors"
                >
                  <Scissors size={16} className="text-warning shrink-0" />
                  <span>Proactively Compact Active Context</span>
                </button>
              </li>
              <li>
                <button
                  onClick={() => {
                    onOpenSettings?.();
                    setOpen(false);
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-sm rounded-xl text-ink hover:bg-raised transition-colors"
                >
                  <Settings size={16} className="text-ink-secondary shrink-0" />
                  <span>Open App Settings</span>
                </button>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
