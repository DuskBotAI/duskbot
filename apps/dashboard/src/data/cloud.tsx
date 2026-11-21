import type { DeleteAccountOptions } from "../../../../shared/billing-api";
import type { WebsiteHome } from "../../../../shared/account-api";
import type { ConnectorsAnswer } from "../../../../shared/dashboard-protocol";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError, FIXTURE, type AccountData } from "../lib/api";
import type { BillingOverview, ChangeOffer, CheckoutRequest, CloudDesktop, DesktopId, IdentityProvider, MachineSpec, NotificationPrefs, PlanCatalog, Selection } from "./contracts";
import { fixtureCatalog } from "./fixtures";
import type { CancelAnswer, CancelSurvey, RetentionInput } from "./wire";

export interface CloudData {
  catalog: PlanCatalog | null;
  billing: BillingOverview | null;
  clouds: CloudDesktop[] | null;
  account: AccountData | null;
  connections: Record<string, string[]> | null;
  /** per workspace, apps whose sign-in was started and not finished */
  pendingApps: Record<string, string[]>;
  /** whether each workspace can connect apps itself (a Composio key or Composio Connect there); false: only its own app can */
  appsAvailable: Record<string, boolean>;
  /** per workspace, apps connected in the app itself (MCP servers, token apps, a mailbox): only that app changes them */
  appsInApp: Record<string, string[]>;
  /** reads the connected apps again; resolves with the new answer, or null when it failed */
  reloadConnections(): Promise<ConnectorsAnswer | null>;
  error: string | null;
  refresh(): void;
  checkout(req: CheckoutRequest): Promise<boolean>;
  power(id: string, on: boolean): Promise<void>;
  resize(id: string, req: { tier: Exclude<DesktopId, "none">; size: MachineSpec | null }): Promise<void>;
  /** what changing to `selection` does: today's charge, the next one and when; every change is confirmed with it */
  changeCharge(selection: Selection): Promise<ChangeOffer>;
  changePlan(selection: Selection, approvedUsd?: number): Promise<void>;
  cancel(survey: CancelSurvey | null): Promise<void>;
  /** a plan set to end renews again */
  keep(): Promise<void>;
  /** records a cancel flow step; never throws */
  retentionStep(input: RetentionInput): void;
  takeDiscount(reason: CancelAnswer): Promise<void>;
  updateCard(): Promise<void>;
  setNotifications(p: NotificationPrefs): Promise<void>;
  updateProfile(name: string): Promise<void>;
  unlinkIdentity(p: IdentityProvider): Promise<void>;
  revokeDevice(id: string): Promise<void>;
  signOutEverywhere(): Promise<void>;
  deleteAccount(confirm: string, options?: DeleteAccountOptions): Promise<void>;
  finishOnboarding(home?: WebsiteHome): Promise<void>;
}

const Ctx = createContext<CloudData | null>(null);
const visible = () => typeof document === "undefined" || document.visibilityState === "visible";
const apiError = (error: unknown) => error instanceof ApiError ? error : new ApiError(error instanceof Error ? error.message : "something went wrong. try again.", 0, null);

export function CloudDataProvider({ children, signedIn }: { children: ReactNode; signedIn: boolean }) {
  const [catalog, setCatalog] = useState<PlanCatalog | null>(null);
  const [billing, setBilling] = useState<BillingOverview | null>(null);
  const [clouds, setClouds] = useState<CloudDesktop[] | null>(null);
  const [account, setAccount] = useState<AccountData | null>(null);
  const [connections, setConnections] = useState<Record<string, string[]> | null>(null);
  const [pendingApps, setPendingApps] = useState<Record<string, string[]>>({});
  const [appsAvailable, setAppsAvailable] = useState<Record<string, boolean>>({});
  const [appsInApp, setAppsInApp] = useState<Record<string, string[]>>({});
  const takeConnections = useCallback((answer: ConnectorsAnswer) => {
    setConnections(answer.byWorkspace); setPendingApps(answer.pending ?? {}); setAppsAvailable(answer.available ?? {}); setAppsInApp(answer.inApp ?? {});
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [pending, setPending] = useState<Record<string, { on: boolean; until: number }>>({});
  const catalogRequest = useRef<Promise<PlanCatalog> | null>(null);
  const active = useRef(signedIn);
  const previousSignedIn = useRef(signedIn);
  const generation = useRef(0);
  const cloudRequest = useRef(0);
  if (previousSignedIn.current !== signedIn) { active.current = signedIn; previousSignedIn.current = signedIn; }

  const clearAccount = useCallback(() => {
    setBilling(null); setClouds(null); setAccount(null); setConnections(null); setPendingApps({}); setAppsAvailable({}); setAppsInApp({}); setPending({});
  }, []);
  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    const version = ++generation.current;
    if (!signedIn || !active.current) { clearAccount(); setError(null); return; }
    let alive = true;
    const request = ++cloudRequest.current;
    catalogRequest.current ??= api.catalog();
    void Promise.allSettled([catalogRequest.current, api.overview(), api.account(), api.connections()] as const).then(([plans, overview, profile, apps]) => {
      if (!alive || !active.current || generation.current !== version) return;
      const errors: string[] = [];
      if (plans.status === "fulfilled") setCatalog(plans.value);
      else {
        catalogRequest.current = null;
        if (plans.reason instanceof ApiError && plans.reason.status === 404) setCatalog(fixtureCatalog);
        errors.push(apiError(plans.reason).message);
      }
      if (overview.status === "fulfilled") {
        setBilling(overview.value.billing);
        if (request === cloudRequest.current) setClouds(overview.value.clouds);
      } else {
        setBilling(null);
        if (request === cloudRequest.current) setClouds(null);
        errors.push(apiError(overview.reason).message);
      }
      if (profile.status === "fulfilled") setAccount(profile.value); else { setAccount(null); errors.push(apiError(profile.reason).message); }
      if (apps.status === "fulfilled") takeConnections(apps.value); else { setConnections(null); errors.push(apiError(apps.reason).message); }
      setError([...new Set(errors)].join(" ") || null);
    });
    return () => { alive = false; };
  }, [signedIn, tick, clearAccount, takeConnections]);

  useEffect(() => {
    if (!signedIn || !active.current) return;
    let alive = true, loading = false;
    const version = generation.current;
    const load = async () => {
      if (!visible() || loading || !active.current) return;
      loading = true;
      const request = ++cloudRequest.current;
      try {
        const result = await api.clouds();
        if (!alive || !active.current || version !== generation.current || request !== cloudRequest.current) return;
        setClouds(result.clouds);
        setPending((previous) => {
          const entries = Object.entries(previous).filter(([id, power]) => {
            const cloud = result.clouds.find((c) => c.id === id);
            return cloud && Date.now() < power.until && !(power.on ? cloud.status === "running" || cloud.status === "waking" : cloud.status === "sleeping" || cloud.status === "stopped");
          });
          return entries.length === Object.keys(previous).length ? previous : Object.fromEntries(entries);
        });
      } catch (e) {
        if (alive && active.current && version === generation.current) setError(apiError(e).message);
      } finally { loading = false; }
    };
    const fast = clouds?.some((cloud) => cloud.status === "provisioning") || Object.keys(pending).length > 0;
    const id = setInterval(() => { void load(); }, fast ? 2000 : 15_000);
    const onVisibility = () => { void load(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { alive = false; clearInterval(id); document.removeEventListener("visibilitychange", onVisibility); };
  }, [signedIn, tick, clouds, pending]);

  const mutate = useCallback(async (action: () => Promise<unknown>) => {
    const version = generation.current;
    try {
      if (!active.current) throw new ApiError("sign in to continue.", 401, "unauthorized");
      await action();
      if (active.current && version === generation.current) { setError(null); refresh(); }
    } catch (e) {
      const failure = apiError(e);
      if (version === generation.current) setError(failure.message);
      throw failure;
    }
  }, [refresh]);

  const opening = useRef<Promise<boolean> | null>(null);
  const checkout = useCallback(async (req: CheckoutRequest) => {
    if (FIXTURE) {
      try { await mutate(() => api.checkout(req)); return true; } catch { return false; }
    }
    // one payment page at a time: another click while one is on its way waits on that one instead of asking again
    if (opening.current) return opening.current;
    if (!active.current) return false;
    const open = (async () => {
      try {
        const answer = await api.checkout(req);
        // straight to the payment page: no refresh first, so nothing is drawn between the click and dodo
        window.addEventListener("pageshow", (event) => { if (event.persisted) window.location.reload(); }, { once: true });
        window.location.assign(answer.url);
      } catch (e) { setError(apiError(e).message); opening.current = null; return false; }
      // on its way to the payment page: nothing is paid yet, so whoever asked keeps waiting instead of saying so
      return new Promise<never>(() => {});
    })();
    opening.current = open;
    return open;
  }, [mutate]);

  const power = useCallback(async (id: string, on: boolean) => {
    if (!active.current) return mutate(() => api.power(id, on));
    setPending((previous) => ({ ...previous, [id]: { on, until: Date.now() + 30_000 } }));
    try { await mutate(() => api.power(id, on)); }
    catch (e) { setPending((previous) => { const next = { ...previous }; delete next[id]; return next; }); throw e; }
  }, [mutate]);

  const signOutEverywhere = useCallback(async () => {
    await mutate(() => api.signOutEverywhere());
    active.current = false; generation.current++; clearAccount();
  }, [mutate, clearAccount]);

  const deleteAccount = useCallback(async (confirm: string, options?: DeleteAccountOptions) => {
    await mutate(() => api.deleteAccount(confirm, options));
    active.current = false; generation.current++; clearAccount();
  }, [mutate, clearAccount]);

  const reloadConnections = useCallback(async () => {
    const version = generation.current;
    try {
      const answer = await api.connections();
      if (!active.current || version !== generation.current) return null;
      takeConnections(answer);
      return answer;
    } catch { return null; }
  }, [takeConnections]);

  const value = useMemo<CloudData>(() => ({
    catalog, billing, clouds, account, connections, pendingApps, appsAvailable, appsInApp, reloadConnections, error, refresh, checkout, power,
    resize: (id, req) => mutate(() => api.resize(id, req)),
    changeCharge: (selection) => api.changeCharge(selection),
    changePlan: (selection, approvedUsd) => mutate(() => api.changePlan(selection, approvedUsd)),
    cancel: (survey) => mutate(() => api.cancel(survey)),
    keep: () => mutate(() => api.keep()),
    retentionStep: (input) => { void api.retention(input).catch(() => {}); },
    takeDiscount: (reason) => mutate(() => api.discount(reason)),
    updateCard: () => mutate(async () => { const answer = await api.updateCard(); if (!FIXTURE) window.location.assign(answer.url); }),
    setNotifications: (p) => mutate(() => api.setNotifications(p)),
    updateProfile: (name) => mutate(() => api.updateProfile({ name })),
    unlinkIdentity: (p) => mutate(() => api.unlinkIdentity(p)),
    revokeDevice: (id) => mutate(() => api.revokeDevice(id)),
    finishOnboarding: (home?: WebsiteHome) => mutate(async () => {
      await api.finishOnboarding(home);
      setAccount((a) => (a ? { ...a, profile: { ...a.profile, onboarded: true } } : a));
    }),
    signOutEverywhere, deleteAccount,
  }), [catalog, billing, clouds, account, connections, pendingApps, appsAvailable, appsInApp, reloadConnections, error, refresh, checkout, power, mutate, signOutEverywhere, deleteAccount]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** the clouds, or null outside the provider (data hooks that also run on their own) */
export const useClouds = (): CloudDesktop[] | null => useContext(Ctx)?.clouds ?? null;

export function useCloud(): CloudData {
  const data = useContext(Ctx);
  if (!data) throw new Error("useCloud outside CloudDataProvider");
  return data;
}

export const cloudForWorkspace = (clouds: CloudDesktop[] | null, workspaceId: string | null | undefined): CloudDesktop | null => clouds?.find((cloud) => cloud.workspaceId !== null && cloud.workspaceId === workspaceId) ?? null;
