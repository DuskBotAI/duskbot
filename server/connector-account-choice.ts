// Which connected account each app uses when it has more than one: a default per app, and a bot's own pick over it,
// kept in the person's own data folder beside config.json.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { DATA_DIR } from "./config.ts";
import { ACCOUNT_ID, picks } from "./connector-account-pick.ts";
import { PASS, type RouteHandler } from "./routes/table.ts";

const BOT_ID = /^[\w-]{1,80}$/;
const MAX_ENTRIES = 500;

const choicesSchema = z.object({ defaults: picks.default({}), bots: z.record(z.string().regex(BOT_ID), picks).default({}) });
export type AccountChoices = z.infer<typeof choicesSchema>;

const file = (dir: string) => join(dir, "connector-accounts.json");

export function readAccountChoices(dir = DATA_DIR): AccountChoices {
  try {
    const parsed = choicesSchema.safeParse(JSON.parse(readFileSync(file(dir), "utf8")));
    if (parsed.success) return parsed.data;
  } catch { /* none yet */ }
  return { defaults: {}, bots: {} };
}

const listeners = new Set<() => void>();
/** Settings sync hears when an app's default account changes. */
export function onAccountChoice(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function writeAccountChoices(choices: AccountChoices, dir: string): void {
  mkdirSync(dir, { recursive: true });
  const temporary = `${file(dir)}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(choices, null, 2), { mode: 0o600 });
  renameSync(temporary, file(dir));
  for (const listener of listeners) { try { listener(); } catch {} }
}

/** The account each app uses for one bot: its own pick, else the app's default. */
export function accountsForBot(botId: string, choices = readAccountChoices()): Record<string, string> {
  return { ...choices.defaults, ...choices.bots[botId] };
}

/** Sets (or with null clears) the default for an app, or one bot's pick for it. */
export function setAccountChoice(input: { slug: string; accountId: string | null; botId?: string | null }, dir = DATA_DIR): AccountChoices {
  const choices = readAccountChoices(dir);
  const target = input.botId ? (choices.bots[input.botId] ??= {}) : choices.defaults;
  if (input.accountId) target[input.slug] = input.accountId;
  else delete target[input.slug];
  if (input.botId && !Object.keys(choices.bots[input.botId]!).length) delete choices.bots[input.botId];
  writeAccountChoices(choices, dir);
  return choices;
}

/** A removed account is nobody's default or pick any more. */
export function forgetAccount(slug: string, accountId: string, dir = DATA_DIR): void {
  const choices = readAccountChoices(dir);
  let changed = false;
  for (const target of [choices.defaults, ...Object.values(choices.bots)]) {
    if (target[slug] === accountId) { delete target[slug]; changed = true; }
  }
  for (const [bot, own] of Object.entries(choices.bots)) if (!Object.keys(own).length) delete choices.bots[bot];
  if (changed) writeAccountChoices(choices, dir);
}

const entries = (choices: AccountChoices) => Object.keys(choices.defaults).length
  + Object.values(choices.bots).reduce((total, own) => total + Object.keys(own).length, 0);

const CHOICE = /^\/api\/connectors\/([a-z0-9_][a-z0-9_-]{0,80})\/account-choice$/;
const ACCOUNT = /^\/api\/connectors\/([\w-]+)\/accounts\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/;
const choiceBody = z.object({ accountId: z.string().regex(ACCOUNT_ID).nullable(), botId: z.string().regex(BOT_ID).nullable().optional() }).strict();

/** GET /api/connectors/account-choices: every default and pick. PUT …/<slug>/account-choice {accountId, botId?}: set one
 * (null clears it). Removing an account (the DELETE the main router answers) forgets it here first. */
export function createAccountChoiceRoutes(dir?: string): RouteHandler {
  return async ({ res, path, method, json, readBody, req }) => {
    if (path === "/api/connectors/account-choices" && method === "GET") return json(res, 200, readAccountChoices(dir));
    const removed = method === "DELETE" ? ACCOUNT.exec(path) : null;
    if (removed) { forgetAccount(removed[1]!.toLowerCase(), removed[2]!, dir); return PASS; }
    const m = CHOICE.exec(path);
    if (!m || method !== "PUT") return PASS;
    const parsed = choiceBody.safeParse(await readBody(req));
    if (!parsed.success) return json(res, 400, { error: "accountId must be an account id or null; botId a bot id" });
    if (parsed.data.accountId && entries(readAccountChoices(dir)) >= MAX_ENTRIES) return json(res, 409, { error: "Too many account choices" });
    return json(res, 200, setAccountChoice({ slug: m[1]!, accountId: parsed.data.accountId, botId: parsed.data.botId ?? null }, dir));
  };
}
