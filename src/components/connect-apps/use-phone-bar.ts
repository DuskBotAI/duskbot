import { useCallback, useEffect, useRef } from "react";
import { t } from "@/lib/i18n";
import { phoneApp } from "@/lib/store-app";
import { wakeSystemControls } from "@/lib/system-control";
import { BAR_RANK, useNativeBar, useNativePush, useSheetPushDepth } from "@/mobile/chrome";
import { closesOnBack } from "@/mobile/Sheet";

export function useConnectAppsPhoneBar(title: string, trailDepth: number, back: () => void, onClose: () => void) {
  const phone = phoneApp();
  const pushDepth = useSheetPushDepth();
  const nativePush = useNativePush();
  const hasTrail = trailDepth > 0;
  const pushed = pushDepth > 0;
  const totalDepth = pushDepth + (nativePush ? trailDepth : 0);
  const backRef = useRef(() => {});
  backRef.current = () => { if (hasTrail) back(); else onClose(); };
  const handleBack = useCallback(() => backRef.current(), []);
  const rank = totalDepth > 0 ? BAR_RANK.sheetPushed + totalDepth * 0.01 : BAR_RANK.sheetPage;
  const closeItem = { id: "close", role: "close" as const, label: t("connectApps.close") };
  const leading = nativePush
    ? totalDepth > 0
      ? [{ id: "back", symbol: "chevron.backward", label: t("connectApps.back") }]
      : [closeItem]
    : pushed
      ? [{ id: hasTrail ? "stepBack" : "back", symbol: "chevron.backward", label: t("connectApps.back") }]
      : hasTrail
        ? [{ id: "stepBack", symbol: "chevron.backward", label: t("connectApps.back") }]
        : [closeItem];
  const trailing = hasTrail && !pushed ? [closeItem] : [];
  const nativeBar = useNativeBar(rank, phone ? { title, leading, trailing } : null, {
    back: handleBack,
    stepBack: handleBack,
    close: onClose,
  });
  useEffect(() => {
    if (!phone) return;
    wakeSystemControls();
    const stopBack = hasTrail ? closesOnBack(handleBack) : null;
    return () => { stopBack?.(); wakeSystemControls(); };
  }, [phone, hasTrail, handleBack]);
  return { phone, nativeBar, handleBack };
}
