import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import { Check, CircleAlert, ExternalLink, Eye, EyeOff, Loader2, TriangleAlert } from "../../icons";
import { api, useStore } from "@/state/store";
import { installsHere } from "@/state/engine-install";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { KeyResult, KeyVia } from "@/lib/analytics-allowlist";
import { keyRemoved, keySaved, keySaveFailure, savedKeyResult } from "@/lib/product-events";
import { InstanceProviderMark } from "../ProviderIcons";
import { keyEntry, keyForInstance, looksLikeOtherKey, savedState, shownKeyEntry, type KeyEntry, type KeyId, type SavedState } from "./key-catalog";
import { checkKey, cleanKey, looksLikeKey, saveKey } from "./key-save";
import { keyCheckView, keyWorks, type KeyCheckAnswer } from "./key-check-view";
import { KeyCheckNote } from "./KeyCheckNote";
import { FormDialog } from "../ListRows";
import { fieldLabelCls, smallButtonCls } from "../ui/GrokDialog";
import { friendlyError } from "@/lib/plain-error";

/** A key field: the panel's quiet hairline box, no fill, unchanged on hover and focus (the caret marks it). */
export const KEY_FIELD = "h-7 w-full min-w-0 rounded-lg border border-transparent bg-transparent px-2.5 font-mono text-[12px] leading-7 text-ink placeholder:font-sans placeholder:text-ink-tertiary outline-none disabled:opacity-60";
export const KEY_ROW = "group flex scroll-mt-24 flex-col gap-1.5 rounded-lg px-2 py-1.5 transition-[background-color] duration-500 data-[key-highlight]:bg-ink/[0.06] motion-reduce:transition-none";
const MASK = "••••••••";

export function KeyMarkIcon({ entry }: { entry: KeyEntry }) {
  const { mark } = entry;
  if ("icon" in mark) {
    const Icon = mark.icon;
    return <Icon size={16} aria-hidden="true" className="shrink-0 text-ink-tertiary transition-colors group-hover:text-ink-secondary group-focus-within:text-ink-secondary" />;
  }
  return <InstanceProviderMark instance={{ driverKind: mark.driverKind, ...(mark.preset ? { icon: { kind: "preset", preset: mark.preset } } : {}) }} size={16} subtle />;
}

export type KeyStatus = { tone: "busy" | "ok" | "bad"; text: string } | null;

export function KeyStatusChip({ status }: { status: KeyStatus }) {
  return (
    <span aria-live="polite" className="flex min-h-5 shrink-0 items-center gap-1 text-[12px] leading-5 text-ink-secondary">
      {status?.tone === "busy" && <Loader2 size={12} aria-hidden="true" className="animate-spin" />}
      {status?.tone === "ok" && <Check size={13} aria-hidden="true" className="text-success" />}
      {status?.tone === "bad" && <CircleAlert size={13} aria-hidden="true" className="text-danger" />}
      {status && <span className={cn(status.tone === "bad" && "text-danger")}>{status.text}</span>}
    </span>
  );
}

export function MaskedKey({ saved, label }: { saved: SavedState; label: string }) {
  return (
    <span data-key-masked className={cn(KEY_FIELD, "block min-w-[min(100%,12rem)] flex-1 select-none truncate text-ink-secondary")}>
      <span aria-hidden="true">{MASK}{saved.last4 ?? ""}</span>
      <span className="sr-only">{saved.last4 ? t("keys.row.endsIn", { label, last4: saved.last4 }) : t("keys.row.savedKey", { label })}</span>
    </span>
  );
}

export function SavedKeyLine({ id }: { id: KeyId }) {
  const { state } = useStore();
  const entry = keyEntry(id);
  const saved = savedState(entry, state.config);
  if (!saved.configured) return null;
  const label = t(entry.labelKey);
  return (
    <div data-key-summary={id} className="mt-1 flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-ink-secondary">
      <Check size={13} aria-hidden="true" className="shrink-0 text-success" />
      <span className="shrink-0">{entry.target?.test || entry.target?.verifiedOnSave ? t("keys.connected") : t("common.saved")}</span>
      <span aria-hidden="true" className="truncate font-mono">{MASK}{saved.last4 ?? ""}</span>
      <span className="sr-only">{saved.last4 ? t("keys.row.endsIn", { label, last4: saved.last4 }) : t("keys.row.savedKey", { label })}</span>
    </div>
  );
}

export function RowHeading({ entry, status, titleId, purpose = true, hint }: { entry: KeyEntry; status: KeyStatus; titleId?: string; purpose?: boolean; hint?: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex size-5 shrink-0 items-center justify-center"><KeyMarkIcon entry={entry} /></span>
      <div className="min-w-0 flex-1">
        <div id={titleId} data-row-title="" className="text-[13px] leading-[18px] text-ink">{t(entry.labelKey)}</div>
        {purpose && <div data-row-hint="" className="text-[12px] leading-4 text-ink-secondary">{t(entry.purposeKey)}</div>}
        {hint}
      </div>
      <KeyStatusChip status={status} />
    </div>
  );
}

/** Settings' plain key row: a mark, the name over one quiet line, an optional value and small pills; anything more opens a dialog. */
export function KeyPlainRow({ mark, title, hint, value, actions, titleId, className, children, ...rest }: {
  mark: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  value?: ReactNode;
  actions?: ReactNode;
  titleId: string;
  className?: string;
  children?: ReactNode;
  role?: "group";
  "aria-labelledby"?: string;
  [data: `data-${string}`]: string | undefined;
}) {
  return (
    <div role="group" aria-labelledby={titleId} {...rest} className={cn(KEY_ROW, "gap-0", className)}>
      <div className="flex min-h-[36px] items-center gap-2.5">
        <span className="flex size-5 shrink-0 items-center justify-center">{mark}</span>
        <div className="min-w-0 flex-1">
          <div id={titleId} data-row-title="" className="truncate text-[13px] leading-[18px] text-ink">{title}</div>
          {hint && <div data-row-hint="" className="truncate text-[13px] leading-[18px] text-ink-secondary">{hint}</div>}
        </div>
        {value && <span data-panel-value="" className="min-w-0 max-w-[40%] truncate text-[13px] leading-[18px] text-ink-secondary">{value}</span>}
        {actions && <span className="flex shrink-0 items-center gap-1.5">{actions}</span>}
      </div>
      {children}
    </div>
  );
}

/** The built-in OpenAI-compatible server by its host; with no address saved it is OpenRouter. */
function serverName(url: string | undefined): string {
  try {
    return new URL(url || "https://openrouter.ai/api/v1").hostname;
  } catch {
    return "OpenRouter";
  }
}

function errorText(cause: unknown): string {
  return friendlyError(cause);
}

export function KeyRow({
  id,
  row: rowId,
  via = "settings",
  onSaved,
  bare = false,
  quiet = false,
  compact = false,
  setUp = false,
  title,
  rejected: rejectedHere,
  className,
  children,
}: {
  id: KeyId;
  row?: KeyId;
  via?: KeyVia;
  onSaved?: (configured: boolean) => void;
  bare?: boolean;
  quiet?: boolean;
  /** Settings' plain row: the name, whether it's connected and small pills; the field opens in a compact dialog */
  compact?: boolean;
  /** the row also holds settings of its own (shown in its dialog), so it offers Set up rather than Add key */
  setUp?: boolean;
  title?: string;
  rejected?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const { state, dispatch, refreshInstances } = useStore();
  const titleId = useId();
  const [draft, setDraft] = useState("");
  const [shown, setShown] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [ownKey, setOwnKey] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [busy, setBusy] = useState<"saving" | "checking" | "removing" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<string | null>(null);
  const [works, setWorks] = useState(false);
  const [enginesChecking, setEnginesChecking] = useState(false);
  const [engineCheckError, setEngineCheckError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<"input" | "replace" | null>(null);
  const [checkAnswer, setCheck] = useState<KeyCheckAnswer | null>(null);
  const [unsure, setUnsure] = useState<string | null>(null);

  useEffect(() => {
    const goal = focusAfter.current;
    if (!goal) return;
    focusAfter.current = null;
    (goal === "input" ? inputRef.current : replaceRef.current)?.focus();
  });

  const entry = shownKeyEntry(id, state.config);
  const row = rowId ? shownKeyEntry(rowId, state.config) : entry;
  const target = entry.target;
  if (!target) throw new Error(`${id} is not saved by a key row`);
  const pointer = row.id !== entry.id;
  const label = t(entry.labelKey);
  const saved = savedState(entry, state.config);
  const checkName = entry.id === "openaiCompat" && state.config ? serverName(state.config.openaiCompat?.url) : entry.name;
  const check = checkAnswer ? keyCheckView(checkAnswer, checkName) : null;
  const engineRejected = (state.instances ?? []).some((instance) => instance.access === "api" && keyForInstance(instance.instanceId) === entry.id
    && instance.snapshot.state === "available" && instance.snapshot.authenticated === false);
  // A key engine with its own CLI (DeepSeek Harness) can't use a saved key until that CLI runs here.
  // The Grok CLI signs in with a grok.com account and drops XAI_API_KEY, so installing it never puts the xAI key to use.
  const keyEngines = saved.configured
    ? (state.instances ?? []).filter((instance) => instance.driverKind !== "grokAgent" && keyForInstance(instance.instanceId) === entry.id)
    : [];
  const missingEngine = keyEngines.some((instance) => instance.snapshot.state === "available")
    ? undefined
    : keyEngines.find((instance) => instance.snapshot.state === "unavailable" && installsHere(instance.install));
  const installCommand = Boolean(missingEngine);
  const rejected = !works && (rejectedHere ?? (saved.configured && engineRejected));
  const failure = problem ?? (rejected && !busy && !check ? t("keys.testRejected") : null);
  const checkedBad = check?.tone === "bad";
  const editing = !saved.configured || replacing;
  const fieldShown = compact ? dialog : editing && (!saved.included || saved.configured || ownKey);
  const other = fieldShown && draft ? looksLikeOtherKey(row, draft) : null;

  const status: KeyStatus = busy === "saving" ? { tone: "busy", text: t("keys.row.saving") }
    : busy === "removing" ? { tone: "busy", text: t("keys.row.removing") }
      : busy === "checking" ? { tone: "busy", text: t("common.checking") }
        : (failure || checkedBad) && (saved.configured || !fieldShown) ? { tone: "bad", text: t("keys.row.didntWork") }
          : saved.configured ? { tone: "ok", text: target.test || target.verifiedOnSave || works ? t("keys.connected") : t("common.saved") }
            : saved.included ? { tone: "ok", text: t("keys.includedWithCloudPro") }
              : null;

  const providerTest = target.test && target.test !== "treg" ? target.test : undefined;
  const showCheck = (answer: KeyCheckAnswer) => {
    setCheck(answer);
    setWorks(keyWorks(keyCheckView(answer, checkName)));
    setVerdict(null);
    setProblem(null);
  };

  const runCheck = async (): Promise<KeyResult> => {
    if (!target.test) return "unverified";
    const mine = ++generation.current;
    setBusy("checking");
    try {
      const answer = await checkKey(target.test);
      if (mine === generation.current) {
        if (providerTest) showCheck(answer.answer);
        else {
          setWorks(answer.ok);
          setVerdict(answer.ok ? answer.text : null);
          setProblem(answer.ok ? null : answer.text);
        }
      }
      return answer.result;
    } catch (cause) {
      if (mine === generation.current) setProblem(errorText(cause));
      return "unverified";
    }
  };

  const save = async (raw: string, anyway = false) => {
    const value = cleanKey(raw);
    if (busyRef.current || !value) return;
    if (!looksLikeKey(value)) {
      setNotice(t("keys.notAKey"));
      return;
    }
    busyRef.current = true;
    const mine = ++generation.current;
    const hadFocus = document.activeElement === inputRef.current;
    setProblem(null);
    setNotice(null);
    setVerdict(null);
    setWorks(false);
    setUnsure(null);
    const confirmed = anyway && check?.confirm ? checkAnswer : null;
    setCheck(confirmed);
    let checked: { result: KeyResult; answer: KeyCheckAnswer } | null = null;
    try {
      if (providerTest && !confirmed) {
        setBusy("checking");
        const answer = await checkKey(providerTest, { key: value });
        if (mine !== generation.current) return;
        checked = { result: answer.result, answer: answer.answer };
        const view = keyCheckView(answer.answer, checkName);
        if (view.blocks || view.confirm) {
          setCheck(answer.answer);
          if (view.confirm) setUnsure(value);
          if (view.blocks) keySaved(target.analytics, via, answer.result);
          return;
        }
      }
      setBusy("saving");
      const status = await saveKey(target, value, !saved.configured);
      dispatch({ type: "configStatus", config: status });
      const now = target.saved(status);
      setDraft("");
      setShown(false);
      setReplacing(false);
      setOwnKey(false);
      if (compact && now.configured) setDialog(false);
      if (hadFocus) focusAfter.current = now.configured ? "replace" : "input";
      if (!now.configured) setProblem(t("keys.row.notKept"));
      onSaved?.(now.configured);
      if (checked && now.configured) showCheck(checked.answer);
      const result = checked ? checked.result : confirmed ? "unverified" : now.configured && target.test ? await runCheck() : savedKeyResult(target.analytics);
      keySaved(target.analytics, via, result);
    } catch (cause) {
      setProblem(errorText(cause));
      keySaved(target.analytics, via, keySaveFailure(cause));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const installEngine = async () => {
    if (!missingEngine) return;
    setEnginesChecking(true);
    setEngineCheckError(null);
    try {
      await api(`/api/instances/${encodeURIComponent(missingEngine.instanceId)}/install`, { method: "POST" });
      await refreshInstances({ reportErrors: true });
    } catch {
      setEngineCheckError(t("engineSetup.installFailed", { name: missingEngine.displayName }));
    } finally {
      setEnginesChecking(false);
    }
  };

  const recheck = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setVerdict(null);
    setProblem(null);
    try {
      await runCheck();
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const remove = async () => {
    if (busyRef.current) return;
    if (!window.confirm(t("keys.row.removeConfirm", { label }))) return;
    busyRef.current = true;
    generation.current += 1;
    setBusy("removing");
    setProblem(null);
    setVerdict(null);
    setCheck(null);
    setUnsure(null);
    setWorks(false);
    try {
      const status = await saveKey(target, "", false);
      dispatch({ type: "configStatus", config: status });
      setReplacing(false);
      setDraft("");
      onSaved?.(target.saved(status).configured);
      keyRemoved(target.analytics, via);
    } catch (cause) {
      setProblem(errorText(cause));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const startReplace = () => {
    setReplacing(true);
    setProblem(null);
    setVerdict(null);
    setCheck(null);
    focusAfter.current = "input";
  };

  const cancelReplace = () => {
    setReplacing(false);
    setDraft("");
    setNotice(null);
    focusAfter.current = "replace";
  };

  const field = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[min(100%,12rem)] flex-1">
        <input
          ref={inputRef}
          data-key-input
          type={shown ? "text" : "password"}
          value={draft}
          onChange={(event) => { setDraft(event.target.value); setNotice(null); setProblem(null); setCheck(null); setUnsure(null); }}
          onPaste={(event) => {
            const pasted = cleanKey(event.clipboardData.getData("text"));
            if (!pasted) return;
            event.preventDefault();
            setDraft(pasted);
            setNotice(null);
            setProblem(null);
            setCheck(null);
            setUnsure(null);
            if (looksLikeKey(pasted) && !looksLikeOtherKey(row, pasted)) void save(pasted);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void save(draft);
            } else if (event.key === "Escape" && replacing && !compact) {
              event.preventDefault();
              event.stopPropagation();
              cancelReplace();
            }
          }}
          disabled={busy === "saving"}
          placeholder={replacing ? t("keys.row.newKey") : target.placeholderKey ? t(target.placeholderKey) : target.placeholder}
          aria-label={label}
          data-autofocus={compact ? "" : undefined}
          id={compact ? `${titleId}-field` : undefined}
          autoComplete="off"
          spellCheck={false}
          className={cn(KEY_FIELD, "pr-9", compact && "h-8 rounded-[10px] text-[13px] leading-8")}
        />
        <button
          type="button"
          onClick={() => setShown((current) => !current)}
          aria-label={shown ? t("keys.row.hide") : t("keys.row.show")}
          aria-pressed={shown}
          className="absolute right-0.5 top-1/2 flex size-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-ink-tertiary transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60"
        >
          {shown ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
        </button>
      </div>
      {!compact && <span className="flex shrink-0 items-center gap-2">
        <button type="button" data-key-save className="ui-button ui-button-primary" disabled={!draft.trim() || busy !== null} onClick={() => void save(draft)}>
          {t("common.save")}
        </button>
        {replacing && <button type="button" className="ui-button" onClick={cancelReplace}>{t("common.cancel")}</button>}
      </span>}
    </div>
  );

  const masked = (
    <div className="flex flex-wrap items-center gap-2">
      <MaskedKey saved={saved} label={label} />
      <span className="flex shrink-0 items-center gap-2">
        <button ref={replaceRef} type="button" data-key-replace className="ui-button" disabled={busy !== null} onClick={startReplace}>{t("keys.row.replace")}</button>
        {!pointer && <button type="button" data-key-remove className="ui-button" disabled={busy !== null} onClick={() => void remove()}>{t("keys.row.remove")}</button>}
      </span>
    </div>
  );

  const warning = target.warningKey && fieldShown ? t(target.warningKey) : null;
  const note = target.noteKey && fieldShown && !pointer && !quiet ? t(target.noteKey) : null;

  const linkInHeading = quiet && !bare && fieldShown && Boolean(target.href);
  const getKey = target.href && (
    <a href={target.href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[12px] leading-4 font-medium text-accent-text hover:underline">
      {t("keys.row.getKey")}
      <ExternalLink size={11} aria-hidden="true" />
    </a>
  );
  const checkNote = check && (
    <KeyCheckNote view={check} creditHref={target.creditHref} busy={busy !== null}
      onSaveAnyway={unsure && check.confirm ? () => void save(unsure, true) : undefined} />
  );
  const messages = (
    <>
        {(notice || failure || checkNote || other || warning || installCommand || note || verdict || (fieldShown && target.href && !linkInHeading) || (!fieldShown && saved.configured && target.test)) && (
        <div className="flex flex-col gap-1.5 text-[12px] leading-4">
          {notice && <p role="alert" className="text-danger">{notice}</p>}
          {failure && (
            <p role="alert" className="flex gap-1.5 text-danger">
              <CircleAlert size={13} aria-hidden="true" className="mt-px shrink-0" />
              <span>{t("keys.row.failed", { reason: failure })}</span>
            </p>
          )}
          {checkNote}
          {other && (
            <p className="flex gap-1.5 text-warning">
              <TriangleAlert size={13} aria-hidden="true" className="mt-px shrink-0" />
              <span>{t("keys.row.looksLike", { label: t(other.labelKey) })}</span>
            </p>
          )}
          {warning && (
            <p className="flex gap-1.5 text-warning">
              <TriangleAlert size={13} aria-hidden="true" className="mt-px shrink-0" />
              <span>{warning}</span>
            </p>
          )}
          {installCommand && missingEngine && (
            <div data-key-engine-missing className="flex flex-col gap-1">
              <p className="flex gap-1.5 text-warning">
                <TriangleAlert size={13} aria-hidden="true" className="mt-px shrink-0" />
                <span>{t("keys.row.engineMissing", { engine: missingEngine.displayName })}</span>
              </p>
              <button type="button" data-key-engine-check className="cursor-pointer self-start text-ink-secondary hover:text-ink hover:underline disabled:opacity-50" disabled={enginesChecking}
                onClick={() => void installEngine()}>
                {enginesChecking ? t("engineSetup.serverInstalling") : engineCheckError ? t("common.tryAgain") : t("engineSetup.serverInstall", { name: missingEngine.displayName })}
              </button>
              {engineCheckError && <p role="alert" className="text-danger">{engineCheckError}</p>}
            </div>
          )}
          {note && <p className="text-ink-secondary">{note}</p>}
          {verdict && <p role="status" className="whitespace-pre-line text-ink-secondary">{verdict}</p>}
          {(fieldShown && target.href && !linkInHeading) || (!fieldShown && saved.configured && target.test) ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              {fieldShown && !linkInHeading && getKey}
              {!fieldShown && saved.configured && target.test && (
                <button type="button" data-key-check className="cursor-pointer text-ink-secondary hover:text-ink hover:underline disabled:opacity-50" disabled={busy !== null} onClick={() => void recheck()}>
                  {t("common.checkAgain")}
                </button>
              )}
            </div>
          ) : null}
        </div>
      )}
    </>
  );
  const fieldOrSaved = fieldShown ? field : saved.configured ? masked : (
    <div>
      <button type="button" data-key-own className="ui-button" onClick={() => { setOwnKey(true); focusAfter.current = "input"; }}>{t("keys.row.useOwn")}</button>
    </div>
  );
  const attributes = {
    "data-key-row": row.id,
    "data-api-key-row": pointer ? undefined : entry.id,
    "data-key-state": saved.configured ? "saved" : saved.included ? "included" : "empty",
    "aria-labelledby": bare ? undefined : titleId,
    role: "group",
  } as const;

  if (compact) {
    const openDialog = () => {
      setDialog(true);
      setReplacing(saved.configured);
      setOwnKey(!saved.configured && saved.included === true);
      setDraft("");
      setNotice(null);
      setProblem(null);
      setVerdict(null);
      setCheck(null);
      setUnsure(null);
    };
    const closeDialog = () => {
      if (busy === "saving") return;
      setDialog(false);
      setReplacing(false);
      setOwnKey(false);
      setDraft("");
      setShown(false);
      setNotice(null);
      setProblem(null);
    };
    const name = title ?? t(row.labelKey);
    const purposeLine = !quiet ? t(row.purposeKey) : null;
    const bad = (failure || checkedBad) && saved.configured && !dialog;
    const masked = saved.configured && <><span aria-hidden="true"> · </span><span data-key-masked className="font-mono text-[12px]">
      <span aria-hidden="true">{MASK}{saved.last4 ?? ""}</span>
      <span className="sr-only">{saved.last4 ? t("keys.row.endsIn", { label, last4: saved.last4 }) : t("keys.row.savedKey", { label })}</span>
    </span></>;
    const stateLine = busy && !dialog ? <span className="inline-flex items-center gap-1"><Loader2 size={11} aria-hidden="true" className="animate-spin" />{status?.text}</span>
      : bad ? <><span className="inline-flex items-center gap-1 align-[-2px] text-danger"><CircleAlert size={12} aria-hidden="true" />{t("keys.row.didntWork")}</span>{masked}</>
        : saved.configured ? <>{status?.text ?? t("keys.connected")}{masked}</>
          : saved.included ? t("keys.includedWithCloudPro") : t("keys.row.notConnected");
    const action = saved.configured ? t("keys.row.change") : saved.included ? t("keys.row.useOwn") : setUp ? t("keys.row.setUp") : t("keys.row.add");
    const rowMessages = !dialog && (failure && saved.configured || verdict || (check && saved.configured) || (installCommand && missingEngine)) ? messages : null;
    return (
      <KeyPlainRow {...attributes} titleId={titleId} className={className} mark={<KeyMarkIcon entry={row} />} title={name}
        hint={<span aria-live="polite">{purposeLine ?? stateLine}</span>} value={purposeLine ? stateLine : undefined}
        actions={<>
          <button ref={replaceRef} type="button" {...(saved.configured ? { "data-key-replace": "" } : { "data-key-add": "" })} className={smallButtonCls}
            disabled={busy !== null && !dialog} onClick={openDialog} aria-label={`${action}: ${name}`}>{action}</button>
          {saved.configured && !pointer && (
            <button type="button" data-key-remove className={smallButtonCls} disabled={busy !== null} onClick={() => void remove()} aria-label={`${t("keys.row.remove")}: ${name}`}>{t("keys.row.remove")}</button>
          )}
        </>}
      >
        {rowMessages && <div className="flex flex-col gap-1.5 ps-[30px] pt-1">{rowMessages}</div>}
        <AnimatePresence>{dialog && (
          <FormDialog key="key"
            data-panel-modal="key"
            title={label}
            description={t(row.purposeKey)}
            canSave={Boolean(draft.trim())}
            busy={busy !== null}
            onSave={() => save(draft)}
            onClose={closeDialog}
            cancelLabel={children ? t("common.done") : undefined}
          >
            <div data-key-dialog={row.id} className="flex flex-col gap-3">
              {saved.configured && (
                <div className="flex min-w-0 items-center gap-2 text-[13px] leading-[18px] text-ink-secondary">
                  <span className="shrink-0">{t("keys.row.current")}</span>
                  <span className="min-w-0 truncate font-mono text-[12px]" aria-hidden="true">{MASK}{saved.last4 ?? ""}</span>
                  {target.test && (
                    <button type="button" data-key-check className="ms-auto shrink-0 cursor-pointer text-ink-secondary transition-colors hover:text-ink disabled:opacity-50" disabled={busy !== null} onClick={() => void recheck()}>
                      {busy === "checking" ? t("common.checking") : t("common.checkAgain")}
                    </button>
                  )}
                </div>
              )}
              <div className="flex flex-col gap-1">
                <label htmlFor={`${titleId}-field`} className={fieldLabelCls}>{replacing ? t("keys.row.newKey") : label}</label>
                {field}
              </div>
              {(notice || failure || checkNote || other || note || verdict || target.href) && (
                <div className="flex flex-col gap-1.5 text-[12px] leading-4">
                  {notice && <p role="alert" className="m-0 text-danger">{notice}</p>}
                  {failure && (
                    <p role="alert" className="m-0 flex gap-1.5 text-danger">
                      <CircleAlert size={13} aria-hidden="true" className="mt-px shrink-0" />
                      <span>{t("keys.row.failed", { reason: failure })}</span>
                    </p>
                  )}
                  {checkNote}
                  {other && <p className="m-0 text-ink-secondary">{t("keys.row.looksLike", { label: t(other.labelKey) })}</p>}
                  {note && <p className="m-0 text-ink-secondary">{note}</p>}
                  {verdict && <p role="status" className="m-0 whitespace-pre-line text-ink-secondary">{verdict}</p>}
                  {target.href && (
                    <a href={target.href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 self-start rounded-sm text-ink-secondary transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus">
                      {t("keys.row.getKey")}<ExternalLink size={11} aria-hidden="true" />
                    </a>
                  )}
                </div>
              )}
              {children}
            </div>
          </FormDialog>
        )}</AnimatePresence>
      </KeyPlainRow>
    );
  }

  if (quiet && !bare) {
    return (
      <div {...attributes} className={cn(KEY_ROW, "flex-row flex-wrap items-center gap-x-5", className)}>
        <div className="min-w-0 flex-1 basis-48"><RowHeading entry={row} status={status} titleId={titleId} purpose={false} hint={linkInHeading ? <div>{getKey}</div> : undefined} /></div>
        <div className="ms-auto w-[min(100%,20rem)]">{fieldOrSaved}</div>
        <div className="flex w-full flex-col gap-2 empty:hidden">{messages}{children}</div>
      </div>
    );
  }

  return (
    <div {...attributes} className={cn(KEY_ROW, className)}>
      {bare ? status && <KeyStatusChip status={status} /> : <RowHeading entry={row} status={status} titleId={titleId} purpose={!quiet} />}
      <div className={cn("flex flex-col gap-1.5", !bare && "ps-[30px]")}>
        {fieldOrSaved}
        {messages}
        {children}
      </div>
    </div>
  );
}
