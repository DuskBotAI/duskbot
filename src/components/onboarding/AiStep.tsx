// The first run's one AI choice: the AI already signed in on this computer in one tap, free models, or a plan the
// person already has (the grid of AIs, AiCards). More ways opens every other provider and API keys.
import { useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, LoaderCircle, RefreshCw, Sparkles } from "../../icons";
import { engineReady } from "@/components/EngineLibrary";
import { ProviderMark } from "@/components/ProviderIcons";
import { cn } from "@/lib/cn";
import { activeLocale, t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { AiCards } from "./AiCards";
import { ConnectAiDialog } from "./ConnectAi";
import { aiName, aiTileOf, aiTiles, freeModel, type AiTileId } from "./funnel";
import { PRIMARY, QUIET, SECONDARY, StepArt, StepFrame, TILE } from "./FunnelSteps";
import type { WelcomeAiNow } from "./welcome-ai";

export type AiChoice = "own" | "free" | "connected" | "later";

function ChoiceTile({ kind, icon, title, sub, busy = false, wide = false, autoFocus = false, onClick }: {
  kind: string; icon: ReactNode; title: string; sub: ReactNode; busy?: boolean; wide?: boolean; autoFocus?: boolean; onClick: () => void;
}) {
  return (
    <button type="button" {...{ [`data-funnel-${kind}`]: "" }} disabled={busy} aria-busy={busy || undefined} autoFocus={autoFocus} onClick={onClick}
      className={cn(TILE, "flex min-h-11 min-w-0 flex-col items-start gap-3 p-5 text-start disabled:cursor-default disabled:hover:bg-ink/[0.035]", wide && "sm:col-span-2")}>
      <span aria-hidden="true" className="flex h-7 items-center gap-1.5">{icon}</span>
      <span className="text-[15px] font-semibold leading-5 text-ink">{title}</span>
      <span className="text-[13px] leading-[18px] text-ink-secondary">{sub}</span>
    </button>
  );
}

/** `onNext` says what the person chose, for the funnel's numbers. `cloud`: the person's dusk cloud is being made meanwhile,
 * which the line says, with the AIs whose sign-in goes along. */
export function AiStep({ tested, cloud = false, computerAis = [], onNext }: { tested: WelcomeAiNow | null; cloud?: boolean;
  /** on a cloud the desktop app set up: the AIs signed in on that computer, by instance id */
  computerAis?: readonly string[]; onNext: (how: AiChoice) => void }) {
  const [plan, setPlan] = useState(false);
  const own = tested && tested.state !== "failed" ? tested : null;
  if (plan) return <PlanStep tested={tested} cloud={cloud} computerAis={computerAis} onNext={onNext} onBack={() => setPlan(false)} />;
  const ownName = own ? aiName(own.instance) : "";
  const checking = own?.state === "testing";
  return (
    <StepFrame art={<StepArt art="plug" />} title={t("funnel.ai.chooseTitle")} sub={cloud ? t("funnel.ai.chooseCloud") : t("funnel.ai.chooseSub")} wide>
      <div role="group" aria-label={t("funnel.ai.chooseTitle")} className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
        {own && (
          <ChoiceTile kind="own" wide autoFocus={!checking} busy={checking} onClick={() => onNext("own")}
            icon={<ProviderMark driverKind={own.instance.driverKind} size={24} />}
            title={t("funnel.ai.useOwn", { name: ownName })}
            sub={checking
              ? <span role="status" className="flex items-center gap-1.5"><LoaderCircle size={13} aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none" />{t("onboarding.engines.checkingAnswer", { name: ownName })}</span>
              : t("funnel.ai.useOwnSub")} />
        )}
        <ChoiceTile kind="free" autoFocus={!own} onClick={() => onNext("free")}
          icon={<Sparkles size={22} strokeWidth={1.5} className="text-ink-secondary" />}
          title={t("funnel.ai.useFree")} sub={t("funnel.ai.useFreeSub")} />
        <ChoiceTile kind="plan" onClick={() => setPlan(true)}
          icon={<><ProviderMark driverKind="claudeAgent" size={20} /><ProviderMark driverKind="codex" size={20} /><ProviderMark driverKind="antigravityAgent" size={20} /></>}
          title={t("funnel.ai.usePlan")} sub={t("funnel.ai.usePlanSub")} />
      </div>
    </StepFrame>
  );
}

/** A plan the person already has: the grid, Continue once one is connected, free models instead, or back to the choice. */
function PlanStep({ tested, cloud, computerAis, onNext, onBack }: { tested: WelcomeAiNow | null; cloud: boolean; computerAis: readonly string[];
  onNext: (how: AiChoice) => void; onBack: () => void }) {
  const { state } = useStore();
  const [more, setMore] = useState(false);
  const free = freeModel(state.instances, engineReady);
  const tiles = aiTiles(state.instances, engineReady);
  const connected = tiles.filter((tile) => engineReady(tile.instance));
  const used = computerTiles(computerAis, state.instances);
  const usedLeft = tiles.filter((tile) => used.includes(tile.id) && !engineReady(tile.instance));
  const carried = useCarriedTiles(cloud && connected.length > 0, connected.map((tile) => tile.instance.instanceId).join(","));
  const staysHere = carried ? connected.filter((tile) => !carried.includes(tile.id)).map((tile) => tile.id) : [];
  const sub = usedLeft.length
    ? t("funnel.ai.subComputer", { ais: list(usedLeft) })
    : cloud && carried && connected.length ? carriedLine(connected, staysHere)
    : connected.length ? t("funnel.ai.subMore") : cloud ? t(free ? "funnel.ai.subCloud" : "funnel.ai.subCloudNoFree") : t("funnel.ai.sub");
  return (
    <StepFrame art={<StepArt art="plug" />} title={t("funnel.ai.title")} sub={sub} wide
      footer={<>
        <button type="button" data-primary="" data-funnel-ai-continue="" disabled={connected.length === 0} onClick={() => onNext("connected")} className={PRIMARY}>{t("funnel.next")}</button>
        {connected.length === 0 && <button type="button" data-funnel-free="" onClick={() => onNext("free")} className={SECONDARY}>{t("funnel.ai.useFreeInstead")}</button>}
        <button type="button" data-funnel-choices="" onClick={onBack} className={cn(QUIET, "inline-flex items-center gap-0.5")}>
          <ChevronLeft size={14} strokeWidth={1.5} aria-hidden="true" className="rtl:-scale-x-100" />{t("funnel.ai.otherChoices")}
        </button>
      </>}>
      <AiCards tested={tested} onMore={() => setMore(true)} suggested={used} staysHere={staysHere} />

      {tested?.state === "testing" && (
        <p role="status" data-ai-checking="" className="mt-5 flex items-center gap-2 text-[14px] text-ink-secondary">
          <LoaderCircle size={15} aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none" />
          {t("onboarding.engines.checkingAnswer", { name: aiName(tested.instance) })}
        </p>
      )}
      {tested?.state === "failed" && (
        <div role="alert" data-ai-silent="" className="mt-5 flex flex-col items-center gap-2 text-[13px] leading-5 text-ink">
          <p>{tested.error ?? t("onboarding.engines.noAnswer", { name: tested.instance.displayName })}</p>
          <button type="button" onClick={tested.retry} className="ui-button ui-button-pill ui-button-sm"><RefreshCw size={12} aria-hidden="true" />{t("common.checkAgain")}</button>
        </div>
      )}
      {more && <ConnectAiDialog tested={tested} directory onClose={() => setMore(false)} />}
    </StepFrame>
  );
}

const list = (tiles: readonly { label: string }[]) => new Intl.ListFormat(activeLocale(), { style: "long", type: "conjunction" }).format(tiles.map((tile) => tile.label));

/** On the way to dusk cloud: which of the AIs connected here go along, and which the cloud asks for once more. */
function carriedLine(connected: readonly { id: AiTileId; label: string }[], staysHere: readonly AiTileId[]): string {
  const stay = connected.filter((tile) => staysHere.includes(tile.id));
  if (!stay.length) return t("funnel.ai.subCarry");
  return t(stay.length === connected.length ? "funnel.ai.subCarryNone" : "funnel.ai.subCarrySome", { ais: list(stay) });
}

/** The grid's AIs whose sign-in on this computer goes along to the person's dusk cloud, asked again as `connected`
 * changes; null until known, or where this app can't say. */
function useCarriedTiles(on: boolean, connected: string): AiTileId[] | null {
  const { state } = useStore();
  const [ids, setIds] = useState<string[] | null>(null);
  const bridge = window.duskDesktop?.cloudAccount;
  useEffect(() => {
    if (!on || !bridge?.carriedAis) return;
    let live = true;
    void bridge.carriedAis().then((answer) => { if (live) setIds(answer.instanceIds); }, () => {});
    return () => { live = false; };
  }, [on, connected, bridge]);
  return ids ? computerTiles(ids, state.instances) : null;
}

/** The grid's cards for the AIs signed in on the computer that set this cloud up. */
export function computerTiles(ids: readonly string[], instances: readonly { instanceId: string; driverKind: string }[]): AiTileId[] {
  const tiles = ids.map((id) => aiTileOf(instances.find((instance) => instance.instanceId === id) ?? { instanceId: id, driverKind: "" }));
  return [...new Set(tiles.filter((tile): tile is AiTileId => Boolean(tile)))];
}
