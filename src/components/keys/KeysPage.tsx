import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import { ChevronRight, Search } from "../../icons";
import { useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { scrollParent, scrollWithin } from "@/lib/scroll-within";
import { t } from "@/lib/i18n";
import { Card as RowsCard, FormDialog } from "../ListRows";
import { smallButtonCls } from "../ui/GrokDialog";
import { LiveProviderSettings } from "../LiveProviderSettings";
import { BuiltInReplyWait, LmStudioServer, OtherOpenAiCompatServers } from "../OpenAiCompatServers";
import { liveCallEnabled } from "@/lib/feature-flags";
import { KEY_CATALOG, KEY_SECTIONS, keyMatches, savedState, type KeyEntry, type KeyId, type KeySectionId } from "./key-catalog";
import { finishKeyFocus, useKeyFocus, type KeyFocusRequest } from "./key-focus";
import { AnthropicEveryClaudeBot, OpenAiCompatUrl, OpenCodeProviderKeys, VpsRow } from "./KeyPanels";
import { KeyMarkIcon, KeyPlainRow, KeyRow } from "./KeyRow";
import { SIMPLE_CARD } from "../SettingsPrimitives";

const HIGHLIGHT_MS = 1600;
// these rows repeat another row's name, so their purpose line is what tells them apart
const PURPOSE_SHOWN: ReadonlySet<KeyId> = new Set<KeyId>(["liveCalls", "liveKey"]);
const quiet = (entry: KeyEntry) => !PURPOSE_SHOWN.has(entry.id);

const PANELS: Partial<Record<KeyId, () => ReactNode>> = {
  opencodeProviders: () => <OpenCodeProviderKeys />,
  lmStudio: () => <LmStudioServer heading={false} />,
};

const EXTRAS: Partial<Record<KeyId, () => ReactNode>> = {
  anthropic: () => <AnthropicEveryClaudeBot />,
  openaiCompat: () => <><OpenAiCompatUrl /><BuiltInReplyWait /><OtherOpenAiCompatServers /></>,
  liveKey: () => <LiveProviderSettings />,
};
// rows whose dialog holds settings of their own besides the key
const SET_UP: ReadonlySet<KeyId> = new Set<KeyId>(["openaiCompat", "liveKey"]);

function connected(entry: KeyEntry, config: ConfigStatus | null | undefined): boolean {
  if (entry.kind === "uses") return false;
  const saved = savedState(entry, config);
  return saved.configured || saved.included === true;
}

/** A row of settings that aren't one key: its state on the quiet line, Set up opens them in a dialog. */
function PanelRow({ entry }: { entry: KeyEntry }) {
  const { state } = useStore();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const saved = savedState(entry, state.config);
  const name = t(entry.labelKey);
  const hint = entry.status ? (saved.configured ? t("keys.connected") : t("keys.row.notConnected")) : t(entry.purposeKey);
  const action = saved.configured ? t("keys.row.change") : t("keys.row.setUp");
  return (
    <KeyPlainRow data-key-row={entry.id} titleId={titleId} mark={<KeyMarkIcon entry={entry} />} title={name} hint={hint}
      actions={<button type="button" data-key-open="" className={smallButtonCls} aria-label={`${action}: ${name}`} onClick={() => setOpen(true)}>{action}</button>}>
      <AnimatePresence>{open && (
        <FormDialog key="key-panel" data-panel-modal="key-panel" title={name} description={t(entry.purposeKey)} onClose={() => setOpen(false)}>
          <div data-key-dialog={entry.id} className="flex flex-col gap-2">{PANELS[entry.id]?.()}</div>
        </FormDialog>
      )}</AnimatePresence>
    </KeyPlainRow>
  );
}

function ElsewhereRow({ entry }: { entry: KeyEntry }) {
  const { state, dispatch } = useStore();
  const titleId = useId();
  const opens = entry.opens;
  const saved = savedState(entry, state.config);
  const name = t(entry.labelKey);
  return (
    <KeyPlainRow data-key-row={entry.id} titleId={titleId} mark={<KeyMarkIcon entry={entry} />} title={name}
      hint={saved.configured ? t("keys.connected") : entry.whereKey ? t(entry.whereKey) : undefined}
      actions={opens && (
        <button type="button" data-key-open className={smallButtonCls} aria-label={`${t("keys.row.open")}: ${name}`}
          onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: opens })}>
          {t("keys.row.open")}
        </button>
      )} />
  );
}

export function KeyCatalogRow({ entry }: { entry: KeyEntry }) {
  if (entry.kind === "uses" && entry.uses) return <KeyRow id={entry.uses} row={entry.id} quiet={quiet(entry)} compact />;
  if (entry.id === "vps") return <VpsRow entry={entry} />;
  if (entry.kind === "panel") return <PanelRow entry={entry} />;
  if (entry.kind === "elsewhere") return <ElsewhereRow entry={entry} />;
  return (
    <>
      <KeyRow id={entry.id} quiet={quiet(entry)} compact setUp={SET_UP.has(entry.id)}>{EXTRAS[entry.id]?.()}</KeyRow>
    </>
  );
}

export function CloudDesktopKeys() {
  const rows = KEY_CATALOG.filter((entry) => entry.id === "vps");
  return (
    <RowsCard data-settings-block="cloud-desktop-keys">
      {rows.map((entry) => <KeyCatalogRow key={entry.id} entry={entry} />)}
    </RowsCard>
  );
}

function KeySection({ id, rows, open, onToggle }: { id: KeySectionId; rows: KeyEntry[]; open: boolean; onToggle: () => void }) {
  const { state } = useStore();
  const section = KEY_SECTIONS.find((candidate) => candidate.id === id)!;
  const headId = useId();
  const bodyId = useId();
  const count = rows.filter((entry) => connected(entry, state.config)).length;
  return (
    <section data-keys-section={id} aria-labelledby={headId}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
        className="flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-ink/[0.035] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus"
      >
        <span id={headId} className="min-w-0 flex-1 truncate text-[13px] leading-[18px] tracking-[-0.08px] text-ink">{t(section.titleKey)}</span>
        {count > 0 && <span className="shrink-0 text-[13px] leading-[18px] text-ink-secondary">{t("keys.section.connected", { count })}</span>}
        <ChevronRight size={14} aria-hidden="true" className={cn("-mr-0.5 shrink-0 text-ink-tertiary", open && "rotate-90")} />
      </button>
      <div id={bodyId} hidden={!open} className="flex flex-col gap-0.5 pb-1">
        {rows.map((entry) => <KeyCatalogRow key={entry.id} entry={entry} />)}
      </div>
    </section>
  );
}

function landOn(page: HTMLElement | null, request: KeyFocusRequest, section: KeySectionId): boolean {
  const row = request.row ? page?.querySelector<HTMLElement>(`[data-key-row="${request.row}"]`) : page?.querySelector<HTMLElement>(`[data-keys-section="${section}"]`);
  if (!row || row.closest("[hidden]")) return false;
  const scroller = scrollParent(row);
  if (scroller) scrollWithin(scroller, row, request.row ? "center" : "start", 16);
  if (!request.row) return true;
  row.querySelector<HTMLElement>("[data-key-add], [data-key-input], [data-key-replace], [data-key-own], [data-key-open], input, button")?.focus({ preventScroll: true });
  row.setAttribute("data-key-highlight", "");
  window.setTimeout(() => row.removeAttribute("data-key-highlight"), HIGHLIGHT_MS);
  return true;
}

export function KeysPage() {
  const { state } = useStore();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<ReadonlySet<KeySectionId>>(() => new Set());
  const pageRef = useRef<HTMLDivElement>(null);
  const focus = useKeyFocus();
  const q = query.trim().toLowerCase();

  useEffect(() => {
    if (!focus) return;
    const section = KEY_CATALOG.find((entry) => entry.id === focus.row)?.section ?? "ai";
    setQuery("");
    setOpen((current) => current.has(section) ? current : new Set([...current, section]));
    let frame = 0;
    let tries = 0;
    const attempt = () => {
      if (landOn(pageRef.current, focus, section) || ++tries > 60) finishKeyFocus(focus);
      else frame = window.requestAnimationFrame(attempt);
    };
    frame = window.requestAnimationFrame(attempt);
    return () => window.cancelAnimationFrame(frame);
  }, [focus]);

  // With Azure chosen, Live calls do not use the OpenAI key that row points at.
  const azureLive = state.config?.live?.provider === "azure";
  const live = liveCallEnabled();
  const rows = KEY_CATALOG.filter((entry) => keyMatches(entry, q) && !(azureLive && entry.id === "liveCalls")
    && (live || (entry.id !== "liveCalls" && entry.id !== "liveKey")));
  const sections = KEY_SECTIONS.flatMap((section) => {
    const own = rows.filter((entry) => entry.section === section.id);
    return own.length > 0 ? [{ id: section.id, rows: own }] : [];
  });

  return (
    <div ref={pageRef} data-keys-page className="flex flex-col gap-2">
      <div className="flex h-8 items-center gap-2 rounded-lg border border-transparent bg-transparent px-[9px]">
        <Search size={14} aria-hidden="true" className="shrink-0 text-ink-secondary" />
        <input
          data-keys-search
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !query) return;
            event.preventDefault();
            event.stopPropagation();
            setQuery("");
          }}
          placeholder={t("keys.search.placeholder")}
          aria-label={t("keys.search.aria")}
          autoComplete="off"
          spellCheck={false}
          className="w-full min-w-0 bg-transparent text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
      </div>
      {sections.length === 0 ? (
        <p data-keys-empty className="px-3.5 text-[13px] leading-[18px] text-ink-secondary">{t("keys.search.none", { query: query.trim() })}</p>
      ) : <div className={SIMPLE_CARD}>{sections.map(({ id, rows: sectionRows }) => (
        <KeySection
          key={id}
          id={id}
          rows={sectionRows}
          open={q !== "" || open.has(id)}
          onToggle={() => setOpen((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })}
        />
      ))}</div>}
    </div>
  );
}
