import { useState } from "react";
import { AnimatePresence } from "motion/react";
import { phoneAppEnabled } from "@/lib/feature-flags";

import { t } from "@/lib/i18n";
import { api, type ConfigStatus } from "@/state/store";
import { FormDialog, FormField, NavRow } from "./ListRows";
import { textFieldCls } from "./ui/GrokDialog";
import { friendlyError } from "@/lib/plain-error";

/** What a paired phone calls this computer; empty keeps the default. The row shows it, a small form changes it. */
export function ComputerNameRow({ saved, onSaved }: { saved: string; onSaved: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const next = draft.trim();
    if (saving) return;
    if (next === saved) { setOpen(false); return; }
    setSaving(true);
    setError(null);
    try {
      const config: ConfigStatus = await api("/api/config", { method: "PATCH", body: JSON.stringify({ computerName: next }) });
      onSaved(config.computerName ?? next);
      setOpen(false);
    } catch (e) {
      setError(t("remote.computerName.error", { error: friendlyError(e) }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <NavRow data-computer-name="" data-settings-open="computer-name" pixel="laptop" title={t("remote.computerName.title")} value={saved || t("settings.s2.pairing.defaultName")}
        onClick={() => { setDraft(saved); setError(null); setOpen(true); }} />
      <AnimatePresence>{open && (
        <FormDialog key="computer-name" data-panel-modal="computer-name" title={t("remote.computerName.title")} description={t(phoneAppEnabled() ? "remote.computerName.help" : "remote.computerName.helpNoPhone")} busy={saving}
          error={error ?? undefined} onSave={save} onClose={() => setOpen(false)}>
          <FormField label={t("remote.computerName.title")}>
            <input id="computer-name" autoFocus value={draft} disabled={saving} placeholder={t("remote.computerName.placeholder")} maxLength={60}
              onChange={(event) => setDraft(event.target.value)} className={textFieldCls} />
          </FormField>
        </FormDialog>
      )}</AnimatePresence>
    </>
  );
}
