import type { TurnActivityAttributes, TurnActivityState } from "../../../shared/phone-activity.ts";

export interface RelayPushMessage { id: string; kind: string; botId: string; botName: string; threadId: string; environmentId?: string; deviceId?: string; groupId?: string; requestId?: string }
export interface RelayActivityPush {
  event: "update" | "end" | "start";
  state: Omit<TurnActivityState, "line">;
  timestamp: number;
  priority: 5 | 10;
  dismissAt?: number;
  attributes?: TurnActivityAttributes;
}

export function pushMessage(value: unknown): RelayPushMessage | null;
export function pushCategory(push: { kind: string; requestId?: string; groupId?: string }): string | undefined;
export function activityMessage(value: unknown): RelayActivityPush | null;
export function activityBody(push: RelayActivityPush): object;
export function createPushRelay(options?: Record<string, unknown>): { services: string[]; route(...args: unknown[]): Promise<unknown> };
