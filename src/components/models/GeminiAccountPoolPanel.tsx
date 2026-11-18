import { useState } from "react";
import { Users, Plus, ShieldCheck, AlertTriangle, RefreshCw, Clock } from "lucide-react";
import { cn } from "@/lib/cn";

export interface AccountPoolItem {
  id: string;
  email?: string;
  status: "healthy" | "cooling" | "exhausted" | "unauthenticated";
  requestCount: number;
  failureCount: number;
  cooldownRemainingSec?: number;
  lastError?: string;
}

export function GeminiAccountPoolPanel({
  instanceId = "gemini",
  strategy = "round-robin",
  accounts = [],
  onStrategyChange,
  onAddAccount,
  onRefreshHealth,
  className,
}: {
  instanceId?: string;
  strategy?: "round-robin" | "least-used" | "priority";
  accounts: AccountPoolItem[];
  onStrategyChange?: (strategy: "round-robin" | "least-used" | "priority") => void;
  onAddAccount?: () => void;
  onRefreshHealth?: () => void;
  className?: string;
}) {
  const [selectedStrategy, setSelectedStrategy] = useState(strategy);

  const handleStrategy = (s: "round-robin" | "least-used" | "priority") => {
    setSelectedStrategy(s);
    onStrategyChange?.(s);
  };

  const healthyCount = accounts.filter((a) => a.status === "healthy").length;

  return (
    <div
      className={cn(
        "rounded-2xl border border-inset bg-surface shadow-sm overflow-hidden flex flex-col p-4 space-y-4",
        className
      )}
    >
      <div className="flex items-center justify-between border-b border-inset pb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="p-2 rounded-xl bg-accent/10 text-accent">
            <Users size={18} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-ink flex items-center gap-2">
              Gemini Account Pool
              <span className="text-[11px] font-mono font-normal px-2 py-0.5 rounded-full bg-raised text-ink-secondary">
                {healthyCount} / {accounts.length} Healthy
              </span>
            </h3>
            <p className="text-xs text-ink-secondary">
              Instance: <span className="font-mono text-ink font-medium">{instanceId}</span> · Rotates across multiple Google profiles on 429 rate limits without failing turns.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {onRefreshHealth && (
            <button
              onClick={onRefreshHealth}
              className="p-1.5 text-ink-secondary hover:text-ink hover:bg-raised rounded-lg transition-colors"
              title="Refresh Quotas"
            >
              <RefreshCw size={15} />
            </button>
          )}
          {onAddAccount && (
            <button
              onClick={onAddAccount}
              className="px-3 py-1.5 text-xs font-medium rounded-xl bg-accent text-white hover:bg-accent/90 flex items-center gap-1.5 shadow-sm transition-colors"
            >
              <Plus size={14} /> Add Account
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between text-xs text-ink-secondary bg-raised/40 px-3 py-2 rounded-xl">
        <span>Load Balancing Strategy:</span>
        <div className="flex items-center gap-1 bg-inset p-0.5 rounded-lg border border-inset">
          {(["round-robin", "least-used", "priority"] as const).map((s) => (
            <button
              key={s}
              onClick={() => handleStrategy(s)}
              className={cn(
                "px-2.5 py-1 rounded-md capitalize font-medium transition-colors",
                selectedStrategy === s ? "bg-surface text-ink shadow-sm" : "text-ink-secondary hover:text-ink"
              )}
            >
              {s.replace("-", " ")}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        {accounts.length === 0 ? (
          <div className="text-center py-6 text-xs text-ink-secondary">
            No accounts in the pool yet. Connect a Google account to begin.
          </div>
        ) : (
          accounts.map((acc) => {
            const isHealthy = acc.status === "healthy";
            const isCooling = acc.status === "cooling";
            return (
              <div
                key={acc.id}
                className="flex items-center justify-between p-3 rounded-xl border border-inset bg-raised/20 hover:bg-raised/40 transition-colors"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  {isHealthy ? (
                    <ShieldCheck size={16} className="text-emerald-500 shrink-0" />
                  ) : isCooling ? (
                    <Clock size={16} className="text-warning shrink-0" />
                  ) : (
                    <AlertTriangle size={16} className="text-rose-500 shrink-0" />
                  )}
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-ink truncate">{acc.email || acc.id}</div>
                    <div className="text-[11px] text-ink-secondary">
                      {acc.requestCount} requests completed · {acc.failureCount} throttled
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {isCooling && acc.cooldownRemainingSec ? (
                    <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-warning/10 text-warning border border-warning/20">
                      Cooling ({acc.cooldownRemainingSec}s)
                    </span>
                  ) : (
                    <span
                      className={cn(
                        "text-[11px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded",
                        isHealthy ? "bg-emerald-500/10 text-emerald-500" : "bg-rose-500/10 text-rose-500"
                      )}
                    >
                      {acc.status}
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
