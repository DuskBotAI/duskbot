export declare const PHONE_RELAY_BASE: string;

export interface PhoneRelayTunnel { base: string; id: string; token: string }
export interface PhoneRelayState { status: "off" | "signed-out" | "starting" | "ready" | "error"; code?: string; message?: string }

/** Makes a tunnel for this place's phones with an account's link grant. */
export declare function createRelayTunnel(options: { base: string; grant: string; label?: string; fetch?: typeof fetch }): Promise<PhoneRelayTunnel>;

/** Keeps a phone hub on its own tunnel running while `wanted()`. */
export declare function createPhoneRelay(deps: {
  base: string;
  wanted(): boolean;
  signedIn(): boolean;
  linkGrant(): Promise<string | null>;
  label(): string;
  store: { read(at: string): Promise<unknown>; write(at: string, value: unknown): Promise<void> };
  loadHub(): Promise<unknown>;
  port(): number;
  ownerToken(): string;
  /** the hub's channel sync, when it runs in the harness's own process */
  sync?: (input: Record<string, unknown>) => Promise<unknown>;
  scope?(): string;
  proxy?: unknown;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  checkMs?: number;
  retryMs?: number[];
  now?: () => number;
}): {
  start(): void;
  stop(): void;
  state(): PhoneRelayState;
  wake(): void;
  ready(timeoutMs?: number): Promise<PhoneRelayState>;
  settled(): Promise<unknown>;
};
