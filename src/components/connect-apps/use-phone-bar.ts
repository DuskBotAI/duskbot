import { useCallback, useEffect, useRef } from "react";
import { t } from "@/lib/i18n";
import { phoneApp } from "@/lib/store-app";
import { wakeSystemControls } from "@/lib/system-control";
import { BAR_RANK, useNativeBar } from "@/mobile/chrome";
import { closesOnBack } from "@/mobile/Sheet";

export function useConnectAppsPhoneBar(title: string, hasTrail: boolean, back: () => void, onClose: () => void) {
  const phone = phoneApp();
  const backRef = useRef(() => {});
  backRef.current = () => { if (hasTrail) back(); else onClose(); };
  const handleBack = useCallback(() => backRef.current(), []);
  const nativeBar = useNativeBar(BAR_RANK.screen, phone ? {
    title,
    leading: [{ id: "back", symbol: "chevron.backward", label: t("connectApps.back") }],
    trailing: hasTrail ? [{ id: "close", role: "close", label: t("connectApps.close") }] : [],
  } : null, { back: handleBack, close: onClose });
  useEffect(() => {
    if (!phone) return;
    wakeSystemControls();
    const stopBack = closesOnBack(handleBack);
    return () => { stopBack(); wakeSystemControls(); };
  }, [phone, handleBack]);
  return { phone, nativeBar };
}
