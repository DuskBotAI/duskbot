import { useEffect, useRef, useState } from "react";
import { Check } from "../icons";
import { MausAvatar } from "@/components/Avatar";
import { useDraftPrefix } from "@/lib/drafts";
import { startCloudSetup } from "@/components/CloudIntent";
import { engineReady } from "@/components/EngineLibrary";
import { EngineCheckLine, useEngineLiveCheck } from "@/components/EngineLiveCheck";
import { AiCards } from "@/components/onboarding/AiCards";
import { ConnectAiDialog } from "@/components/onboarding/ConnectAi";
import { staggerIndex } from "@/components/onboarding/beats/shared";
import { productName } from "@/lib/brand";
import { reopenCloudIntent, setPendingIntent, useCloudIntent } from "@/lib/cloud-intent";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { MausMotion, MausState } from "@/lib/mascot";
import { withViewTransition } from "@/components/onboarding/view-transition";
import { useStore, type InstanceInfo } from "@/state/store";

/** The AIs a cloud signs in to itself (its own subscription engines), for the check that a new one answers. */
export function cloudOwnEngines(instances: readonly InstanceInfo[]): InstanceInfo[] {
  return instances.filter((instance) => instance.access !== "custom" && !instance.readOnly);
}

/** The Connect an AI grid every machine shows (AiCards), its check that a new one answers, and the limits that apply in
 * the cloud. More providers opens the model directory, the same as on this computer. */
export function CloudConnectAi({ className }: { className?: string }) {
  const { state } = useStore();
  const [more, setMore] = useState(false);
  const engines = cloudOwnEngines(state.instances);
  const live = useEngineLiveCheck(engines);
  return <div data-cloud-connect="" className={className}>
    <AiCards tested={null} onMore={() => setMore(true)} />
    {engines.map((instance) => {
      const check = live.checks[instance.instanceId];
      return check ? <EngineCheckLine key={instance.instanceId} name={instance.displayName} check={check} onRetry={() => void live.run(instance.instanceId)} /> : null;
    })}
    {more && <ConnectAiDialog tested={null} directory onClose={() => setMore(false)} />}
  </div>;
}

export function CloudEngineSignIn() {
  const prefix = useDraftPrefix();
  const { state, dispatch } = useStore();
  const [motion, setMotion] = useState<{ kind: MausMotion; key: number }>({ kind: "none", key: 0 });
  // One frame late: a motion issued in the avatar's mounting commit is lost.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setMotion({ kind: "arrive", key: 1 }));
    return () => cancelAnimationFrame(frame);
  }, []);
  const { pending } = useCloudIntent();
  const ready = state.instances.some(engineReady);
  const latest = useRef(state);
  latest.current = state;
  const [handing, setHanding] = useState(false);
  useEffect(() => {
    if (!pending || !ready) return;
    setHanding(true);
    setMotion({ kind: "success", key: 2 });
    const timer = setTimeout(() => {
      if (!startCloudSetup(pending, latest.current, dispatch, prefix)) setPendingIntent(null);
    }, 1200);
    return () => clearTimeout(timer);
  }, [pending, ready, dispatch, prefix]);
  const face: MausState = handing ? "proud" : "curious";

  return (
    <main data-cloud-sign-in className="relative flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-app">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(55%_100%_at_50%_0%,color-mix(in_oklab,var(--color-accent)_9%,transparent),transparent)]"
      />
      <div className="stagger relative mx-auto flex w-full max-w-[540px] flex-col px-6 pb-12 pt-[clamp(48px,10vh,112px)]">
        <div className="animate-rise flex flex-col items-center text-center" style={staggerIndex(0)}>
          <MausAvatar color="green" state={face} motion={motion.kind} motionKey={motion.key} size={64} label={productName()} />
        </div>
        {pending && (
          <figure data-cloud-intent-pending className="mt-6 rounded-2xl bg-composer px-4 pb-3 pt-2.5 ring-1 ring-transparent" style={{ viewTransitionName: "cloud-intent" }}>
            <figcaption className="flex items-center justify-between gap-3 text-[12px] text-ink-secondary">
              {t("cloudIntent.pending")}
              {!handing && (
                <button type="button" onClick={() => withViewTransition(() => reopenCloudIntent(true))} className="rounded-md px-1.5 py-0.5 font-medium text-ink-secondary transition-colors hover:bg-raised hover:text-ink">
                  {t("cloudIntent.edit")}
                </button>
              )}
            </figcaption>
            <p className="mt-1 text-[14px] leading-relaxed text-ink">
              <span className="mr-1.5 inline-flex h-[21px] items-center rounded-md bg-accent/15 px-1.5 align-[1px] text-[13px] font-semibold text-accent">/setup</span>
              {pending}
            </p>
            {handing && (
              <p role="status" className="animate-rise mt-2 flex items-center gap-1.5 text-[13px] font-medium text-success">
                <Check size={14} strokeWidth={2.5} aria-hidden="true" />
                {t("cloudSignIn.connected")}
              </p>
            )}
          </figure>
        )}
        <h1 className={cn("animate-rise text-center text-[22px] font-semibold tracking-[-0.01em] text-ink", pending ? "mt-7" : "mt-5")} style={staggerIndex(1)}>
          {t(pending ? "cloudSignIn.titleForJob" : "cloudSignIn.title")}
        </h1>
        <p className="animate-rise mx-auto mt-2 max-w-[440px] text-center text-[14px] leading-relaxed text-ink-secondary" style={staggerIndex(2)}>
          {t(pending ? "cloudSignIn.introForJob" : "cloudSignIn.intro")}
        </p>

        <div inert={handing} className={cn("animate-rise mt-8 transition-opacity duration-300 ease-out", handing && "opacity-40")} style={staggerIndex(3)}>
          <CloudConnectAi />
        </div>
      </div>
    </main>
  );
}
