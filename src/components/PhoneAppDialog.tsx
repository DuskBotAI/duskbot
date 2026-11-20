import { t } from "@/lib/i18n";
import { MobilePairingCard } from "./MobilePairingCard";
import { GrokDialog } from "./ui/GrokDialog";

/** Connect your phone: one QR at once, for this place and, through the account it signs the phone in to, every other
 * place the person has. The phone asks which one to open. */
export function PhoneAppDialog({ open, onClose, remote, cloudHome, email }: {
  open: boolean;
  onClose: () => void;
  /** the window shows another server's page: its own pairing code */
  remote: boolean;
  cloudHome: boolean;
  email?: string;
}) {
  if (!open) return null;
  return (
    <GrokDialog data-panel-modal="phone" title={t("sidebar.menu.connectPhone")} width={480} onClose={onClose}>
      <MobilePairingCard remote={remote} cloudHome={cloudHome} email={email} direct={{ onDone: onClose }} />
    </GrokDialog>
  );
}
