import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { Loader2, Search, X } from "../../icons";
import { PROVIDER_SECTIONS, type ProviderSection } from "../../../shared/model-providers";
import type { SearchHit } from "../../../shared/model-search";
import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { cachedProviders, loadProviders, placeLine, useModelSearch, type ProviderInfo, type ProvidersAnswer } from "@/lib/model-providers";
import { Card, ItemRow, NavRow } from "../ListRows";
import { ConnectProviderDialog } from "./ConnectProviderDialog";
import { ModelBadges } from "./ModelBadges";

const SEARCH_ROW = "group/search flex h-9 items-center gap-2 rounded-[10px] bg-ink/[0.04] pl-3 pr-1.5";
const STATUS = "shrink-0 text-[12px] leading-4";

/** A catalog provider that is not one of ours, connected the same way with its own address. */
const moreProvider = (entry: ProvidersAnswer["more"][number]): ProviderInfo => ({
  id: entry.id, label: entry.label, section: "more", wire: "openai", baseUrl: "", listModels: "openai", offered: true, modelCount: entry.modelCount, connected: [],
});

export function providerStatus(provider: ProviderInfo): { text: string; tone?: "warn" } {
  if (provider.connected.length) return { text: t("models.status.connected") };
  if (provider.reason === "not-running") return { text: t("models.status.notRunning"), tone: "warn" };
  return { text: t("models.status.connect") };
}

/** Settings > Models: one search over every provider and model, and a short sheet to connect any of them where the
 * bots run. */
export function ModelDirectory() {
  const { state } = useStore();
  const [answer, setAnswer] = useState<ProvidersAnswer | null>(cachedProviders);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [showMore, setShowMore] = useState(false);
  const [connecting, setConnecting] = useState<{ provider: ProviderInfo; model?: string } | null>(null);
  const hits = useModelSearch(query, answer !== null);

  useEffect(() => {
    let live = true;
    loadProviders().then((next) => { if (live) setAnswer(next); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [state.instances]);

  if (!answer) {
    return failed ? null : (
      <Card label={t("models.directory.title")} data-settings-block="model-directory">
        <div role="status" className="flex items-center gap-2 px-2 py-2 text-[13px] text-ink-tertiary">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />{t("models.directory.loading")}
        </div>
      </Card>
    );
  }

  const offered = answer.providers.filter((provider) => provider.offered);
  const byId = new Map<string, ProviderInfo>([...answer.providers.map((p) => [p.id, p] as const), ...answer.more.map((m) => [m.id, moreProvider(m)] as const)]);
  const open = (providerId: string, model?: string) => {
    const provider = byId.get(providerId);
    if (provider) setConnecting({ provider, ...(model ? { model } : {}) });
  };
  const localHidden = answer.place === "cloud" && answer.providers.some((provider) => provider.reason === "cloud");

  return (
    <>
      <Card label={t("models.directory.title")} data-settings-block="model-directory"
        footnote={t("models.directory.footnote", { models: answer.catalog.models.toLocaleString(), date: new Date(answer.catalog.updatedAt).toLocaleDateString() })}>
        <div className="flex flex-col gap-1 p-1">
          <div className={SEARCH_ROW}>
            <Search size={15} className="shrink-0 text-ink-tertiary group-focus-within/search:text-ink-secondary" aria-hidden="true" />
            <input data-model-directory-search value={query} onChange={(event) => setQuery(event.target.value)}
              placeholder={t("models.directory.search")} aria-label={t("models.directory.search")} spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-[13px] leading-[18px] text-ink outline-none placeholder:text-ink-tertiary" />
            {query && (
              <button type="button" aria-label={t("model.simple.clearSearch")} onClick={() => setQuery("")}
                className="flex size-6 shrink-0 items-center justify-center rounded-full text-ink-tertiary hover:bg-ink/[0.06] hover:text-ink">
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </div>
          <p data-model-directory-place className="m-0 text-[12px] leading-4 text-ink-tertiary">{placeLine(answer.place)}</p>
        </div>
        {query.trim()
          ? <SearchResults hits={hits} query={query} onConnect={open} />
          : (
            <>
              {PROVIDER_SECTIONS.filter((section) => section !== "more").map((section) => (
                <ProviderSectionRows key={section} section={section} providers={offered.filter((provider) => provider.section === section)} onOpen={open} />
              ))}
              {localHidden && <p className="m-0 px-3 py-1.5 text-[12px] leading-4 text-ink-tertiary">{t("models.directory.noLocalOnCloud")}</p>}
              {answer.more.length > 0 && (
                <NavRow title={showMore ? t("models.directory.fewer") : t("models.directory.more", { count: answer.more.length })} drill={false}
                  aria-expanded={showMore} onClick={() => setShowMore((value) => !value)} />
              )}
              {showMore && answer.more.map((entry) => (
                <NavRow key={entry.id} title={entry.label} hint={t("models.directory.modelCount", { count: entry.modelCount })}
                  value={t("models.status.connect")} onClick={() => open(entry.id)} />
              ))}
            </>
          )}
      </Card>
      <AnimatePresence>{connecting && (
        <ConnectProviderDialog key="connect-provider-dialog" provider={connecting.provider} place={answer.place} model={connecting.model} onClose={() => setConnecting(null)} />
      )}</AnimatePresence>
    </>
  );
}

function ProviderSectionRows({ section, providers, onOpen }: { section: ProviderSection; providers: ProviderInfo[]; onOpen: (id: string) => void }) {
  if (!providers.length) return null;
  return (
    <div role="group" aria-label={t(`models.section.${section}`)} data-provider-section={section} className="mt-1 flex flex-col">
      <div className="px-2 pb-0.5 pt-1.5 text-[11px] font-medium leading-4 text-ink-tertiary">{t(`models.section.${section}`)}</div>
      {providers.map((provider) => {
        const status = providerStatus(provider);
        return (
          <NavRow key={provider.id} data-provider-row={provider.id} title={provider.label}
            hint={provider.note ?? (provider.modelCount ? t("models.directory.modelCount", { count: provider.modelCount }) : undefined)}
            value={<span className={cn(status.tone === "warn" && "text-warning")}>{status.text}</span>}
            onClick={() => onOpen(provider.id)} />
        );
      })}
    </div>
  );
}

function SearchResults({ hits, query, onConnect }: { hits: SearchHit[] | null; query: string; onConnect: (providerId: string, model?: string) => void }) {
  if (hits === null) {
    return (
      <div role="status" className="flex items-center gap-2 px-3 py-2 text-[13px] text-ink-tertiary">
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />{t("models.directory.searching")}
      </div>
    );
  }
  if (!hits.length) return <p role="status" className="m-0 px-3 py-3 text-[13px] text-ink-secondary">{t("model.noMatch", { query: query.trim() })}</p>;
  return (
    <div data-model-directory-results className="flex flex-col">
      {hits.map((hit) => (
        <div key={`${hit.group.providerId}:${hit.group.instanceId ?? ""}`} role="group" aria-label={hit.group.label} className="mt-1 flex flex-col">
          <div className="flex items-center gap-2 px-2 pb-0.5 pt-1.5">
            <span className="min-w-0 flex-1 truncate text-[11px] font-medium leading-4 text-ink-tertiary">{hit.group.label}</span>
            {hit.group.connected
              ? <span className={cn(STATUS, "text-ink-tertiary")}>{t("models.status.connected")}</span>
              : (
                <button type="button" data-connect-provider={hit.group.providerId} onClick={() => onConnect(hit.group.providerId)}
                  className={cn(STATUS, "rounded-[6px] px-1.5 text-ink-secondary hover:bg-ink/[0.06] hover:text-ink")}>
                  {t("models.status.connect")}
                </button>
              )}
          </div>
          {hit.models.map((model) => (
            <ItemRow key={model.id} data-panel-row={model.id} title={model.name}
              hint={<span className="flex min-w-0 items-center gap-2"><span className="truncate font-mono text-[11px]">{model.id}</span><ModelBadges model={model} /></span>} />
          ))}
          {hit.total > hit.models.length && (
            <p className="m-0 px-2 pb-1 text-[12px] leading-4 text-ink-tertiary">{t("models.directory.moreMatches", { count: hit.total - hit.models.length })}</p>
          )}
        </div>
      ))}
    </div>
  );
}
