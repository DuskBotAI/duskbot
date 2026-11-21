import { useCallback, useEffect, useRef, useState } from "react";
import type { MobileConnectionRecord } from "../../../shared/mobile-link";
import { useMobileAccount } from "../account/AccountGate";
import { usePlatform, type MobilePlatform } from "../platform";
import type { AccountPlaces, CloudPairGrant, CloudPairResult, ComputerPairResult, MobileCloud, MobileComputer, MobileTeamCloud } from "../account/account-client";
import { cloudPairing } from "../account/cloud-pair";
import { removePlace as removeSavedPlace } from "../account/sign-out";
import { placeKind } from "./connection-notice";
import { useConnections } from "./connections";

export type PlaceStatus = "online" | "asleep" | "offline";
export type PlaceKind = "computer" | "cloud" | "team";
export type PlaceAction = "rename" | "remove";
/** `accountId`: the phone's other signed-in account the place is reached through; the account in use without it */
export type PlaceTarget = { kind: "linked"; id: string } | { kind: "cloud"; cloud: MobileCloud; accountId?: string } | { kind: "team"; cloud: MobileTeamCloud; accountId?: string }
  | { kind: "computer"; computer: MobileComputer; accountId?: string };
export type PlaceOutcome = CloudPairResult["outcome"] | ComputerPairResult["outcome"] | "switched";
export type Place = {
  key: string;
  name: string;
  status: PlaceStatus;
  active: boolean;
  target: PlaceTarget;
  kind: PlaceKind;
  synced: boolean;
  accountComputer?: { id: string; accountId?: string };
};

export function placeActions(place: Pick<Place, "target">): readonly PlaceAction[] {
  return place.target.kind === "linked" || place.target.kind === "computer" ? ["rename", "remove"] : [];
}

const GONE = new Set(["ended", "checkout", "destroyed"]);

function cloudStatus(cloud: { status: string; asleep: boolean }): PlaceStatus {
  if (cloud.status === "ready") return cloud.asleep ? "asleep" : "online";
  return cloud.status === "stopped" ? "asleep" : "offline";
}

function recordOrigins(record: Pick<MobileConnectionRecord, "origin" | "via">): string[] {
  const origins = [record.origin, ...(record.via ?? []).map((route) => (route.kind === "https" ? route.url : undefined))];
  return origins.filter((origin): origin is string => Boolean(origin));
}

/** another account signed in on the phone, with what it lists */
export type OtherAccountPlaces = { accountId: string; places: AccountPlaces };
type Owned<T> = T & { accountId?: string };

/** Everything the person can open from this phone: the places it already links to, then the clouds, teams' clouds and
 * computers of the account in use and of the phone's other accounts that it does not link to yet. A linked place an
 * account also lists shows once, with that account's status. */
export function mergePlaces({ records, activeId, connected, account, others = [] }: {
  records: readonly MobileConnectionRecord[];
  activeId: string | null;
  connected: boolean;
  account: AccountPlaces | null;
  others?: readonly OtherAccountPlaces[];
}): Place[] {
  const lists: { accountId?: string; places: AccountPlaces | null }[] = [{ places: account }, ...others];
  const owned = <T,>(pick: (places: AccountPlaces) => T[]): Owned<T>[] =>
    lists.flatMap(({ accountId, places }) => (places ? pick(places).map((item): Owned<T> => Object.assign({}, item, accountId ? { accountId } : {})) : []));
  const unique = <T extends { id: string }>(items: Owned<T>[]) => items.filter((item, index) => items.findIndex((other) => other.id === item.id) === index);
  const clouds = unique(owned((places) => places.clouds)).filter((cloud) => !GONE.has(cloud.status));
  const teams = unique(owned((places) => places.teams));
  const computers = unique(owned((places) => places.computers));
  const claimed = new Set<string>();
  const linked = records.map((record): Place => {
    const origins = recordOrigins(record);
    const ownMatch = clouds.find((cloud) => cloud.origin && origins.includes(cloud.origin));
    const teamMatch = ownMatch ? undefined : teams.find((cloud) => cloud.origin && origins.includes(cloud.origin));
    const match = ownMatch ?? teamMatch;
    const computer = match ? undefined : computers.find((one) => one.environmentId !== null && one.environmentId === record.environmentId);
    if (match) claimed.add(match.id);
    if (computer) claimed.add(computer.id);
    const active = record.id === activeId;
    const status: PlaceStatus = active && connected ? "online" : match ? cloudStatus(match) : computer ? computer.presence : "offline";
    const kind: PlaceKind = teamMatch ? "team" : ownMatch || placeKind(record) === "cloud" ? "cloud" : "computer";
    return {
      key: `linked:${record.id}`,
      name: record.label.trim() || match?.name || computer?.name || record.label,
      status,
      active,
      target: { kind: "linked", id: record.id },
      kind,
      synced: Boolean(match || computer),
      ...(computer ? { accountComputer: { id: computer.id, ...(computer.accountId ? { accountId: computer.accountId } : {}) } } : {}),
    };
  });
  const by = (accountId?: string) => (accountId ? { accountId } : {});
  const own = clouds.filter((cloud) => !claimed.has(cloud.id)).map(({ accountId, ...cloud }): Place => ({ key: `cloud:${cloud.id}`, name: cloud.name, status: cloudStatus(cloud), active: false, target: { kind: "cloud", cloud, ...by(accountId) }, kind: "cloud", synced: true }));
  const team = teams.filter((cloud) => !claimed.has(cloud.id)).map(({ accountId, ...cloud }): Place => ({ key: `team:${cloud.id}`, name: cloud.name, status: cloudStatus(cloud), active: false, target: { kind: "team", cloud, ...by(accountId) }, kind: "team", synced: true }));
  const machines = computers.filter((one) => !claimed.has(one.id)).map(({ accountId, ...computer }): Place => ({
    key: `computer:${computer.id}`, name: computer.name, status: computer.presence, active: false,
    target: { kind: "computer", computer, ...by(accountId) }, kind: "computer", synced: true,
    accountComputer: { id: computer.id, ...by(accountId) },
  }));
  return [...linked, ...own, ...team, ...machines];
}

/** what the pairing step reads as a typed link: the cloud's address and its one-time code */
export const pairingText = (grant: CloudPairGrant) => `${grant.origin} ${grant.code.replace(/-/g, "")}`;

const seen = new Map<string, AccountPlaces>();
const OTHERS_KEY = "others:";
const COUNT_KEY = "dusk.mobile.places.count";
const rememberedCount = new WeakMap<MobilePlatform, number>();

export type PlacesState = {
  places: Place[] | null;
  expected: number;
  open(place: Place): Promise<PlaceOutcome>;
  rename(place: Place, name: string): Promise<boolean>;
  remove(place: Place): Promise<{ ok: boolean; reload: boolean }>;
  payment: { name: string; fixBy: number; trial?: true } | null;
};

/** The places list for Settings: null until both the saved links and the account's answer are in, so the rows draw once
 * at their final size. The last answer per account is kept for the session, so reopening Settings draws at once, and the
 * last row count is kept on the phone, so the skeleton holds the same height. */
export function usePlaces(connected: boolean): PlacesState {
  const { connections, activeId, loaded, switchTo, rename: renameConnection, refresh: refreshConnections } = useConnections();
  const platform = usePlatform();
  const [remembered, setRemembered] = useState(() => rememberedCount.get(platform) ?? 0);
  useEffect(() => {
    if (rememberedCount.has(platform)) return;
    void platform.prefs.get(COUNT_KEY).then((value) => { rememberedCount.set(platform, Number(value) || 0); setRemembered(Number(value) || 0); }).catch(() => {});
  }, [platform]);
  const account = useMobileAccount();
  const accountRef = useRef(account);
  accountRef.current = account;
  const accountId = account?.account?.id ?? null;
  const otherIds = (account?.accounts ?? []).map((one) => one.id).filter((id) => id !== accountId).join(",");
  const [remote, setRemote] = useState<AccountPlaces | null | undefined>(() => (accountId ? seen.get(accountId) : null));
  const [others, setOthers] = useState<OtherAccountPlaces[]>([]);
  useEffect(() => {
    const client = accountRef.current;
    if (!accountId || !client) { setRemote(null); return; }
    let live = true;
    setRemote(seen.get(accountId));
    void client.places().then((answer) => {
      if (!live) return;
      if (answer) seen.set(accountId, answer);
      setRemote(answer ?? seen.get(accountId) ?? null);
    });
    return () => { live = false; };
  }, [accountId]);
  useEffect(() => {
    const client = accountRef.current;
    const ids = otherIds ? otherIds.split(",") : [];
    if (!client || ids.length === 0) { setOthers([]); return; }
    let live = true;
    const kept = (id: string) => seen.get(`${OTHERS_KEY}${id}`);
    setOthers(ids.flatMap((id) => { const places = kept(id); return places ? [{ accountId: id, places }] : []; }));
    void Promise.all(ids.map(async (id) => {
      const places = await client.places(id).catch(() => null);
      if (places) seen.set(`${OTHERS_KEY}${id}`, places);
      const known = places ?? kept(id);
      return known ? [{ accountId: id, places: known }] : [];
    })).then((answers) => { if (live) setOthers(answers.flat()); });
    return () => { live = false; };
  }, [otherIds]);
  const places = loaded && remote !== undefined ? mergePlaces({ records: connections, activeId, connected, account: remote, others }) : null;
  const count = places?.length;
  useEffect(() => {
    if (count === undefined || rememberedCount.get(platform) === count) return;
    rememberedCount.set(platform, count);
    void platform.prefs.set(COUNT_KEY, String(count)).catch(() => {});
  }, [platform, count]);
  const updateComputers = useCallback((targetAccountId: string | undefined, update: (computers: MobileComputer[]) => MobileComputer[]) => {
    const owner = targetAccountId ?? accountId;
    if (owner) {
      for (const key of [owner, `${OTHERS_KEY}${owner}`]) {
        const cached = seen.get(key);
        if (cached) seen.set(key, { ...cached, computers: update(cached.computers) });
      }
    }
    if (!targetAccountId || targetAccountId === accountId) {
      setRemote((current) => (current ? { ...current, computers: update(current.computers) } : current));
    } else {
      setOthers((current) => current.map((entry) => entry.accountId === targetAccountId ? { ...entry, places: { ...entry.places, computers: update(entry.places.computers) } } : entry));
    }
  }, [accountId]);
  const open = useCallback(async (place: Place): Promise<PlaceOutcome> => {
    const { target } = place;
    if (target.kind === "linked") { await switchTo(target.id); return "switched"; }
    const client = accountRef.current;
    if (!client) return "signed-out";
    // the place's account is in use when it links, so the link is kept as that account's
    if (target.accountId && !(await client.switchAccount(target.accountId))) return "signed-out";
    if (target.kind === "computer") {
      const result = await client.pairComputer(target.computer, target.accountId);
      if (result.outcome === "paired") window.dispatchEvent(new CustomEvent("dusk:pair-link", { detail: result.link }));
      return result.outcome;
    }
    const pairing = { pairCloud: (cloud: MobileCloud) => client.pairCloud(cloud, target.accountId), wakeCloud: () => client.wakeCloud(target.accountId) };
    const result = target.kind === "cloud" ? await cloudPairing(pairing, target.cloud) : await client.pairTeamCloud(target.cloud, target.accountId);
    if (result.outcome === "paired") window.dispatchEvent(new CustomEvent("dusk:pair-link", { detail: pairingText(result.grant) }));
    return result.outcome;
  }, [switchTo]);
  const rename = useCallback(async (place: Place, rawName: string): Promise<boolean> => {
    const name = rawName.trim().slice(0, 60);
    if (!name || [...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return false;
    const { target } = place;
    if (target.kind === "linked") {
      await renameConnection(target.id, name);
      if (place.accountComputer && accountRef.current) {
        const synced = place.accountComputer;
        const result = await accountRef.current.renameComputer({ id: synced.id }, name, synced.accountId).catch(() => ({ outcome: "failed" as const }));
        if (result.outcome === "ok") updateComputers(synced.accountId, (list) => list.map((one) => one.id === synced.id ? { ...one, name } : one));
      }
      return true;
    }
    if (target.kind === "computer") {
      const client = accountRef.current;
      if (!client) return false;
      const result = await client.renameComputer(target.computer, name, target.accountId);
      if (result.outcome !== "ok") return false;
      updateComputers(target.accountId, (list) => list.map((one) => one.id === target.computer.id ? { ...one, name } : one));
      return true;
    }
    return false;
  }, [renameConnection, updateComputers]);
  const remove = useCallback(async (place: Place): Promise<{ ok: boolean; reload: boolean }> => {
    const { target } = place;
    if (target.kind === "linked") {
      const wasActive = target.id === activeId;
      if (place.accountComputer && accountRef.current) {
        const synced = place.accountComputer;
        const result = await accountRef.current.removeComputer({ id: synced.id }, synced.accountId).catch(() => ({ outcome: "failed" as const }));
        if (result.outcome === "ok" || result.outcome === "not-found") updateComputers(synced.accountId, (list) => list.filter((one) => one.id !== synced.id));
      }
      await removeSavedPlace(platform, target.id);
      if (!wasActive) await refreshConnections();
      return { ok: true, reload: wasActive };
    }
    if (target.kind === "computer") {
      const client = accountRef.current;
      if (!client) return { ok: false, reload: false };
      const result = await client.removeComputer(target.computer, target.accountId);
      if (result.outcome !== "ok" && result.outcome !== "not-found") return { ok: false, reload: false };
      updateComputers(target.accountId, (list) => list.filter((one) => one.id !== target.computer.id));
      return { ok: true, reload: false };
    }
    return { ok: false, reload: false };
  }, [activeId, platform, refreshConnections, updateComputers]);
  const owing = remote?.clouds.find((cloud) => cloud.payment);
  return { places, expected: remembered || connections.length, open, rename, remove, payment: owing?.payment ? { name: owing.name, ...owing.payment } : null };
}
