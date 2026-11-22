import { Plus, RotateCcw } from "../icons";
import type { loadingLine } from "@/lib/app-loading";
import { t } from "@/lib/i18n";
import { retryLoad, type AppState } from "@/state/store";
import { MausAvatar } from "./Avatar";
import { ChatNotice } from "./ChatErrorBanner";
import { openCreateBot } from "./CreateBotDialog";
import { WindowDragStrip } from "./DesktopCapabilities";
import { rowButtonCls } from "./ui/GrokDialog";

/** The main area while there is no chat to show: the mascot waits while the app connects, and once the bots have
 * loaded and there are none it offers to make the first one. When the server never answered it says so, with Try again. */
export function AppEmptyMain({ loading, notice }: { loading: ReturnType<typeof loadingLine>; notice: AppState["notice"] }) {
  const empty = !loading.busy && !loading.failed;
  return (
    <main data-app-loading={loading.text} className="relative flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app px-4 text-center">
      <WindowDragStrip />
      <div className="w-full max-w-md"><ChatNotice notice={notice} /></div>
      <div aria-hidden="true"><MausAvatar color="chrome" size={56} state={loading.busy ? "loading" : "idle"} /></div>
      <div className="flex flex-col gap-1" role={loading.busy ? "status" : loading.failed ? "alert" : undefined}>
        <p className="text-[14px] font-medium leading-5 text-ink">{t(loading.text)}</p>
        {!loading.busy && <p className="text-[13px] leading-[18px] tracking-[0.015em] text-ink/[0.56]">{t(loading.failed ? "app.loading.unreachableHint" : "app.empty.hint")}</p>}
        {loading.command && (
          <p className="text-[12px] leading-4 text-ink/[0.56]">
            {t("app.loading.startServer")} <code className="rounded bg-raised px-1.5 py-0.5">pnpm dev:server</code>
          </p>
        )}
      </div>
      {loading.failed && (
        <button type="button" data-app-load-retry="" className={rowButtonCls} onClick={retryLoad}>
          <RotateCcw size={14} aria-hidden="true" />
          {t("app.loading.retry")}
        </button>
      )}
      {empty && (
        <button type="button" data-app-empty-create="" className={rowButtonCls} onClick={() => openCreateBot()}>
          <Plus size={14} aria-hidden="true" />
          {t("app.empty.create")}
        </button>
      )}
    </main>
  );
}
