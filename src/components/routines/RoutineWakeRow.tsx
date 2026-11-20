import { useState } from "react";

import { t } from "@/lib/i18n";
import { useRoutineWake } from "@/lib/routine-sleep";
import { Card, SwitchRow } from "../ListRows";
import { sleepDeviceWord } from "../LateRoutineCard";

/** While a Mac sleeps no schedule runs: the shell can hold it awake the hour before one is due, or whenever a routine
 * is on, plugged in only. */
export function RoutineWakeRow() {
  const bridge = typeof window !== "undefined" ? window.duskDesktop?.routines : undefined;
  const [state, setState] = useRoutineWake(bridge, 30_000);
  const [busy, setBusy] = useState(false);
  if (!bridge || !state) return null;
  const act = (change: () => Promise<DesktopRoutineWake>) => {
    setBusy(true);
    change().then(setState).catch(() => {}).finally(() => setBusy(false));
  };
  const pluggedIn = state.pluggedIn === true;
  return (
    <Card data-settings-block="routine-wake">
      <SwitchRow
        title={t("automations.wake")}
        hint={state.keepAwake && state.onBattery ? t("automations.wakeBattery") : undefined}
        checked={state.keepAwake}
        disabled={busy}
        onChange={() => act(() => bridge.keepAwake(!state.keepAwake))}
      />
      {bridge.keepAwakePluggedIn && <SwitchRow
        data-panel-row="routine-wake-plugged-in"
        title={t("routines.sleep.awake", { device: sleepDeviceWord() })}
        hint={pluggedIn && state.onBattery ? t("automations.wakeBattery") : t("automations.wakePluggedInHint")}
        checked={pluggedIn}
        disabled={busy}
        onChange={() => act(() => bridge.keepAwakePluggedIn!(!pluggedIn))}
      />}
    </Card>
  );
}
