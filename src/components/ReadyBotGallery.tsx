import { useEffect, useState } from "react";
import { Loader2 } from "../icons";
import { stoppedAtBotLimit } from "@/lib/bot-limit";
import { BotCreationDraft } from "@/lib/bot-creation-draft";
import { createConfiguredBot } from "@/lib/create-configured-bot";
import { announceNewBot, reportsToFor, startingTemplate } from "@/lib/new-bot";
import { prefetchBotDefaults, readBotDefaults } from "@/lib/bot-defaults-prefetch";
import { useTeamPeople } from "@/state/team-people";
import { MausAvatar } from "./Avatar";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import { READY_BOT_CATEGORIES, READY_BOTS, matchesReadyBot, readyBot, readyBotTemplate, type ReadyBotCategory } from "@/lib/ready-bots";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { useStore, type Bot } from "@/state/store";
import { friendlyError } from "@/lib/plain-error";

const CATEGORY_KEYS: Record<ReadyBotCategory, LocaleKey> = {
  everyday: "readyBots.category.everyday", work: "readyBots.category.work", writing: "readyBots.category.writing",
  design: "readyBots.category.design", sales: "readyBots.category.sales", personal: "readyBots.category.personal",
};

/** The category pills, drawn where Templates puts them (beside its search); the gallery under them shows that category. */
export function ReadyBotCategories({ value, onChange }: { value: ReadyBotCategory | null; onChange: (next: ReadyBotCategory | null) => void }) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={t("readyBots.categories")}>
      {[null, ...READY_BOT_CATEGORIES].map((one) => <button key={one ?? "all"} type="button" aria-pressed={value === one}
        onClick={() => onChange(one)}
        className={cn("inline-flex h-7 items-center rounded-full px-2.5 text-[13px] leading-[18px] tracking-[0.015em] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus",
          value === one ? "bg-ink text-app hover:bg-[color-mix(in_srgb,var(--color-ink)_88.5%,var(--color-menu))]" : "bg-ink/6 text-ink hover:bg-ink/10")}>
        {one ? t(CATEGORY_KEYS[one]) : t("readyBots.all")}
      </button>)}
    </div>
  );
}

export function ReadyBotGallery({ search, category, onDialog, onAdded }: {
  search: string;
  category: ReadyBotCategory | null;
  /** A confirm is open over Templates, so Templates must leave its keys alone. */
  onDialog: (open: boolean) => void;
  onAdded: (bot: Bot) => void;
}) {
  const { state, dispatch } = useStore();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [making, setMaking] = useState<string | null>(null);
  const team = useTeamPeople();
  useEffect(() => { if (!window.duskDesktop?.remoteClient?.active) prefetchBotDefaults(); }, []);
  const ask = (id: string | null) => { setConfirming(id); onDialog(id !== null); };
  // one click makes the bot, as Grok's create does; it is tuned afterwards in its settings
  const add = async (id: string, allowLocalAuto = false) => {
    const ready = readyBot(id);
    if (!ready || making || state.botCreationPending || stoppedAtBotLimit(state)) return;
    // a paired device may not read the host's New bot defaults the bot is filled from
    if (window.duskDesktop?.remoteClient?.active) { dispatch({ type: "newBot", onCreated: onAdded }); return; }
    setMaking(id);
    dispatch({ type: "botCreationPending", on: true });
    let draft: BotCreationDraft | undefined;
    try {
      const defaults = startingTemplate(await readBotDefaults(), true);
      draft = new BotCreationDraft(readyBotTemplate(defaults, ready), () => {});
      draft.role = ready.id;
      // auto approvals on this computer need an explicit yes
      if (draft.bot.approvalMode === "auto" && draft.bot.computer === "local") {
        if (!allowLocalAuto) { ask(id); return; }
        draft.consent.acknowledgeLocalAuto = true;
      }
      const { bot, warnings } = await createConfiguredBot(draft, undefined, undefined, undefined, undefined,
        team ? reportsToFor(null, draft.bot.section, state.bots, team) ?? undefined : undefined);
      announceNewBot(dispatch, bot, warnings, { source: "template", role: ready.id });
      onAdded(bot);
    } catch (cause) {
      dispatch({ type: "error", message: friendlyError(cause) });
    } finally {
      draft?.dispose();
      dispatch({ type: "botCreationPending", on: false });
      setMaking(null);
    }
  };
  const visible = READY_BOTS.filter((bot) => (!category || bot.category === category) && matchesReadyBot(bot, search));
  if (search.trim() && visible.length === 0) return null;
  return <section className="mb-8" aria-label={t("readyBots.title")}>
    <div className="-mx-3 grid grid-cols-1 md:grid-cols-2">
      {visible.map((bot) => <article key={bot.id} data-ready-bot={bot.id} title={bot.description} className="flex min-w-0 items-center gap-3 rounded-[16px] p-3 hover:bg-ink/[0.035]">
        <MausAvatar color={bot.look.color} bodyId={bot.look.mascotBody} size={32} animated={false} label={bot.name} />
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <h4 className="m-0 truncate text-[13px] font-medium leading-[18px] text-ink">{bot.name}</h4>
          <p className="m-0 truncate text-[13px] leading-[18px] text-ink/68">{bot.title} · {t(CATEGORY_KEYS[bot.category])}</p>
        </div>
        <button type="button" onClick={() => void add(bot.id)} disabled={making !== null} aria-busy={making === bot.id || undefined}
          aria-label={t("readyBots.addAria", { name: bot.name, title: bot.title })}
          className="inline-flex h-[26px] shrink-0 cursor-pointer items-center gap-1 rounded-[13px] bg-ink/6 px-2.5 text-[12px] leading-4 tracking-[0.015em] text-ink hover:bg-ink/10 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus disabled:cursor-default disabled:hover:bg-ink/6">
          {making === bot.id && <Loader2 size={12} className="animate-spin" />}{t("readyBots.add")}
        </button>
      </article>)}
    </div>
    <LocalComputerAutoWarning open={confirming !== null} onCancel={() => ask(null)} onConfirm={() => { const id = confirming; ask(null); if (id) void add(id, true); }} />
  </section>;
}
