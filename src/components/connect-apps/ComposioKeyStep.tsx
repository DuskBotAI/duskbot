import { useState, type FormEvent } from "react";

import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { reserveConnectionPage } from "@/lib/connector-oauth";
import { Icon } from "../Icon";
import { cleanKey, looksLikeKey, saveCredential } from "../keys/key-save";
import type { Connectors } from "./use-connectors";
import type { ViaFailure, ViaFlow } from "./via-flow";
import { KitButton } from "./detail-kit";
import { StepGuide, type GuideStep } from "./StepGuide";
import { PrimaryButton, type Primary } from "./PrimaryButton";
import { CancelLink } from "./AppRow";
import { ConnectStatus } from "./ConnectBlock";

/** Composio's own sign-up / log-in, then the project page that lists its API keys
 * (https://docs.composio.dev/reference/authenticating-to-composio). */
export const COMPOSIO_SIGN_UP_URL = "https://dashboard.composio.dev";
export const COMPOSIO_API_KEYS_URL = "https://dashboard.composio.dev/~/project/settings/api-keys";

/** What went wrong saving a key, in one short line: Composio said no, or it could not be reached. */
export function keyProblem(cause: unknown): LocaleKey {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /rejected|project API keys start with|\b40[13]\b|unauthori[sz]ed|invalid/i.test(message) ? "connectApps.key.rejected" : "connectApps.key.offline";
}

/** The sentence for where an app's Composio Connect sign-in stands, when there is one to say. */
export function viaLine(flow: ViaFlow | undefined, name: string): { text: string; tone: "status" | "alert" | "done" } | null {
  if (!flow) return null;
  if (flow.step === "done") return { text: t("connectApps.via.connected", { name }), tone: "done" };
  if (flow.step === "waiting") {
    const key: LocaleKey = flow.note === "trouble" ? "connectApps.via.trouble" : flow.note === "notYet" ? "connectApps.via.notYet" : "connectApps.via.waiting";
    return { text: t(key, { name }), tone: "status" };
  }
  if (flow.step !== "failed") return null;
  const key: Record<ViaFailure, LocaleKey> = {
    authorize: "connectApps.via.authorizeFailed", cancelled: "connectApps.via.cancelled", timeout: "connectApps.via.timeout",
    signedOut: "connectApps.via.signedOut", offline: "connectApps.via.offline", refused: "connectApps.via.refused",
  };
  return { text: t(key[flow.why], { name, message: flow.message ?? "" }), tone: "alert" };
}

/** The one-time Composio link, as one compact block: a line on why, the one button that signs in to Composio, and a quiet
 * way to paste your own project key instead. Connecting the app itself is the page's next screen, not a second step here.
 * The key path is a short numbered guide: the server verifies the key on save, it is kept the way Settings keeps it, and
 * the app's connect goes on the same way. */
export function ComposioKeyStep({ slug, name, connectors, primary }: { slug: string; name: string; connectors: Connectors; primary: Primary | null }) {
  const { dispatch } = useStore();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<LocaleKey | null>(null);
  const [ownKey, setOwnKey] = useState(false);
  const flow = connectors.viaFlow[slug];
  const connected = flow?.step === "done";
  const line = viaLine(flow, name);

  const submit = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const key = cleanKey(draft);
    if (busy || !key) return;
    if (!looksLikeKey(key)) { setProblem("keys.notAKey"); return; }
    // the sign-in tab is reserved on this click, before saving uses up the browser's user activation
    const launch = reserveConnectionPage();
    setBusy(true);
    setProblem(null);
    try {
      dispatch({ type: "configStatus", config: await saveCredential("composio", key, true) });
    } catch (cause) {
      launch.cancel();
      setBusy(false);
      setProblem(keyProblem(cause));
      return;
    }
    setDraft("");
    setSaved(true);
    await connectors.continueAfterKey(slug, launch);
    setBusy(false);
  };

  const [openedComposio, setOpenedComposio] = useState(false);
  const [openedKeys, setOpenedKeys] = useState(false);
  const [saved, setSaved] = useState(false);

  const keySteps: GuideStep[] = [
    { key: "open", done: openedComposio || openedKeys || Boolean(draft), text: t("connectApps.guide.openComposio"),
      action: <a className="ca-kit-button" data-variant="primary" href={COMPOSIO_SIGN_UP_URL} target="_blank" rel="noopener noreferrer" onClick={() => setOpenedComposio(true)}>{t("connectApps.key.signUp")}</a> },
    { key: "copy", done: Boolean(draft), text: t("connectApps.guide.copyKey"),
      action: <a className="ca-kit-button" data-variant="secondary" href={COMPOSIO_API_KEYS_URL} target="_blank" rel="noopener noreferrer" onClick={() => setOpenedKeys(true)}>{t("connectApps.key.openKeys")}</a> },
    { key: "paste", done: saved, text: t("connectApps.guide.paste"),
      action: (
        <form className="ca-guide-action" onSubmit={(event) => void submit(event)}>
          <input type="password" value={draft} autoFocus autoComplete="off" spellCheck={false} placeholder={t("keys.composio.label")}
            aria-label={t("connectApps.key.label")} aria-invalid={problem ? true : undefined} aria-describedby={problem ? "ca-key-problem" : undefined}
            onChange={(event) => { setDraft(event.target.value); setProblem(null); }} />
          <KitButton type="submit" disabled={busy || !draft.trim()} aria-busy={busy || undefined}>{busy ? t("tokenApps.checking") : t("connectApps.connectApp", { name })}</KitButton>
        </form>
      ) },
  ];

  return (
    <section className="ca-connect" data-connect="" data-composio-key="" data-mode={ownKey ? "key" : "sign-in"} aria-labelledby="ca-key-title">
      <h3 id="ca-key-title" className="ca-connect-title">{t("connectApps.via.title", { name })}</h3>
      {ownKey
        ? <StepGuide label={t("tokenApps.guide", { name })} steps={keySteps} finished={null} />
        : <p className="ca-connect-note">{t("connectApps.via.why", { name })}</p>}
      {((!ownKey && primary) || line) && (
        <div className="ca-connect-row">
          {!ownKey && primary && <PrimaryButton primary={primary} />}
          {!ownKey && primary?.onCancel && (primary.busy || primary.waiting) && <CancelLink onCancel={primary.onCancel} />}
          {line && <ConnectStatus line={line} marker="data-via-line" />}
        </div>
      )}
      {problem && (
        <p id="ca-key-problem" role="alert" className="ca-connect-status" data-tone="alert">
          <Icon name="exclamation-circle" size={13} />
          <span>{t(problem)}</span>
        </p>
      )}
      {!connected && (
        <button type="button" className="ca-link ca-connect-alt" onClick={() => { setOwnKey(!ownKey); setProblem(null); }}>
          {t(ownKey ? "connectApps.guide.useSignIn" : "connectApps.via.useKey")}
        </button>
      )}
    </section>
  );
}
