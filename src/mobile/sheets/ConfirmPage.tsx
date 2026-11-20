import { useState } from "react";
import { WorkingDots } from "@/components/WorkingIndicator";
import { t } from "@/lib/i18n";
import { haptic } from "../haptics";
import { Sheet } from "../Sheet";
import { SettingsSection } from "./SettingsRow";

/** A Settings step that asks before something the phone can't undo by itself: what happens, then Cancel or the action.
 * Pushed in the Settings stack, so back or Cancel leaves everything as it was. */
export function ConfirmPage({ title, heading, body, action, onConfirm, onCancel }: {
  title: string;
  heading: string;
  body: string;
  action: string;
  /** the app opens again on what is left once this resolves */
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  const [working, setWorking] = useState(false);
  const confirm = async () => {
    if (working) return;
    setWorking(true);
    haptic("tap");
    await onConfirm().catch(() => setWorking(false));
  };
  return (
    <Sheet open onClose={working ? () => {} : onCancel} title={title}>
      <SettingsSection card>
        <div className="px-4 py-4" aria-busy={working}>
          <p className="text-[16px] font-semibold text-ink">{heading}</p>
          <p className="mt-1 text-[14px] leading-5 text-ink-secondary">{body}</p>
          <div className="mt-4 flex gap-2">
            <button type="button" disabled={working} onClick={onCancel} className="mobile-press flex min-h-11 flex-1 items-center justify-center rounded-full bg-ink/[0.06] px-4 text-[15px] font-semibold text-ink">{t("mobile.settings.cancel")}</button>
            <button type="button" data-confirm-action disabled={working} onClick={() => void confirm()} className="mobile-press flex min-h-11 flex-1 items-center justify-center rounded-full bg-danger px-4 text-[15px] font-semibold text-[var(--color-danger-ink)] disabled:opacity-60">
              {working ? <WorkingDots /> : action}
            </button>
          </div>
        </div>
      </SettingsSection>
    </Sheet>
  );
}
