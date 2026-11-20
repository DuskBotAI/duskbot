import { useState } from "react";
import { useCloud } from "../data/cloud";
import { longDate } from "../lib/format";
import { Button, Card } from "../ui/kit";

/** the one line a failed charge shows, wherever the plan or its cloud is: the cloud is stopped, its way back, and until
 *  when its data is kept */
export function paymentNoticeText(fixBy: number, cloudName: string | null, trial = false): string {
  const name = cloudName ?? "your cloud";
  return trial ? `your trial ended. upgrade to keep using ${name}. its data is deleted on ${longDate(fixBy)}.`
    : `your payment didn't go through. update your card to get ${name} back. its data is kept until ${longDate(fixBy)}.`;
}

export function PaymentNotice() {
  const { billing, clouds, updateCard } = useCloud();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const sub = billing?.subscription;
  if (sub?.status !== "past_due" || !sub.fixBy) return null;
  const name = sub.selection.desktop !== "none" ? clouds?.[0]?.name ?? "your cloud" : null;
  return (
    <Card className="flex flex-wrap items-center gap-4 !py-4" aria-live="polite" data-payment-notice>
      <div className="min-w-0 flex-1">
        <p className="text-14 text-ink">{paymentNoticeText(sub.fixBy, name, sub.trialUnpaid)}</p>
        {failed && <p role="alert" className="mt-1 text-13 text-bad">the card page didn't open. try again.</p>}
      </div>
      <Button size="sm" variant="primary" disabled={busy} onClick={() => {
        setBusy(true); setFailed(false);
        updateCard().catch(() => setFailed(true)).finally(() => setBusy(false));
      }}>{sub.trialUnpaid ? "upgrade" : "update card"}</Button>
    </Card>
  );
}
