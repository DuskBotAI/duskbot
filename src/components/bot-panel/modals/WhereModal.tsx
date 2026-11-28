import { t } from "@/lib/i18n";
import { openPlaceAction, placeHasIssue } from "@/lib/place-view";
import { useStore, type Bot } from "@/state/store";
import { usePlaceViews } from "../../PlaceChip";
import type { useBotSettingsDerived } from "../../bot-settings/useBotSettingsDerived";
import { Card, CheckRow, NavRow, RowIcon, SheetPane } from "../../ListRows";
import { placeGlyph } from "../../PlaceIcon";
import type { PlaceActionId } from "../../../../shared/place-view";
import { CloudDesktopListRow } from "../CloudDesktop";
import { usePlacePicker, type PlaceChoice } from "../ComputerTab";

const PLACE_LINE: Partial<Record<PlaceChoice, (name: string) => string>> = {
  auto: (name) => `${name} picks the right place for each task`,
  local: () => "Your apps, files and screen, right here",
  cloud: () => "A desktop in the cloud that runs while yours sleeps",
  vm: () => t("computer.dest.vmDesc"),
};

// steps choosing the cloud row carries out by itself
const ON_CHOOSE: ReadonlySet<PlaceActionId> = new Set(["watch", "open-computer-panel", "turn-on-browser", "start", "wake", "try-again"]);

/** Where the bot works, kept to this computer, the private desktop and the cloud desktop: the chosen one checked, and the
 * cloud's one setup step under its row when it needs one. */
export function WhereModal({ bot, derived, onClose }: {
  bot: Bot;
  derived: ReturnType<typeof useBotSettingsDerived>;
  onClose: () => void;
}) {
  const { dispatch } = useStore();
  const { options, current, usingNow, choosePlace, warning, cloudDesktop } = usePlacePicker(bot, derived);
  const cloud = usePlaceViews(bot).cloud;
  const title = t("botPanel.ui.computerSimpleWhereWorks", { name: bot.name });
  const editable = bot.yourAccess !== "view";
  const rows = options.filter((option) => option.value === "local" || option.value === "vm" || option.value === "cloud" || option.value === current);
  const setup = cloud.policy && (!cloud.reachable || placeHasIssue(cloud.view)) && cloud.view.action && !ON_CHOOSE.has(cloud.view.action.id)
    ? cloud.view.action : null;

  return (
    <SheetPane data-panel-modal="where" title={title}>
      <Card data-sheet-group="where" footnote={usingNow ? <span data-panel-using-now>{t("botPanel.ui.computerSimpleUsingNow", { place: usingNow })}</span>
        : !editable ? `only people who can edit ${bot.name} can change this.` : undefined}>
        <div role="radiogroup" aria-label={title} className="contents">
          {rows.map((option) => (
            <CheckRow
              key={option.value}
              role="radio"
              data-panel-choice={option.value}
              leading={<RowIcon icon={placeGlyph(option.value)} />}
              title={option.label}
              hint={option.hint ?? PLACE_LINE[option.value]?.(bot.name)}
              checked={current === option.value}
              disabled={option.disabled || !editable}
              onClick={() => choosePlace(option.value)}
            />
          ))}
        </div>
        {setup && editable && (
          <NavRow
            data-sheet-row={`cloud-setup:${setup.id}`}
            title={setup.label}
            onClick={() => {
              onClose();
              openPlaceAction(setup.id, { botId: bot.id, threadId: bot.threadId, place: "cloud" }, dispatch);
            }}
          />
        )}
      </Card>
      {cloudDesktop && <Card data-sheet-group="cloud-desktop"><CloudDesktopListRow cloudDesktop={cloudDesktop} /></Card>}
      {warning}
    </SheetPane>
  );
}
