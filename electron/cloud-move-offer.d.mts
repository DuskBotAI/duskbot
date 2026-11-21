export type CloudMoveOfferStage = "none" | "prompt" | "banner" | "settings";
export type CloudMoveOfferSource = "prompt" | "banner" | "settings" | "two_places";
/** Which ask shows, and how many bots this computer would carry. */
export interface CloudMoveOfferState { stage: CloudMoveOfferStage; bots: number }
type Saved = { v: 1; key: string; stays?: number; accepted?: { at: number; from: CloudMoveOfferSource }; prompt?: number; banner?: number;
  reported?: { move: number; started: boolean; done: boolean; failed: string[] } };
type OfferCloud = { origin: string | null; account: string; ready: boolean; moves: boolean; ended: boolean };

export declare const OFFER_STAGES: readonly CloudMoveOfferStage[];
export declare const OFFER_SOURCES: readonly CloudMoveOfferSource[];
export declare const LOOK_MS: number;
export function offerKey(cloud: { account: string; origin: string | null }): string;
export function movable(summary: unknown): { bots: number; something: boolean };
export function parseOffer(value: unknown, key: string): Saved;
export function offerStage(input: { cloud: OfferCloud | null; journal: unknown; keep?: boolean; own?: boolean; local: { bots: number; something: boolean } | null; saved: Saved | null }): CloudMoveOfferStage;
export function createCloudMoveOffer(deps: {
  store: { read(): unknown; write(value: unknown): void };
  cloud(): OfferCloud | null;
  journal(): unknown;
  keep: { on(): boolean; set(on: boolean): Promise<unknown> };
  own?(): boolean;
  summary(): Promise<unknown>;
  kick(): unknown;
  onChange?(): void;
  track?(name: string, props: Record<string, string | number | boolean>): void;
  now?(): number;
  log?(line: string): void;
}): CloudMoveOffer;
export interface CloudMoveOffer {
  state(): CloudMoveOfferState;
  refresh(options?: { force?: boolean }): Promise<void>;
  consent(): boolean;
  stay(): void;
  accepted(): boolean;
  accept(from: string): Promise<CloudMoveOfferState>;
  dismiss(which: string): CloudMoveOfferState;
  observe(): void;
  away(): boolean;
}
