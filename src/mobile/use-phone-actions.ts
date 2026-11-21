import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

import type { Action, AppState } from "@/state/store";
import { parseMobileOpenLink, type MobileConnectionRecord, type MobileOpenTarget } from "../../shared/mobile-link";
import type { createConnectionStore } from "./connection/connections";
import { phoneActionFrom, type PhoneAction } from "./phone-actions";
import type { MobilePlatform } from "./platform";

const review: PhoneAction = { kind: "open", target: { view: "notifications" } };

export function routePhoneAction(action: PhoneAction, places: MobileConnectionRecord[], current: string) {
  const { deviceId, environmentId } = action.target;
  if (!deviceId && !environmentId) {
    const unambiguous = places.length <= 1 && action.kind === "open";
    return { id: current, action: unambiguous ? action : review };
  }
  const matches = places.filter((place) => (!deviceId || place.deviceId === deviceId) && (!environmentId || place.environmentId === environmentId));
  if (matches.length !== 1 || (action.kind !== "open" && !deviceId)) return { id: current, action: review };
  return { id: matches[0]!.id, action };
}

type Delivery = { id: string; action: PhoneAction; take(): boolean };
export const PhoneActionDelivery = createContext<Delivery | null>(null);

export function usePhoneActionInbox(platform: MobilePlatform, store: ReturnType<typeof createConnectionStore>, current: string | null, retry: () => void) {
  const [queue, setQueue] = useState<PhoneAction[]>([]);
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const receive = useCallback((action: PhoneAction) => setQueue((pending) => [...pending, action]), []);
  useEffect(() => platform.onPhoneAction?.((raw) => {
    const action = phoneActionFrom(raw);
    if (action) receive(action);
  }), [platform, receive]);
  useEffect(() => platform.onNotificationOpen?.((target) => receive({ kind: "open", target })), [platform, receive]);
  useEffect(() => platform.onAppUrl?.((url) => {
    const target = parseMobileOpenLink(url);
    if (target) receive({ kind: "open", target });
    return Boolean(target);
  }), [platform, receive]);

  const head = queue[0];
  const consumed = useRef<PhoneAction | null>(null);
  useEffect(() => {
    if (!head || !current) return;
    let stopped = false;
    const deliver = (id: string, action: PhoneAction) => {
      if (stopped) return;
      setDelivery({ id, action, take() {
        if (stopped || consumed.current === head) return false;
        consumed.current = head;
        setQueue((pending) => pending.filter((one) => one !== head));
        setDelivery(null);
        return true;
      } });
    };
    void store.list().then(async (places) => {
      if (stopped) return;
      const target = routePhoneAction(head, places, current);
      if (target.id === current) deliver(current, target.action);
      else {
        await store.setActive(target.id);
        if (!stopped) retry();
      }
    }).catch(() => deliver(current, review));
    return () => { stopped = true; };
  }, [head, current, store, retry]);
  return delivery?.id === current ? delivery : null;
}

export function usePhoneActions(state: AppState, dispatch: (action: Action) => void, openTarget: (target: MobileOpenTarget) => void) {
  const delivery = useContext(PhoneActionDelivery);
  useEffect(() => {
    if (!state.hydrated || !state.connected || !delivery?.take()) return;
    const action = delivery.action;
    openTarget(action.target);
    const { threadId, botId } = action.target;
    if (!threadId) return;
    if (action.kind === "decide") dispatch({ type: "decideRequest", threadId, requestId: action.requestId, behavior: action.behavior });
    else if (action.kind === "reply" && botId) dispatch({ type: "send", botId, text: action.text, threadId });
  }, [state.hydrated, state.connected, delivery, dispatch, openTarget]);
}
