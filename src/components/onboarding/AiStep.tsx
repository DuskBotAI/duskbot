// The first run's AI step, a connections screen: the grid of AIs (AiCards), where every AI already signed in on this
// computer is connected the moment the step opens (marked as the person's own, on this computer's server only; nothing
// new is sent anywhere), any other connects in place with one tap, and Continue goes on with what is connected, or on the
// free model when nothing is. More providers or an API key opens every other provider.
import { useEffect, useRef, useState } from "react";
import { LoaderCircle, RefreshCw } from "../../icons";
import { engineReady } from "@/components/EngineLibrary";
import { activeLocale, t } from "@/lib/i18n";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { AiCards } from "./AiCards";
import { ConnectAiDialog } from "./ConnectAi";
import { aiTileOf, aiTiles, freeModel, type AiTileId } from "./funnel";
import { PRIMARY, QUIET, StepArt, StepFrame } from "./FunnelSteps";
import type { WelcomeAiNow } from "./welcome-ai";

export type AiChoice = "connected" | "free" | "later";

/** The AIs found on this computer that the step connects by itself: signed in and ready, never one whose test message
 * went unanswered (that one shows why, with Check again). */
export function autoConnects<Instance extends { instanceId: string; found?: true }>(instances: readonly Instance[], ready: (instance: Instance) => boolean,
  failed: readonly string[] = []): Instance[] {
  return instances.filter((instance) => instance.found === true && ready(instance) && !failed.includes(instance.instanceId));
}

/** Marks each AI found here as the person's own, once per step, then reads the list again: from then on it counts as
 * connected everywhere (the new-bot default, Dusk's first chat), exactly as if its card had been tapped. */
function useAutoConnect(instances: readonly InstanceInfo[], failed: readonly string[]) {
  const { refreshInstances } = useStore();
  const asked = useRef(new Set<string>());
  const due = autoConnects(instances, engineReady, failed).filter((instance) => !asked.current.has(instance.instanceId));
  const key = due.map((instance) => instance.instanceId).join(",");
  useEffect(() => {
    if (!key) return;
    const ids = key.split(",");
    for (const id of ids) asked.current.add(id);
    void Promise.allSettled(ids.map((id) => api(`/api/instances/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ chosen: true }), signal: AbortSignal.timeout(10_000) })))
      .then(() => Promise.resolve(refreshInstances?.()).catch(() => {}));
  }, [key, refreshInstances]);
}

/** `onNext` says how the person went on, for the funnel's numbers. `cloud`: the person's dusk cloud is being made
 * meanwhile, which the line says, with the AIs whose sign-in goes along. */
export function AiStep({ tested, cloud = false, computerAis = [], onNext }: { tested: WelcomeAiNow | null; cloud?: boolean;
  /** on a cloud the desktop app set up: the AIs signed in on that computer, by instance id */
  computerAis?: readonly string[]; onNext: (how: AiChoice) => void }) {
  const { state } = useStore();
  const [more, setMore] = useState(false);
  const failed = tested?.state === "failed" ? [tested.instance.instanceId] : [];
  useAutoConnect(state.instances, failed);
  const tiles = aiTiles(state.instances, engineReady);
  const connected = tiles.filter((tile) => engineReady(tile.instance) && !failed.includes(tile.instance.instanceId));
  // a dusk cloud being made brings free models of its own
  const free = cloud ? "ready" : freeOffer(state.instances, state.config?.freeBackupDownloading === true);
  const used = computerTiles(computerAis, state.instances);
  const usedLeft = tiles.filter((tile) => used.includes(tile.id) && !engineReady(tile.instance));
  const carried = useCarriedTiles(cloud && connected.length > 0, connected.map((tile) => tile.instance.instanceId).join(","));
  const staysHere = carried ? connected.filter((tile) => !carried.includes(tile.id)).map((tile) => tile.id) : [];
  const sub = usedLeft.length ? t("funnel.ai.subComputer", { ais: list(usedLeft) })
    : cloud && carried && connected.length ? carriedLine(connected, staysHere)
    : cloud ? t(free ? "funnel.ai.subCloud" : "funnel.ai.subCloudNoFree")
    : connected.length ? t("funnel.ai.connectSubFound", { ais: list(connected) }) : t("funnel.ai.connectSub");
  const goes = connected.length > 0 || free === "ready";
  return (
    <StepFrame art={<StepArt art="plug" />} title={t("funnel.ai.connectTitle")} sub={sub} wide
      footer={<>
        <button type="button" data-primary="" data-funnel-ai-continue="" autoFocus={goes} disabled={!goes}
          onClick={() => onNext(connected.length ? "connected" : "free")} className={PRIMARY}>{t("funnel.next")}</button>
        {!connected.length && free === "ready" && !cloud && <p data-funnel-free-line="" className="text-center text-[13px] leading-[18px] text-ink-tertiary">{t("funnel.ai.freeUntil")}</p>}
        {!connected.length && free === "downloading" && (
          <p role="status" data-funnel-free-line="" className="flex items-center gap-1.5 text-[13px] leading-[18px] text-ink-tertiary">
            <LoaderCircle size={13} aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none" />{t("funnel.ai.freeGettingReady")}
          </p>
        )}
        {!goes && !free && <button type="button" data-funnel-later="" onClick={() => onNext("later")} className={QUIET}>{t("funnel.ai.later")}</button>}
      </>}>
      <AiCards tested={tested} onMore={() => setMore(true)} suggested={used} staysHere={staysHere} foundRow />

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

/** Free models as a choice: "ready" to pick, "downloading" while they arrive (shown, not yet pickable), or null when
 * none is coming, so nobody picks free models only to be told to sign in somewhere. */
export function freeOffer(instances: readonly InstanceInfo[], downloading: boolean): "ready" | "downloading" | null {
  if (freeModel(instances, engineReady)) return "ready";
  return downloading ? "downloading" : null;
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
