import { useRef, useState } from "react";

import { requestChatFind } from "@/lib/chat-find";
import { copyTranscriptToClipboard, downloadMarkdownTranscript, formatTranscriptMarkdown, slugifyTranscriptFilename } from "@/lib/export-transcript";
import { t } from "@/lib/i18n";
import { openSettings } from "@/lib/open-settings";
import { systemMenu } from "@/lib/system-menu";
import { useStore } from "@/state/store";
import { ConfirmDialog } from "../ConfirmDialog";
import { PRESET_TURN_LIMITS, useConversationTurnLimit } from "../ConversationTurnLimit";
import { roomDeleteCopy } from "../room-delete-copy";
import { SelectPill } from "../ui/SelectPill";
import { Card, ItemRow, NavRow, PanelSections } from "../bot-panel/rows";
import { GroupUsageRow, RoomRows, type RoomRowsProps } from "./RoomDetailsTab";

function turnLimitLabel(minutes: number): string {
  if (minutes === 60) return t("room.panel.hour");
  if (minutes % 60 === 0) return t("room.panel.hours", { hours: minutes / 60 });
  return t("room.panel.minutes", { minutes });
}

/** The room's controls in the bot panel's Advanced anatomy: the room itself, its chat, apps, then deleting it. */
export function RoomAdvancedTab(props: RoomRowsProps) {
  const { group } = props;
  const { dispatch } = useStore();
  const limit = useConversationTurnLimit(group);
  const [deleting, setDeleting] = useState(false);
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const hasMessages = group.messages.length > 0;
  const transcript = () => formatTranscriptMarkdown({ title: group.name, messages: group.messages, isGroup: true });
  const turnOptions = [
    { value: "default", label: t("botPanel.ui.roomTurnLimitDefault", { minutes: limit.globalMinutes }) },
    ...PRESET_TURN_LIMITS.map((minutes) => ({ value: String(minutes), label: turnLimitLabel(minutes) })),
  ];

  return (
    <PanelSections data-panel-tabpanel="advanced">
      <Card label={t("room.panel.section.room")} anchor="room">
        <NavRow data-panel-page="about" title={t("botPanel.ui.botSettingsSimpleName")} value={group.name} onClick={() => props.onOpen("about")} />
        <NavRow
          data-panel-page="about-description"
          title={t("botPanel.ui.presetShareDescription")}
          value={group.description || t("room.panel.descriptionHint")}
          onClick={() => props.onOpen("about")}
        />
        <RoomRows {...props} />
      </Card>

      <Card label={t("room.panel.section.chat")} anchor="chat">
        <ItemRow
          data-panel-row="turn-limit"
          title={t("room.panel.turnLimit")}
          onClick={(event) => {
            if (!systemMenu()) return;
            const pill = event.currentTarget.querySelector<HTMLButtonElement>("[data-select-pill]");
            if (pill && !pill.contains(event.target as Node)) pill.click();
          }}
        >
          <SelectPill
            data-panel-select="turn-limit"
            aria-label={t("room.panel.turnLimit")}
            value={limit.saved === null ? "default" : String(limit.saved)}
            options={turnOptions}
            onChange={(value: string) => limit.save(value === "default" ? null : Number(value))}
          />
        </ItemRow>
        <GroupUsageRow group={group} />
        <NavRow data-panel-row="find" drill={false} title={t("chat.find")} onClick={() => requestChatFind(group.threadId)} />
        <NavRow
          data-panel-row="copy"
          drill={false}
          disabled={!hasMessages}
          title={t("chat.export.copyConversation")}
          value={copied && t(copied === "copied" ? "chat.export.copied" : "chat.export.copyFailed")}
          onClick={() => { void copyTranscriptToClipboard(transcript()).then((ok) => setCopied(ok ? "copied" : "failed")); }}
        />
        <NavRow
          data-panel-row="download"
          drill={false}
          disabled={!hasMessages}
          title={t("chat.export.downloadConversation")}
          onClick={() => downloadMarkdownTranscript(slugifyTranscriptFilename(group.name), transcript())}
        />
      </Card>

      <Card anchor="apps">
        <NavRow data-panel-row="apps" title={t("botPanel.ui.sidebarNavConnectedApps")} onClick={() => dispatch({ type: "togglePlugins", open: true, surface: "apps" })} />
        <NavRow data-panel-row="advanced-features" title={t("botPanel.ui.settingsPaneAdvanced")} onClick={() => dispatch(openSettings("advanced"))} />
      </Card>

      <Card label={t("botPanel.section.actions")} anchor="actions">
        <NavRow ref={deleteRef} data-panel-row="delete" drill={false} danger title={t("botPanel.ui.sidebarRoomDeleteChannel")} onClick={() => setDeleting(true)} />
      </Card>
      <ConfirmDialog
        open={deleting}
        {...roomDeleteCopy(group)}
        returnFocusRef={deleteRef}
        onCancel={() => setDeleting(false)}
        onConfirm={() => {
          setDeleting(false);
          dispatch({ type: "deleteGroup", groupId: group.id });
        }}
      />
    </PanelSections>
  );
}
