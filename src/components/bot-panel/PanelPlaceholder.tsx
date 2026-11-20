import { useEffect } from "react";

import { t } from "@/lib/i18n";
import { Icon } from "../Icon";
import { Card, roundButtonCls } from "./rows";
import { PanelAdvancedTab, PanelDetailsTab } from "./PanelShell";
import { PANEL_TABS } from "./page-registry";
import { sidePanelCls } from "./side-panel";

const bar = "block rounded-md bg-ink/[0.06] motion-safe:animate-pulse";

/** The docked bot panel while the window loads: its frame and the shapes of what it will hold, never a guess at which
 * bot it will show. */
export function PanelPlaceholder({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    void PanelDetailsTab.preload().catch(() => {});
    void PanelAdvancedTab.preload().catch(() => {});
  }, []);
  return (
    <aside data-panel-placeholder aria-busy="true" className={sidePanelCls(false)}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 z-10 w-[0.5px] bg-edge max-md:hidden" />
        <div className="relative flex h-[60px] shrink-0 items-center gap-2 p-3">
          <span className="ms-auto" />
          <button type="button" onClick={onClose} aria-label={t("botPanel.closePanel")} title={t("botPanel.closePanel")} className={roundButtonCls}>
            <Icon name="close" size={16} />
          </button>
        </div>
        <div aria-hidden="true" className="flex min-h-0 flex-1 flex-col overflow-hidden px-4">
          <div className="flex flex-col items-center pb-3 pt-2">
            <span className={`${bar} size-16 rounded-full`} />
            <div className="mt-4 flex h-[26px] items-center"><span className={`${bar} h-4 w-24`} /></div>
          </div>
          <div className="flex justify-center gap-2 pb-2.5 pt-1">
            {PANEL_TABS.map((id) => <span key={id} className={`${bar} my-1 h-[18px] w-14 rounded-full`} />)}
          </div>
          <div className="flex flex-col gap-3 pt-2.5">
            {[3, 2, 4].map((rows, card) => (
              <Card key={card}>
                <div className="flex flex-col gap-3 px-3 py-3">
                  {Array.from({ length: rows }, (_, row) => <span key={row} className={`${bar} h-3.5`} style={{ width: `${72 - ((row + card) % 3) * 14}%` }} />)}
                </div>
              </Card>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}
