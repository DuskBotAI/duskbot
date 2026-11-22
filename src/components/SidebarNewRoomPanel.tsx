import { useId, useState, type KeyboardEvent } from "react";
import { track } from "@/lib/analytics";
import { useStore } from "@/state/store";
import { activeLocale, t } from "@/lib/i18n";
import { BotPickerList } from "./BotPickerList";
import { fieldLabelCls, GrokDialog, mdPrimaryCls, mdSecondaryCls, rowHintCls, textFieldCls } from "./ui/GrokDialog";

const MIN_GROUP_BOTS = 2;

export function defaultGroupName(names: string[]): string {
  const shown = names.length > 3 ? [...names.slice(0, 2), t("sidebar.newChannel.more", { count: names.length - 2 })] : names;
  return new Intl.ListFormat(activeLocale(), { style: "long", type: "conjunction" }).format(shown);
}

/** Sidebar → New channel: name it, optionally file it under a context, pick its bots. */
export function NewRoomPanel({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const bots = state.bots.filter((b) => !b.hidden);
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const ready = picked.size >= MIN_GROUP_BOTS;
  const needsMore = bots.length > 0 && !ready;
  const hintId = useId();
  const fallbackName = ready ? defaultGroupName([...picked].map((id) => bots.find((bot) => bot.id === id)?.name ?? "").filter(Boolean)) : "";
  const create = () => {
    if (!ready) return;
    dispatch({
      type: "createGroup",
      memberIds: [...picked],
      name: name.trim() || fallbackName || undefined,
    });
    track("room_created", { members: picked.size, context: false });
    onClose();
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") create();
  };
  return (
    <GrokDialog
      title={t("sidebar.newChannel.title")}
      width={360}
      onClose={onClose}
      footer={<>
        <button type="button" onClick={onClose} className={mdSecondaryCls}>{t("common.cancel")}</button>
        <button type="button" onClick={create} disabled={!ready} aria-describedby={needsMore ? hintId : undefined} className={mdPrimaryCls}>{t("sidebar.newChannel.create")}</button>
      </>}
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className={fieldLabelCls}>{t("sidebar.newChannel.nameLabel")}</span>
          <input data-autofocus autoFocus maxLength={100} value={name} onChange={(event) => setName(event.target.value)} onKeyDown={onKey} placeholder={fallbackName || t("sidebar.newChannel.namePlaceholder")} className={textFieldCls} />
        </label>
        <div className="flex flex-col gap-1">
          <span className={fieldLabelCls}>{t("sidebar.newChannel.botsLabel")}</span>
          <div className="rounded-[10px] border border-transparent p-1">
            <BotPickerList bots={bots} picked={picked} onToggle={toggle} emptyHint={t("sidebar.newChannel.emptyHint")} />
          </div>
          {needsMore && <p id={hintId} className={`px-1 ${rowHintCls}`}>{t("sidebar.newChannel.pickTwo")}</p>}
        </div>
      </div>
    </GrokDialog>
  );
}
