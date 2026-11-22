import { AlertTriangle } from "../icons";
import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";

/** config.json could not be read: say which file, and whether the last good settings or the defaults are in use. */
export function ConfigFileStrip() {
  const { state } = useStore();
  const problem = state.config?.configFile;
  if (!problem) return null;
  return <div role="alert" data-config-file={problem.lastGood ? "last-good" : "defaults"} className="flex items-center justify-center gap-2 px-3 py-1.5 text-[13px] text-ink-secondary">
    <AlertTriangle size={14} aria-hidden="true" className="shrink-0" />
    <span>{t(problem.lastGood ? "liveConnection.configLastGood" : "liveConnection.configDefaults", { reason: problem.reason })}</span>
  </div>;
}
