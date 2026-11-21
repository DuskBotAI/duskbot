import { useMemo, useRef, useState, type RefObject } from "react";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { Card } from "./ListRows";
import { dialogPrimaryCls, footnoteCls, GrokDialog, mdPrimaryCls, mdSecondaryCls } from "./ui/GrokDialog";
import { useStore, type Group } from "@/state/store";
import { BotPickerList } from "./BotPickerList";
import { nextMemberIds } from "@/lib/room-members";

function useManageMembers(group: Group, onClose: () => void) {
  const { state, dispatch } = useStore();
  const [picked, setPicked] = useState<Set<string>>(() => new Set(group.memberIds));
  const [saveError, setSaveError] = useState<string | null>(null);
  const openedMemberIds = useRef([...group.memberIds]);

  const bots = useMemo(
    () => state.bots.filter((b) => !b.hidden || group.memberIds.includes(b.id)),
    [state.bots, group.memberIds],
  );

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const memberIds = nextMemberIds(
    group.memberIds,
    picked,
    bots.map((b) => b.id),
  );
  const changed = memberIds.length !== group.memberIds.length || memberIds.some((id, i) => id !== group.memberIds[i]);

  const save = () => {
    if (!memberIds.length) return;
    const opened = openedMemberIds.current;
    const rosterChanged =
      opened.length !== group.memberIds.length || opened.some((id, index) => id !== group.memberIds[index]);
    if (rosterChanged) {
      setSaveError(t("sheet.rows.members.changed"));
      return;
    }
    if (changed) {
      dispatch({ type: "patchGroup", groupId: group.id, patch: { memberIds } });
      track("room_members_changed", {
        members: memberIds.length,
        added: memberIds.filter((id) => !group.memberIds.includes(id)).length,
        removed: group.memberIds.filter((id) => !memberIds.includes(id)).length,
      });
    }
    onClose();
  };

  return { bots, picked, toggle, memberIds, saveError, save };
}

/** Who is in the room, in Grok's form dialog: the room's name under the title, its bots as check rows. Focus goes back
 * to the control that opened it, which `triggerRef` names for callers. */
export function ManageMembersPanel({
  group,
  onClose,
}: {
  group: Group;
  onClose: () => void;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const { bots, picked, toggle, memberIds, saveError, save } = useManageMembers(group, onClose);

  return (
    <GrokDialog
      data-panel-modal="members"
      title={t("room.members.manage")}
      description={group.name}
      width={360}
      onClose={onClose}
      footer={<>
        <button type="button" onClick={onClose} className={mdSecondaryCls}>{t("common.cancel")}</button>
        <button type="button" onClick={save} disabled={!memberIds.length} className={mdPrimaryCls}>{t("sheet.rows.members.save")}</button>
      </>}
    >
      <div className="-mx-2 flex min-h-0 flex-col">
        <BotPickerList bots={bots} picked={picked} onToggle={toggle} emptyHint={t("sheet.rows.members.empty")} />
      </div>
      {(!memberIds.length || saveError) && (
        <p role={saveError ? "alert" : undefined} className={cn(footnoteCls, "pl-0 pt-2", saveError && "text-danger")}>
          {saveError ?? t("sheet.rows.members.needOne")}
        </p>
      )}
    </GrokDialog>
  );
}

/** Phone pushed-page version of ManageMembersPanel, rendered inside a native SheetPush. */
export function ManageMembersPage({ group, onClose }: { group: Group; onClose: () => void }) {
  const { bots, picked, toggle, memberIds, saveError, save } = useManageMembers(group, onClose);
  const note = !memberIds.length || saveError ? (
    <span role={saveError ? "alert" : undefined} className={cn(saveError && "text-danger")}>
      {saveError ?? t("sheet.rows.members.needOne")}
    </span>
  ) : undefined;

  return (
    <div data-panel-modal="members" className="flex flex-col gap-5 px-4 pb-8 pt-2">
      <Card label={group.name} footnote={note}>
        <BotPickerList inline bots={bots} picked={picked} onToggle={toggle} emptyHint={t("sheet.rows.members.empty")} />
      </Card>
      <button type="button" onClick={save} disabled={!memberIds.length} className={cn(dialogPrimaryCls, "h-12 w-full text-[16px] font-medium")}>
        {t("sheet.rows.members.save")}
      </button>
    </div>
  );
}
