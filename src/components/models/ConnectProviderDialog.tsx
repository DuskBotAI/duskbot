import { useState } from "react";
import { Check, Loader2 } from "../../icons";
import { requiredFields, type Place } from "../../../shared/model-providers";
import { useStore, type InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { friendlyError } from "@/lib/plain-error";
import { connectProvider, listModels, placeLine, type ProviderFields, type ProviderInfo } from "@/lib/model-providers";
import { keyCheckView, type KeyCheckView } from "../keys/key-check-view";
import { KeyCheckNote } from "../keys/KeyCheckNote";
import { cleanKey } from "../keys/key-save";
import { FormDialog, FormField } from "../ListRows";
import { DisconnectProvider } from "../EnginesSettings";
import { engineReady } from "../EngineLibrary";
import { connectsInApp, type ConnectInstance } from "../onboarding/connect-flow";
import { aiTiles, type AiTileId } from "../onboarding/funnel";
import { ConnectPanel, useConnectFlow } from "../onboarding/SignInPill";
import { textFieldCls } from "../ui/GrokDialog";

const FIELD = cn(textFieldCls, "bg-ink/[0.04]");

const SIGN_IN_TILE: Partial<Record<string, AiTileId>> = { anthropic: "claude", openai: "chatgpt", google: "antigravity", xai: "grok" };

/** How one of the provider's engines is connected, in the words the sheet shows. */
function connectedVia(instance: InstanceInfo): string {
  const email = instance.snapshot.account?.email;
  if (instance.access === "api" || instance.snapshot.account?.method === "api-key") return t("models.connect.viaKey", { name: instance.displayName });
  return email ? t("models.connect.viaSignInAs", { name: instance.displayName, email }) : t("models.connect.viaSignIn", { name: instance.displayName });
}

/** The short sheet that connects one provider on the server the bots run on: a sign-in where the provider has one, else
 * its details and key, an optional check that lists its models, and Connect. A provider already connected opens on how
 * it is connected, with Disconnect, and the form only on asking to connect it another way. */
export function ConnectProviderDialog({ provider, place, model, onClose, onConnected }: {
  provider: ProviderInfo;
  place: Place;
  /** A model the person picked from the search, kept as the connection's model for a custom endpoint. */
  model?: string;
  onClose: () => void;
  onConnected?: (instanceId: string, instances: InstanceInfo[]) => void;
}) {
  const { state, dispatch, refreshInstances } = useStore();
  const flow = useConnectFlow();
  const signInTile = provider.signIn && SIGN_IN_TILE[provider.id]
    ? aiTiles(state.instances, engineReady, (instance) => connectsInApp(instance as unknown as ConnectInstance)).find((tile) => tile.id === SIGN_IN_TILE[provider.id])
    : undefined;
  const [fields, setFields] = useState<ProviderFields>(model && provider.section === "custom" ? { model } : {});
  const [key, setKey] = useState("");
  const [check, setCheck] = useState<KeyCheckView | "checking" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsKey = !provider.keyless;
  const connected = provider.connected.flatMap((id) => state.instances.filter((instance) => instance.instanceId === id));
  const [another, setAnother] = useState(false);
  const readyWith = (withFields: ProviderFields, withKey: string) =>
    requiredFields(provider).every((field) => withFields[field.id]?.trim()) && (!needsKey || withKey.trim().length > 0);
  const ready = readyWith(fields, key);

  const set = (id: keyof ProviderFields, value: string) => {
    setFields((current) => ({ ...current, [id]: value }));
    setCheck(null);
  };

  /** One provider call with the key as typed, before anything is saved. */
  const verify = async (withFields = fields, withKey = key): Promise<KeyCheckView | null> => {
    if (!readyWith(withFields, withKey)) return null;
    setCheck("checking");
    setError(null);
    try {
      const view = keyCheckView(await listModels(provider.id, withFields, withKey), provider.label);
      setCheck(view);
      return view;
    } catch (cause) {
      setCheck(null);
      setError(friendlyError(cause, t("models.check.unexpected")));
      return null;
    }
  };

  const save = async (anyway = false) => {
    if (!ready || busy || check === "checking") return;
    if (!(anyway && check && check.confirm)) {
      const view = await verify();
      if (!view || view.blocks || view.confirm) return;
    }
    setBusy(true);
    setError(null);
    try {
      const answer = await connectProvider(provider.id, fields, key, []);
      if (Array.isArray(answer.instances)) dispatch({ type: "instances", instances: answer.instances as InstanceInfo[] });
      else await refreshInstances({ reportErrors: true });
      onConnected?.(answer.instanceId, Array.isArray(answer.instances) ? answer.instances as InstanceInfo[] : []);
      onClose();
    } catch (cause) {
      setError(friendlyError(cause, t("models.connect.failed")));
    } finally {
      setBusy(false);
    }
  };

  const openSignIn = () => {
    if (!signInTile) return;
    flow.start({ tile: signInTile.id, candidates: signInTile.candidates.map((candidate) => candidate.instanceId) });
  };

  if (connected.length && !another) {
    const byKey = connected.some((instance) => instance.access === "api" || instance.snapshot.account?.method === "api-key");
    return (
      <FormDialog data-panel-modal="connect-provider" data-provider-connected="" title={provider.label} description={placeLine(place)} onClose={onClose}>
        {connected.map((instance) => (
          <div key={instance.instanceId} data-provider-connection={instance.instanceId} className="flex flex-col gap-1.5">
            <p className="m-0 flex items-center gap-1.5 text-[13px] leading-[18px] text-ink">
              <Check size={13} strokeWidth={2.5} aria-hidden="true" className="shrink-0 text-success" />{connectedVia(instance)}
            </p>
            <DisconnectProvider instance={instance} />
          </div>
        ))}
        {(needsKey || provider.fields?.length) && (
          <button type="button" data-connect-another onClick={() => setAnother(true)}
            className="h-8 rounded-[10px] bg-ink/[0.06] px-3 text-[13px] leading-[18px] text-ink hover:bg-ink/[0.09] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
            {t(!needsKey ? "models.connect.changeSettings" : byKey ? "models.connect.changeKey" : "models.connect.useKeyInstead")}
          </button>
        )}
      </FormDialog>
    );
  }

  return (
    <FormDialog
      data-panel-modal="connect-provider"
      title={t("models.connect.title", { name: provider.label })}
      description={[provider.note, placeLine(place)].filter(Boolean).join(" ")}
      saveLabel={busy ? t("models.connect.saving") : t("models.connect.save")}
      canSave={ready}
      busy={busy}
      error={error}
      onSave={() => save()}
      onClose={onClose}
    >
      {signInTile && flow.state.stage !== "idle" && (
        <div data-connect-sign-in-flow="" className="py-1">
          <ConnectPanel flow={flow} name={signInTile.label} driverKind={signInTile.instance.driverKind} />
        </div>
      )}
      {provider.signIn && signInTile && flow.state.stage === "idle" && (
        <div className="flex flex-col gap-1.5">
          <button type="button" data-connect-sign-in onClick={openSignIn}
            className="h-8 rounded-[10px] bg-ink/[0.06] px-3 text-[13px] leading-[18px] text-ink hover:bg-ink/[0.09] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
            {provider.signIn.label}
          </button>
          <p className="m-0 text-center text-[12px] leading-4 text-ink-tertiary">{t("models.connect.orKey")}</p>
        </div>
      )}
      {(provider.fields ?? []).map((field) => (
        <FormField key={field.id} label={field.optional ? t("models.connect.optional", { label: field.label }) : field.label}>
          <input data-connect-field={field.id} value={fields[field.id] ?? ""} onChange={(event) => set(field.id, event.target.value)}
            placeholder={field.placeholder} spellCheck={false} autoComplete="off" className={cn(FIELD, field.id !== "model" && "font-mono text-[12px] placeholder:font-sans")} />
        </FormField>
      ))}
      {needsKey && (
        <FormField label={t("models.connect.key")}>
          <input data-connect-key type="password" value={key} onChange={(event) => { setKey(event.target.value); setCheck(null); }}
            onPaste={(event) => {
              const pasted = cleanKey(event.clipboardData.getData("text"));
              if (!pasted) return;
              event.preventDefault();
              setKey(pasted);
              void verify(fields, pasted);
            }}
            placeholder={provider.keyPlaceholder ?? "…"} spellCheck={false} autoComplete="off" className={cn(FIELD, "font-mono text-[12px] placeholder:font-sans")} />
        </FormField>
      )}
      <div className="flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] leading-4">
        {provider.keyUrl && needsKey && (
          <a href={provider.keyUrl} target="_blank" rel="noreferrer" className="whitespace-nowrap text-ink-secondary underline-offset-2 hover:text-ink hover:underline">
            {t("models.connect.getKey")}
          </a>
        )}
        <button type="button" data-connect-check disabled={!ready || check === "checking"} onClick={() => void verify()}
          className="whitespace-nowrap text-ink-secondary underline-offset-2 enabled:hover:text-ink enabled:hover:underline disabled:opacity-45">
          {t("models.connect.check")}
        </button>
        {check === "checking" && <Loader2 size={13} className="animate-spin text-ink-tertiary" aria-label={t("models.connect.checking")} />}
        {check && check !== "checking" && (
          <div data-connect-check-result={check.tone === "ok" ? "ok" : "failed"} className="min-w-0 basis-full">
            <KeyCheckNote view={check} keyHref={provider.keyUrl} busy={busy} saveAnywayLabel={t("models.connect.anyway")}
              onSaveAnyway={() => void save(true)}
              onUseModel={(model) => { const next = { ...fields, model }; setFields(next); void verify(next, key); }} />
          </div>
        )}
      </div>
    </FormDialog>
  );
}
