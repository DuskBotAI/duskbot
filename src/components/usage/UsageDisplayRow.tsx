import { t } from "@/lib/i18n";
import { setUsageDisplay, useUsageDisplay } from "@/lib/usage-display";
import { ItemRow } from "../ListRows";
import { SettingsSelect } from "../SettingsSelect";

/** Whether every usage figure in the app reads as the share used or the share remaining. */
export function UsageDisplayRow() {
  const display = useUsageDisplay();
  return (
    <ItemRow title={t("settings.usage.display.title")}>
      <SettingsSelect
        variant="segmented"
        data-settings-select="usage-display"
        value={display}
        aria-label={t("settings.usage.display.title")}
        options={[{ value: "used", label: t("settings.usage.display.used") }, { value: "left", label: t("settings.usage.display.left") }]}
        onChange={(event) => setUsageDisplay(event.target.value === "left" ? "left" : "used")}
      />
    </ItemRow>
  );
}
