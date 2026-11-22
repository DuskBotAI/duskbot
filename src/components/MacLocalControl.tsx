import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, Shield } from "../icons";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { macCuaPermissionMessage, macPermissionPaneToOpen, missingMacCuaPermissions } from "@/lib/mac-cua-permissions";
import { macPermissionsBridge } from "@/lib/mac-permissions";
import { MacCuaRecoveryActions } from "./MacCuaRecoveryActions";
import { t } from "@/lib/i18n";
import { friendlyError } from "@/lib/plain-error";

export function MacLocalControl() {
  const { capabilities } = useDesktopCapabilities();
  const reason = capabilities.localComputer.available ? null : capabilities.localComputer.message;
  const permissionMessage = macCuaPermissionMessage(missingMacCuaPermissions(reason), reason);
  const [pending, setPending] = useState(false);
  const [awaitingGrant, setAwaitingGrant] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const retry = async () => {
    setPending(true);
    setError(null);
    try {
      await window.duskDesktop?.localControl?.retry();
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setPending(false);
    }
  };

  const openSettings = async () => {
    setError(null);
    setAwaitingGrant(true);
    try {
      const status = await macPermissionsBridge()?.status().catch(() => null) ?? null;
      await window.duskDesktop?.permOpenSettings?.(macPermissionPaneToOpen(reason, status));
    } catch (reason) {
      setAwaitingGrant(false);
      setError(friendlyError(reason));
    }
  };

  useEffect(() => {
    if (!awaitingGrant) return;
    let left = false;
    const onLeave = () => { left = true; };
    const onReturn = () => {
      if (document.visibilityState !== "visible") { left = true; return; }
      if (!left) return;
      setAwaitingGrant(false);
      void retry();
    };
    window.addEventListener("blur", onLeave);
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("blur", onLeave);
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [awaitingGrant]);

  if (capabilities.host.platform !== "darwin" || capabilities.localComputer.reasonCode === "remote-server") return null;
  if (capabilities.localComputer.available) return null;

  return (
    <section className="mt-4 rounded-[14px] border border-transparent bg-menu p-3">
      <div className="flex items-start gap-3">
        <Shield size={15} className="mt-0.5 shrink-0 text-ink/[0.56]" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium leading-[18px] text-ink">{t("computer.mac.permission.title")}</div>
          <p className="mt-0.5 text-[12px] leading-4 text-ink/[0.56]">
            {permissionMessage ?? t("computer.mac.permission.generic")}
          </p>
          {reason && !permissionMessage && <p className="mt-1 break-words text-[12px] leading-4 text-ink/[0.56]">{reason}</p>}
          {error && (
            <div className="mt-2 flex gap-1.5 text-[12px] text-danger">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {permissionMessage && reason && <MacCuaRecoveryActions reason={reason} ownRetry />}
            {!permissionMessage && (
              <button
                type="button"
                onClick={() => void openSettings()}
                disabled={pending}
                className="ui-button ui-button-primary h-6! min-h-6! px-2.5! text-[12px]! leading-4!"
              >
                {t("computer.mac.permission.openSettings")}
              </button>
            )}
            <button
              type="button"
              onClick={() => void retry()}
              disabled={pending}
              className="ui-button h-6! min-h-6! px-2.5! text-[12px]! leading-4!"
            >
              {pending && <Loader2 size={13} className="animate-spin" />}
              {t("computer.mac.permission.retry")}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
