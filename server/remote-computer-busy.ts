export const DEFAULT_REMOTE_COMPUTER_BUSY_TTL_MS = 180_000;

export interface RemoteComputerBusyTracker {
  has(ownerId: string): boolean;
  add(ownerId: string, ttlMs?: number): this;
  delete(ownerId: string): boolean;
  clear(): void;
  readonly size: number;
}

export function createRemoteComputerBusyTracker(options: {
  ttlMs?: number;
  now?: () => number;
} = {}): RemoteComputerBusyTracker {
  const ttlMs = options.ttlMs ?? DEFAULT_REMOTE_COMPUTER_BUSY_TTL_MS;
  const now = options.now ?? Date.now;
  const entries = new Map<string, number>();

  const sweep = () => {
    const current = now();
    for (const [ownerId, expiresAt] of entries) {
      if (current >= expiresAt) entries.delete(ownerId);
    }
  };

  const tracker: RemoteComputerBusyTracker = {
    has(ownerId: string): boolean {
      const expiresAt = entries.get(ownerId);
      if (expiresAt === undefined) return false;
      if (now() >= expiresAt) {
        entries.delete(ownerId);
        return false;
      }
      return true;
    },
    add(ownerId: string, customTtlMs?: number) {
      entries.set(ownerId, now() + (customTtlMs ?? ttlMs));
      return tracker;
    },
    delete(ownerId: string): boolean {
      return entries.delete(ownerId);
    },
    clear(): void {
      entries.clear();
    },
    get size(): number {
      sweep();
      return entries.size;
    },
  };

  return tracker;
}
