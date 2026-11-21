// What server/index.ts needs from the Slack bots feature, in one object so the host file gains next to nothing: the owner
// routes, the slack_* tools' internal route, whether a bot's tools are listed, log redaction, and the background work
// (config token rotation, one Socket Mode connection per linked bot, the bridge into the bot's conversations).
// Security: every token stays in this process and the encrypted store; engines only ever hold a turn's capability.
import type { SavedSecretsKey } from "../saved-secrets.ts";
import type { Message } from "../store.ts";
import { HELD_SECRET_MASK } from "../redact.ts";
import { createSlackRoutes } from "../routes/slack.ts";
import { SLACK_WIRE_VERSION, slackAppTokenUrl, type SlackBotStatus, type SlackWorkspaceStatus } from "../../shared/slack.ts";
import { createSlackApi, slackRedirectUrl, SlackApiError } from "./api.ts";
import { createSlackBridge, type SlackBridgeDeps } from "./bridge.ts";
import { createConfigTokens } from "./config-token.ts";
import { createSlackProvisioner } from "./provision.ts";
import { readSlackAttachment, saveSlackAttachment, slackBotIcon } from "./attachments.ts";
import { SlackSecretStore, type SlackBotRecord } from "./secrets.ts";
import { createSlackSockets, type SlackSocketState } from "./socket.ts";
import { createSlackToolRoutes } from "./tools.ts";
import { createSlackHandover } from "./handover.ts";

export interface SlackHostBot { id: string; name: string; description?: string; color?: string; avatarUrl?: string }

export interface SlackHostDeps extends Pick<SlackBridgeDeps, "createThread" | "threadExists" | "send" | "react"> {
  dataDir: string;
  key: SavedSecretsKey;
  bot(botId: string): SlackHostBot | null;
  messages(threadId: string): readonly Message[];
  onStoreChange(listener: (change: { type: string; botId?: string; threadId?: string }) => void): () => void;
  /** Slack text read into a conversation makes it outside work. */
  markOutside(threadId: string): void;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

const UPDATE_DEBOUNCE_MS = 3_000;
const ONLINE_WAIT_MS = 5_000;

export function createSlackHost(deps: SlackHostDeps) {
  const log = deps.log ?? ((line: string) => console.warn(`Slack: ${line}`));
  const api = createSlackApi({ env: deps.env ?? process.env });
  const store = new SlackSecretStore({ dataDir: deps.dataDir, key: deps.key });
  const tokens = createConfigTokens({ store, api, log });
  const provisioner = createSlackProvisioner({ store, api, tokens, redirectUrl: slackRedirectUrl(deps.env ?? process.env), icon: async (botId) => slackBotIcon(deps.bot(botId)?.avatarUrl), log });
  const socketStates = new Map<string, { state: SlackSocketState; error?: string }>();
  const record = (botId: string): SlackBotRecord | null => (store.ready() ? store.bot(botId) : null);
  const link = (botId: string) => {
    const one = record(botId);
    return one?.botToken && one.botUserId ? { botToken: one.botToken, botUserId: one.botUserId, teamId: one.teamId, appId: one.appId, ...(one.handle ? { handle: one.handle } : {}) } : null;
  };

  const bridge = createSlackBridge({
    dataDir: deps.dataDir, api, link, log,
    bot: (botId) => deps.bot(botId),
    createThread: deps.createThread, threadExists: deps.threadExists, send: deps.send, messages: deps.messages,
    onChange: deps.onStoreChange, react: deps.react, saveAttachment: saveSlackAttachment, readAttachment: readSlackAttachment,
  });
  const sockets = createSlackSockets((botId) => ({
    api, log,
    appToken: () => record(botId)?.appToken ?? null,
    onEvent: (payload) => bridge.handleEvent(botId, payload),
    onState: (state, error) => { socketStates.set(botId, { state, ...(error ? { error } : {}) }); },
  }));
  const tools = createSlackToolRoutes({ api, link, markOutside: deps.markOutside, log });
  // a sleeping cloud desktop's hosted wake edge hands back what came in while it slept (opt-in, see handover.ts)
  const handover = createSlackHandover({ dataDir: deps.dataDir, env: deps.env ?? process.env, log,
    bots: () => (store.ready() ? store.bots() : []).flatMap((one) => one.botToken && one.appToken && one.botUserId ? [{ botId: one.botId, appId: one.appId, botUserId: one.botUserId, appToken: one.appToken }] : []),
    deliver: (botId, payload) => bridge.handleEvent(botId, payload) });

  function botStatus(botId: string): SlackBotStatus {
    const one = record(botId);
    if (!one) return { version: SLACK_WIRE_VERSION, botId, state: "not_linked" };
    const socket = socketStates.get(botId);
    const state = !one.botToken ? "provisioned" : !one.appToken ? "installed"
      : one.error || socket?.state === "error" ? "error" : socket?.state === "online" ? "online" : "offline";
    const error = one.error ?? (socket?.state === "error" ? socket.error : undefined);
    return {
      version: SLACK_WIRE_VERSION, botId, state, appId: one.appId, teamId: one.teamId,
      ...(one.teamName ? { teamName: one.teamName } : {}), ...(one.botUserId ? { botUserId: one.botUserId } : {}),
      ...(one.handle ? { handle: one.handle } : {}), ...(state === "error" && error ? { error } : {}),
      appTokenUrl: slackAppTokenUrl(one.appId),
      ...(one.botToken ? { openUrl: `https://slack.com/app_redirect?app=${encodeURIComponent(one.appId)}&team=${encodeURIComponent(one.teamId)}` } : {}),
    };
  }

  function workspace(): SlackWorkspaceStatus {
    if (!store.ready()) return { version: SLACK_WIRE_VERSION, state: "not_connected", apps: 0, ready: false };
    return tokens.status(store.bots().length);
  }

  /** The socket is (re)started with the stored token, and the answer waits briefly for Slack's hello. */
  async function connectSocket(botId: string): Promise<void> {
    sockets.stop(botId);
    socketStates.delete(botId);
    sockets.ensure(botId);
    const deadline = Date.now() + ONLINE_WAIT_MS;
    while (Date.now() < deadline) {
      const state = socketStates.get(botId)?.state;
      if (state === "online" || state === "error") return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  function requireBot(botId: string): SlackHostBot {
    const bot = deps.bot(botId);
    if (!bot) throw new SlackApiError("bot_not_found");
    return bot;
  }

  const routes = createSlackRoutes({
    workspace,
    connect: async (accessToken, refreshToken) => { await tokens.connect(accessToken, refreshToken); tokens.start(); return workspace(); },
    disconnect: () => { tokens.disconnect(); return workspace(); },
    bot: (botId) => deps.bot(botId),
    botStatus,
    provision: async (botId) => {
      const { authorizeUrl } = await provisioner.provision(requireBot(botId));
      return { status: botStatus(botId), authorizeUrl };
    },
    exchange: async (code, state) => {
      const one = await provisioner.exchange(code, state);
      if (one.appToken) await connectSocket(one.botId);
      return botStatus(one.botId);
    },
    setAppToken: async (botId, token) => {
      requireBot(botId);
      await provisioner.setAppToken(botId, token);
      await connectSocket(botId);
      void handover.sync();
      return botStatus(botId);
    },
    remove: async (botId) => {
      sockets.stop(botId);
      socketStates.delete(botId);
      bridge.forgetBot(botId);
      await provisioner.remove(botId);
      return botStatus(botId);
    },
    log,
  });

  const updates = new Map<string, ReturnType<typeof setTimeout>>();
  const stopWatching = deps.onStoreChange((change) => {
    if (!store.ready() || !change.botId && !change.threadId) return;
    if (change.type === "thread.deleted" && change.threadId) bridge.forgetThread(change.threadId);
    if (!change.botId || !store.bot(change.botId)) return;
    const botId = change.botId;
    if (change.type === "bot.deleted") {
      sockets.stop(botId);
      socketStates.delete(botId);
      bridge.forgetBot(botId);
      void provisioner.remove(botId);
      return;
    }
    if (change.type !== "bot") return;
    clearTimeout(updates.get(botId));
    updates.set(botId, setTimeout(() => {
      updates.delete(botId);
      const bot = deps.bot(botId);
      if (bot) void provisioner.update(bot);
    }, UPDATE_DEBOUNCE_MS).unref());
  });

  let started = false;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  let stopReadyWait: (() => void) | null = null;
  function begin(): void {
    if (!store.ready()) {
      if (deps.key.onReady) {
        if (!stopReadyWait) {
          stopReadyWait = deps.key.onReady(() => {
            stopReadyWait = null;
            if (started && store.ready()) begin();
          });
        }
        return;
      }
      readyTimer = setTimeout(begin, 2_000).unref();
      return;
    }
    readyTimer = null;
    stopReadyWait?.();
    stopReadyWait = null;
    tokens.start();
    for (const one of store.bots()) if (one.botToken && one.appToken) sockets.ensure(one.botId);
    handover.start();
  }

  return {
    routes,
    /** The slack_* tools' calls, inside index.ts's internal block (the bot and conversation come from the capability). */
    internal: tools,
    /** The bot holds its own Slack app with a bot token: its slack_* tools are listed. */
    linked: (botId: string) => link(botId) !== null,
    scrub(text: string): string {
      if (!text || !store.ready()) return text;
      let out = text;
      for (const value of store.secretValues()) if (value.length >= 12 && out.includes(value)) out = out.replaceAll(value, HELD_SECRET_MASK);
      return out;
    },
    start(): void {
      if (started) return;
      started = true;
      begin();
    },
    stop(): void {
      started = false;
      if (readyTimer) clearTimeout(readyTimer);
      stopReadyWait?.();
      stopReadyWait = null;
      for (const timer of updates.values()) clearTimeout(timer);
      updates.clear();
      stopWatching();
      handover.stop();
      sockets.stopAll();
      tokens.stop();
      bridge.stop();
    },
    botStatus,
  };
}
