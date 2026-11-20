import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import {
  setFinishedNotifications,
  setNotificationSounds,
  useFinishedNotifications,
  useNotificationSounds,
} from "@/lib/notification-preferences";
import { requestNotificationPermission, systemNotificationsAllowed } from "@/lib/notify";
import { chooseSound, chosenSound, play, UI_SOUND_NAMES, type UiSoundName } from "@/lib/ui-sounds";
import type { LocaleKey } from "@/locales";
import { SettingRow, Switch } from "./SettingsPrimitives";
import { SettingsSelect } from "./SettingsSelect";

export function NotificationRows() {
  return (
    <>
      <DeviceNotificationsRow />
      <NotificationSoundsRow />
      <NotificationSoundPickerRow />
    </>
  );
}

const currentPermission = (): NotificationPermission => (typeof Notification !== "undefined" ? Notification.permission : "default");

/** A browser shows nothing until it is asked from a click; the person may also change the site permission elsewhere. */
export function DeviceNotificationsRow() {
  const [permission, setPermission] = useState(currentPermission);
  const enabled = useFinishedNotifications();
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") setPermission(currentPermission());
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  if (typeof Notification === "undefined" || !systemNotificationsAllowed()) return null;

  const blocked = permission === "denied";
  const toggle = async () => {
    if (permission === "granted") return setFinishedNotifications(!enabled);
    const next = await requestNotificationPermission();
    if (!next) return;
    setPermission(next);
    if (next === "granted") setFinishedNotifications(true);
  };

  return (
    <SettingRow
      icon="bell"
      title={t("settings.deviceNotifications.title")}
      subtitle={blocked ? t("settings.deviceNotifications.blocked") : undefined}
    >
      <Switch
        checked={permission === "granted" && enabled}
        disabled={blocked}
        aria-label={t("settings.deviceNotifications.title")}
        onClick={() => void toggle()}
      />
    </SettingRow>
  );
}

function NotificationSoundsRow() {
  const enabled = useNotificationSounds();
  return (
    <SettingRow icon="speaker" title={t("settings.notificationSound.playTitle")}>
      <Switch
        checked={enabled}
        aria-label={t("settings.notificationSound.playTitle")}
        onClick={() => {
          setNotificationSounds(!enabled);
          if (!enabled) play(chosenSound(), { force: true });
        }}
      />
    </SettingRow>
  );
}

const SOUND_LABELS: Record<UiSoundName, LocaleKey> = {
  "open-blip": "settings.notificationSound.openBlip",
  tick: "settings.notificationSound.tick",
  "double-tick": "settings.notificationSound.doubleTick",
  "chime-a": "settings.notificationSound.chimeA",
  "chime-b": "settings.notificationSound.chimeB",
};

/** Grok's ping picker: which of its five pings plays, heard once as it is chosen. Hidden while sounds are off. */
export function NotificationSoundPickerRow() {
  const enabled = useNotificationSounds();
  const [sound, setSound] = useState<UiSoundName>(chosenSound);
  if (!enabled) return null;
  return (
    <SettingRow icon="note" title={t("settings.notificationSound.title")}>
      <SettingsSelect
        value={sound}
        aria-label={t("settings.notificationSound.title")}
        options={UI_SOUND_NAMES.map((name) => ({ value: name, label: t(SOUND_LABELS[name]) }))}
        onChange={(event) => {
          const name = UI_SOUND_NAMES.find((candidate) => candidate === event.target.value);
          if (!name) return;
          chooseSound(name);
          setSound(name);
          play(name, { force: true });
        }}
      />
    </SettingRow>
  );
}
