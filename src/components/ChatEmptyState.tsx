import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { BotAvatar } from "./Avatar";

export function EmptyChat({ bot }: { bot: Bot }) {
  const about = bot.description?.trim() || bot.title?.trim();
  return (
    <div className="flex min-h-[60dvh] flex-1 items-center justify-center px-8" data-empty-chat={bot.id}>
      <div className="flex max-w-[420px] flex-col items-center gap-2 text-center">
        <BotAvatar bot={bot} state="happy" size={56} animated={false} />
        <p className="mt-1 text-[17px] font-semibold leading-6 text-ink">{bot.name}</p>
        {about && <p dir="auto" className="line-clamp-3 text-pretty text-[14px] leading-5 text-ink-secondary">{about}</p>}
        <p role="status" className="text-pretty text-[14px] leading-5 text-ink/[0.56]">{t("chat.empty.status")}</p>
      </div>
    </div>
  );
}
