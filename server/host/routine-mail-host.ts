// A bot's mail address wired to this server: which automation a route may name, how a message runs it (a routine
// through its own address), what goes when a bot or an automation does, and the bot's trigger action=email route.
import { join } from "node:path";

import { createBotMail, type BotMail } from "../bot-mail.ts";
import type { RoutineManager } from "../routines.ts";
import { routineAddress } from "../webhook-address.ts";
import type { WebhookManager } from "../webhooks.ts";

export interface RoutineMailHostDeps {
  dataDir: string;
  store: { bot(id: string): { name: string } | null | undefined; onChange(listener: (change: { type: string; botId?: string }) => void): unknown };
  routines(): Pick<RoutineManager, "listRoutines"> | null | undefined;
  webhooks: WebhookManager;
  hooksBase(): string;
  arrived(): void;
  env?: NodeJS.ProcessEnv;
}

export function createRoutineMailHost(deps: RoutineMailHostDeps) {
  const env = deps.env ?? process.env;
  const target = (botId: string, id: string): { ok: true; name: string; routine: boolean } | { ok: false; error: string } => {
    const routine = deps.routines()?.listRoutines().find((one) => one.id === id && one.botId === botId);
    if (routine) return { ok: true, name: routine.name, routine: true };
    const hook = deps.webhooks.list().find((one) => one.id === id && one.botId === botId && !one.routineId && one.delivery !== "post");
    return hook ? { ok: true, name: hook.name, routine: false } : { ok: false, error: "No routine or webhook automation with that id belongs to this bot. Use a trigger_id from trigger_info." };
  };
  const botMail: BotMail = createBotMail({
    file: join(deps.dataDir, "bot-mail.json"),
    hooksBase: deps.hooksBase,
    edge: { url: env.DUSK_MAIL_EDGE_URL?.trim() || "https://in.dusk.bot", domain: env.DUSK_MAIL_DOMAIN?.trim() || "in.dusk.bot" },
    bot: (id) => deps.store.bot(id) ?? null,
    target,
    deliver: (botId, targetId, event) => {
      const found = target(botId, targetId);
      if (!found.ok) throw Object.assign(new Error(found.error), { status: 410 });
      deps.webhooks.receiveTrusted(found.routine ? routineAddress(deps.webhooks, targetId, botId, found.name) : targetId, event);
    },
    arrived: deps.arrived,
    log: (line) => console.warn(line),
  });
  deps.store.onChange((change) => { if (change.type === "bot.deleted" && change.botId) void botMail.removeForBot(change.botId); });

  return {
    botMail,
    /** Starts registering mailboxes, and retries the ones that could not be reached every 10 minutes. */
    start(): void {
      void botMail.sync();
      setInterval(() => void botMail.sync(), 10 * 60_000).unref();
    },
    routineDeleted(routineId: string): void {
      const linked = deps.webhooks.forRoutine(routineId);
      if (linked) deps.webhooks.remove(linked.id);
      botMail.forgetTarget(routineId);
    },
    webhookDeleted(webhookId: string): void {
      botMail.forgetTarget(webhookId);
    },
    /** trigger action=email: GET shows (and first makes) the bot's address, POST sets one route. Only the person's own
     *  conversation may, never a guest's turn or one an outside event drove. */
    async internal(input: { method: string; botId: string; refused: boolean; body(): Promise<unknown> }): Promise<{ status: number; body: unknown }> {
      if (input.refused) return { status: 403, body: { error: "Only the person's own conversation sets up the bot's mail address. Tell them to ask there." } };
      if (input.method === "GET") return { status: 200, body: botMail.open(input.botId) };
      if (input.method !== "POST") return { status: 405, body: { error: "GET or POST" } };
      const body = await input.body() as { alias?: unknown; triggerId?: unknown; from?: unknown } | null;
      if (!body || typeof body.triggerId !== "string" || !Array.isArray(body.from)) return { status: 400, body: { error: "email needs trigger_id and email_from (a list; empty removes the route)" } };
      try {
        return { status: 200, body: await botMail.setRoute(input.botId, { alias: typeof body.alias === "string" ? body.alias : "", targetId: body.triggerId, from: body.from }) };
      } catch (error) {
        return { status: (error as { status?: number }).status ?? 400, body: { error: error instanceof Error ? error.message : String(error) } };
      }
    },
  };
}
