import { feature } from "@/lib/product-analytics";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { Search, X } from "../../icons";
import { BotAvatar, MausAvatar } from "@/components/Avatar";
import { GroupAvatar, useGroupYou } from "@/components/GroupAvatar";
import { botPreview, lastPreviewable, sidebarPreviewMessages } from "@/components/sidebar-preview";
import { plainPreviewText } from "@/lib/plain-preview";
import { landOnSearchHit } from "@/lib/focus-message";
import { t } from "@/lib/i18n";
import type { SearchHit } from "@/lib/search-hit";
import { api, useStore, type Bot } from "@/state/store";
import { haptic } from "../haptics";
import { useChrome } from "../chrome";
import { Sheet } from "../Sheet";
import { listTime } from "../time";
import { SettingsSection } from "./SettingsRow";
import { EmptyState } from "../Illustration";
import type { SheetPageProps } from "./registry";

export function normalizeSearch(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function searchSnippetParts(text: string, query: string): Array<{ text: string; matched: boolean }> {
  const words = normalizeSearch(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [{ text, matched: false }];
  let normalized = "";
  const offsets: number[] = [];
  let offset = 0;
  for (const character of text) {
    const part = normalizeSearch(character);
    for (let i = 0; i < part.length; i++) offsets.push(offset);
    normalized += part;
    offset += character.length;
  }
  offsets.push(text.length);
  const marked = Array<boolean>(text.length).fill(false);
  for (const word of words) {
    let start = normalized.indexOf(word);
    while (start !== -1) {
      marked.fill(true, offsets[start], offsets[start + word.length]);
      start = normalized.indexOf(word, start + word.length);
    }
  }
  const parts: Array<{ text: string; matched: boolean }> = [];
  for (let i = 0; i < text.length; i++) {
    const last = parts.at(-1);
    if (last?.matched === marked[i]) last.text += text[i];
    else parts.push({ text: text[i], matched: marked[i] });
  }
  return parts;
}

/** A message as a search result shows it: one plain line, the markdown marks gone. */
export function searchSnippetText(snippet: string): string {
  return plainPreviewText(snippet).replace(/\s+/g, " ").trim();
}

function activity(bot: Bot): number {
  return Math.max(lastPreviewable(sidebarPreviewMessages(bot))?.at ?? 0, ...(bot.tasks ?? []).map((task) => task.updatedAt ?? task.createdAt ?? 0));
}

type Results = { query: string; status: "loading" | "ready" | "error"; hits: SearchHit[] };

export const SearchSheet: ComponentType<SheetPageProps<"search">> = ({ open, onClose, onOpenChat }) => {
  const { state, dispatch } = useStore();
  const chrome = useChrome();
  const nativeSearch = Boolean(chrome?.onSearchChange && chrome.onSearchCancel);
  const you = useGroupYou();
  const [query, setQuery] = useState("");
  const [searchSession, setSearchSession] = useState(0);
  const [retry, setRetry] = useState(0);
  const [results, setResults] = useState<Results>({ query: "", status: "ready", hits: [] });
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const q = query.trim();
  const normalized = normalizeSearch(q);
  const bots = state.bots.filter((bot) => !bot.hidden && normalizeSearch(bot.name).includes(normalized));
  const groups = state.groups.filter((group) => normalizeSearch(group.name).includes(normalized));
  const recent = [...state.bots].filter((bot) => !bot.hidden).sort((a, b) => activity(b) - activity(a)).slice(0, 4);
  const current = results.query === q;
  const loading = Boolean(q) && (!current || results.status === "loading");
  const hits = current ? results.hits : [];

  useEffect(() => {
    if (!open) return;
    if (nativeSearch) {
      setQuery("");
      setSearchSession((value) => value + 1);
      return;
    }
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, nativeSearch]);

  useEffect(() => {
    if (!open || !nativeSearch || !chrome?.onSearchChange || !chrome.onSearchCancel) return;
    const stopChange = chrome.onSearchChange((text) => setQuery(text));
    const stopCancel = chrome.onSearchCancel(() => closeRef.current());
    return () => { stopChange(); stopCancel(); };
  }, [open, nativeSearch, chrome]);

  useEffect(() => {
    setOpenError(false);
    if (!open || !q) return;
    const controller = new AbortController();
    setResults({ query: q, status: "loading", hits: [] });
    const timer = setTimeout(() => {
      void api<{ hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}&limit=40`, { signal: controller.signal }).then(({ hits: found }) => {
        if (!controller.signal.aborted) { feature("search_used"); setResults({ query: q, status: "ready", hits: found }); }
      }).catch(() => {
        if (!controller.signal.aborted) { setResults({ query: q, status: "error", hits: [] }); haptic("error"); }
      });
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, q, retry]);

  const openHit = async (hit: SearchHit) => {
    if (opening) return;
    setOpening(true);
    setOpenError(false);
    try {
      await landOnSearchHit(hit, state, dispatch, true);
      const id = hit.groupId ?? hit.botId;
      if (!id) throw new Error("missing search owner");
      onOpenChat(id);
      if (hit.botId) dispatch({ type: "switchTask", botId: hit.botId, threadId: hit.threadId, whole: true });
      dispatch({ type: "focusMessage", threadId: hit.threadId, messageId: hit.messageId, matchText: q });
    } catch {
      setOpenError(true);
      haptic("error");
    } finally {
      setOpening(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t("mobile.search.title")}
      full
      flush={!nativeSearch}
      search={nativeSearch ? { key: `search:${searchSession}`, placeholder: t("mobile.search.placeholder"), autoFocus: true } : undefined}
    >
      {!nativeSearch && (
        <div className="sticky top-0 z-10 flex items-center gap-1 bg-(--m-sheet-page) px-4 pb-3 pt-6">
          <div className="flex h-11 min-w-0 flex-1 items-center rounded-full bg-menu pl-3">
            <Search aria-hidden size={19} className="shrink-0 text-ink-secondary" />
            <label className="sr-only" htmlFor="mobile-search-input">{t("mobile.search.title")}</label>
            <input ref={input} id="mobile-search-input" autoFocus type="search" enterKeyHint="search" autoComplete="off" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("mobile.search.placeholder")} className="h-11 min-w-0 flex-1 appearance-none rounded-full bg-transparent px-2 text-[16px] text-ink placeholder:text-ink-tertiary [&::-webkit-search-cancel-button]:appearance-none" />
            {query && <button type="button" onClick={() => { setQuery(""); input.current?.focus(); }} aria-label={t("mobile.search.clear")} className="mobile-press flex size-11 shrink-0 items-center justify-center rounded-full text-ink-secondary"><X aria-hidden size={18} /></button>}
          </div>
          <button type="button" onClick={onClose} className="mobile-press min-h-11 rounded-full px-2 text-[15px] font-semibold text-ink">{t("mobile.search.cancel")}</button>
        </div>
      )}
      {openError && <p role="alert" className="px-6 py-3 text-[14px] text-danger">{t("mobile.search.openError")}</p>}
      {!q ? (
        <div className="px-2">
          <SettingsSection title={t("mobile.search.recent")}>
            <ul>
              {recent.map((bot) => {
                const at = activity(bot);
                return <li key={bot.id}><button type="button" onClick={() => onOpenChat(bot.id)} className="mobile-row flex min-h-[64px] w-full items-center gap-3 rounded-2xl px-3 py-2 text-left">
                  <BotAvatar bot={bot} size={40} animated={false} label="" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2"><span className="min-w-0 flex-1 truncate text-[16px] font-semibold text-ink">{bot.name}</span>{at > 0 && <time dateTime={new Date(at).toISOString()} className="shrink-0 text-[14px] font-medium tabular-nums text-ink-secondary">{listTime(at)}</time>}</span>
                    <span className="mt-0.5 block truncate text-[14px] text-ink-secondary">{botPreview(bot, sidebarPreviewMessages(bot), state.instances) || " "}</span>
                  </span>
                </button></li>;
              })}
            </ul>
          </SettingsSection>
        </div>
      ) : <div className="px-2">
        {(bots.length > 0 || groups.length > 0) && <SettingsSection title={t("mobile.search.owners")}>
          <ul>
            {bots.map((bot) => <li key={bot.id}><button type="button" onClick={() => onOpenChat(bot.id)} className="mobile-row flex min-h-[64px] w-full items-center gap-3 rounded-2xl px-3 py-2 text-left text-ink"><BotAvatar bot={bot} size={40} animated={false} label="" /><span className="min-w-0 truncate text-[16px] font-semibold">{bot.name}</span></button></li>)}
            {groups.map((group) => <li key={group.id}><button type="button" onClick={() => onOpenChat(group.id)} className="mobile-row flex min-h-[64px] w-full items-center gap-3 rounded-2xl px-3 py-2 text-left text-ink"><GroupAvatar members={state.bots.filter((bot) => group.memberIds.includes(bot.id))} size={40} you={you} /><span className="min-w-0 truncate text-[16px] font-semibold">{group.name}</span></button></li>)}
          </ul>
        </SettingsSection>}
        {loading ? <div role="status" aria-label={t("mobile.search.loading")} className="px-3 py-2">
          {[0, 1, 2].map((i) => <div key={i} aria-hidden className="flex min-h-[64px] items-center gap-3"><span className="size-10 shrink-0 rounded-full bg-ink/[0.05]" /><span className="flex-1 space-y-2"><span className="block h-3 w-1/3 rounded-full bg-ink/[0.05]" /><span className="block h-3 w-4/5 rounded-full bg-ink/[0.05]" /><span className="block h-3 w-2/3 rounded-full bg-ink/[0.05]" /></span></div>)}
        </div> : current && results.status === "error" ? <div role="alert" className="px-4 py-5">
          <p className="text-[15px] text-danger">{t("mobile.search.error")}</p>
          <button type="button" onClick={() => { setResults({ query: q, status: "loading", hits: [] }); setRetry((value) => value + 1); }} className="mobile-press mt-3 h-12 rounded-full bg-ink px-6 text-[15px] font-semibold text-app">{t("mobile.search.retry")}</button>
        </div> : hits.length > 0 ? <SettingsSection title={t("mobile.search.messages")}>
          <ul aria-busy={opening}>
            {hits.map((hit) => {
              const bot = state.bots.find((candidate) => candidate.id === hit.botId);
              const group = state.groups.find((candidate) => candidate.id === hit.groupId);
              return <li key={`${hit.threadId}:${hit.messageId}`}><button type="button" disabled={opening} onClick={() => { void openHit(hit); }} className="mobile-row flex min-h-[64px] w-full items-start gap-3 rounded-2xl px-3 py-3 text-left disabled:opacity-60">
                <span className="shrink-0">{group ? <GroupAvatar members={state.bots.filter((candidate) => group.memberIds.includes(candidate.id))} size={40} you={you} /> : bot ? <BotAvatar bot={bot} size={40} animated={false} label="" /> : <MausAvatar color="blue" size={40} animated={false} label="" />}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2"><span className="min-w-0 flex-1 truncate text-[16px] font-semibold text-ink">{hit.name}</span><time dateTime={new Date(hit.at).toISOString()} className="shrink-0 text-[14px] font-medium tabular-nums text-ink-secondary">{listTime(hit.at)}</time></span>
                  <span className="mt-1 line-clamp-2 text-[15px] leading-5 text-ink-secondary">{searchSnippetParts(searchSnippetText(hit.snippet), q).map((part, index) => <span key={index} className={part.matched ? "font-semibold text-ink" : undefined}>{part.text}</span>)}</span>
                </span>
              </button></li>;
            })}
          </ul>
        </SettingsSection> : bots.length === 0 && groups.length === 0 && <div role="status"><EmptyState art="map" title={t("mobile.search.noResults", { query: q })} body={t("mobile.search.noResultsHint")} className="pt-12" /></div>}
      </div>}
    </Sheet>
  );
};
