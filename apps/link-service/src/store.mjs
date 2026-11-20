// sessions, tunnels and channels, kept in memory and written to one json file so a restart mid-setup loses
// nothing. only verifiers (sha256 of tokens) are stored, never a token, and never anything the app and vps seal.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SESSION_CLAIM_MS = 30 * 60_000;
export const SESSION_LIFE_MS = 2 * 60 * 60_000;
/** a finished session is kept this long so the app can still read how it ended */
export const SESSION_KEEP_MS = 15 * 60_000;
export const MAX_EVENTS = 400;
export const MAX_SESSIONS = 5000;
export const MAX_TUNNELS = 20000;
export const MAX_CHANNELS_PER_TUNNEL = 32;
/** a tunnel whose server has not polled for this long is dropped, so dead links cannot fill MAX_TUNNELS for good */
export const TUNNEL_IDLE_MS = 7 * 24 * 60 * 60_000;
/**
 * a tunnel that carries paired phones' channels waits a year for its server: a phone reads its channel's 404 as "this
 * phone was removed" and unpairs (shipped apps cannot be changed), and a paired phone's session lasts until it is
 * removed, so a computer that is off for months must still find its phones when it is back.
 */
export const PHONE_TUNNEL_IDLE_MS = 400 * 24 * 60 * 60_000;

/**
 * @param {{ dir?: string | null, now?: () => number, onChannelDelete?: (channel: any) => void, onTunnelDelete?: (tunnel: any) => void, mayExpire?: (tunnel: any) => boolean }} options
 * `mayExpire`: whether this node drops an idle tunnel (with several nodes, only its home does; the others never see it poll)
 */
export function createStore({ dir = null, now = Date.now, onChannelDelete = () => {}, onTunnelDelete = () => {}, mayExpire = () => true } = {}) {
  /** @type {Map<string, any>} */
  const sessions = new Map();
  /** @type {Map<string, any>} */
  const tunnels = new Map();
  const channels = new Map();
  const file = dir ? join(dir, "state.json") : null;
  if (file) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      for (const session of saved.sessions ?? []) if (typeof session?.id === "string") sessions.set(session.id, session);
      for (const tunnel of saved.tunnels ?? []) if (typeof tunnel?.id === "string") tunnels.set(tunnel.id, tunnel);
      for (const channel of saved.channels ?? []) if (typeof channel?.id === "string") channels.set(channel.id, channel);
    } catch (error) {
      if (error?.code !== "ENOENT") console.error(`link: state file unreadable, starting empty (${error?.message ?? error})`);
    }
  }
  let timer = null;
  function flush() {
    timer = null;
    if (!file) return;
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, sessions: [...sessions.values()], tunnels: [...tunnels.values()], channels: [...channels.values()] }), { mode: 0o600 });
    renameSync(tmp, file);
  }
  const save = () => {
    if (!file || timer) return;
    timer = setTimeout(() => { try { flush(); } catch (error) { console.error(`link: could not save state (${error?.message ?? error})`); } }, 150);
    timer.unref?.();
  };

  /** the state a session is in right now, expiry included */
  function stateOf(session) {
    if (session.state === "linked" || session.state === "cancelled") return session.state;
    const t = now();
    if (t > session.createdAt + SESSION_LIFE_MS) return "expired";
    if (session.state === "waiting" && t > session.createdAt + SESSION_CLAIM_MS) return "expired";
    return session.state;
  }

  function sweep() {
    const t = now();
    let changed = false;
    for (const [id, session] of sessions) {
      const state = stateOf(session);
      const endedAt = session.endedAt ?? (state === "expired" ? session.createdAt + (session.state === "waiting" ? SESSION_CLAIM_MS : SESSION_LIFE_MS) : null);
      if (endedAt !== null && t > endedAt + SESSION_KEEP_MS) { sessions.delete(id); changed = true; }
    }
    const phones = new Set();
    for (const channel of channels.values()) if (channel.kind === "device") phones.add(channel.tunnel);
    for (const [id, tunnel] of tunnels) {
      const idle = phones.has(id) ? PHONE_TUNNEL_IDLE_MS : TUNNEL_IDLE_MS;
      if (t - (tunnel.seenAt ?? tunnel.createdAt ?? 0) > idle && mayExpire(tunnel)) { tunnels.delete(id); onTunnelDelete(tunnel); changed = true; }
    }
    for (const [id, channel] of channels) {
      if ((channel.expiresAt != null && channel.expiresAt <= t) || !tunnels.has(channel.tunnel)) {
        channels.delete(id);
        onChannelDelete(channel);
        changed = true;
      }
    }
    if (changed) save();
  }

  return {
    sessions, tunnels, channels, stateOf, sweep, save,
    flush: () => { if (timer) clearTimeout(timer); flush(); },
    close: () => { if (timer) { clearTimeout(timer); flush(); } },
  };
}
