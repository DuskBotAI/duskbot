import { botAccentScope } from "@/lib/bot-accent";
import { t } from "@/lib/i18n";
import { Sheet } from "@/mobile/Sheet";
import type { Bot } from "@/state/store";
import { ModelPicker } from "./ModelPicker";

/** The bot's model beside the message box, switched in two taps: the chip, then a model. On a phone the menu is a bottom
 * sheet and the chip keeps only the engine's mark once there is text to send. */
export function ComposerModelChip({ bot, phone, typing }: { bot: Bot; phone: boolean; typing: boolean }) {
  return (
    <ModelPicker
      key={bot.threadId}
      bot={bot}
      threadId={bot.threadId}
      className="flex min-w-0 shrink"
      composer={{
        phone,
        iconOnly: phone && typing,
        ...(phone ? {
          present: ({ open, close, content }) => (
            <Sheet open={open} onClose={close} title={t("model.choose")}>
              <div {...botAccentScope(bot.color)} className="contents">{content}</div>
            </Sheet>
          ),
        } : {}),
      }}
    />
  );
}
