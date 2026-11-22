import { t } from "@/lib/i18n";
import { myDefaultBot, useViewerEmail } from "@/lib/default-bot";
import { useStore } from "@/state/store";
import { showDefaultBot } from "./DefaultBotControls";
import { buttonCls } from "./bot-panel/rows";

/** A sidebar with no bot or room in it: says so, and offers the hidden main bot back and a new bot. */
export function SidebarEmpty({ canAdd }: { canAdd: boolean }) {
  const { state, dispatch } = useStore();
  const main = myDefaultBot(state.bots, useViewerEmail());
  const hiddenMain = main && main.sidebarHidden && !main.hidden ? main : null;
  return (
    <div data-sidebar-empty="" className="flex flex-col items-center gap-2.5 px-3 py-6 text-center">
      <p className="text-[13px] leading-[18px] text-ink-secondary">{t("sidebar.empty.title")}</p>
      <div className="flex flex-wrap justify-center gap-2">
        {hiddenMain && <button type="button" className={buttonCls} onClick={() => showDefaultBot(dispatch, hiddenMain, true)}>{t("sidebar.empty.show", { name: hiddenMain.name })}</button>}
        {canAdd && <button type="button" className={buttonCls} onClick={() => dispatch({ type: "newBot" })}>{t("sidebar.grok.newBot")}</button>}
      </div>
    </div>
  );
}
