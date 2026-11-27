import { rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BOT_SHARING_ENABLED, widensAccess } from "../shared/bot-sharing.ts";
import type { WireBot } from "../shared/wire.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import type { RequestAuth } from "./request-auth.ts";
import { createBotAccessRoutes } from "./routes/bot-access.ts";
import { createTeamRoutes, type TeamRouteDeps } from "./routes/teams.ts";
import { PASS, type RouteContext } from "./routes/table.ts";
import { Store, type BotRecord } from "./store.ts";

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const BOB = "bob@acme.test";

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
afterEach(() => { delete process.env.DUSK_BOT_SHARING; });

describe("the bot sharing flag", () => {
  it("ships off", () => {
    expect(BOT_SHARING_ENABLED).toBe(false);
  });

  it("counts a wider audience as sharing and taking access away as not", () => {
    const none = { everyone: "none" as const, people: {} };
    expect(widensAccess(none, { everyone: "chat", people: {} })).toBe(true);
    expect(widensAccess(none, { everyone: "none", people: { [BOB]: "view" } })).toBe(true);
    expect(widensAccess({ everyone: "none", people: { [BOB]: "view" } }, { everyone: "none", people: { [BOB]: "edit" } })).toBe(true);
    expect(widensAccess({ everyone: "chat", people: { [BOB]: "edit" } }, { everyone: "view", people: {} })).toBe(false);
    expect(widensAccess(none, none)).toBe(false);
  });
});

function call(handler: (ctx: RouteContext) => Promise<unknown> | unknown, method: string, path: string, body: unknown) {
  const sent: Array<{ status: number; body: any }> = [];
  const ctx = {
    req: { headers: {} } as unknown as IncomingMessage,
    res: {} as ServerResponse,
    url: new URL(`http://localhost${path}`),
    path,
    method,
    auth: { kind: "loopback", scopes: ["admin"] } as RequestAuth,
    json: ((_res: ServerResponse, status: number, response: unknown) => { sent.push({ status, body: response }); }) as RouteContext["json"],
    readBody: (async () => body) as RouteContext["readBody"],
  } as RouteContext;
  return Promise.resolve(handler(ctx)).then((out) => { expect(out).not.toBe(PASS); expect(sent).toHaveLength(1); return sent[0]!; });
}

describe("PUT /api/bots/:id/access with sharing off", () => {
  const fixture = () => {
    const store = new Store(() => sonnet);
    const bot = store.createBot({ name: "Payroll" });
    store.patchBot(bot.id, { access: { everyone: "none", people: { [BOB]: "chat" } }, visibility: { people: [BOB] } });
    const handler = createBotAccessRoutes({
      team: {} as never, people: { has: () => true }, store, levelOf: () => "edit",
      wireBot: (record: BotRecord) => record as unknown as WireBot,
      publicGroupState: () => ({}), broadcast: () => {}, audienceChanged: () => {},
    });
    return { store, bot, put: (body: unknown) => call(handler, "PUT", `/api/bots/${bot.id}/access`, body) };
  };

  it("refuses to add a person or open the bot to everyone, and leaves the sharing as it was", async () => {
    const { store, bot, put } = fixture();
    for (const next of [
      { everyone: "none", people: { [BOB]: "chat", "cara@acme.test": "view" } },
      { everyone: "chat", people: { [BOB]: "chat" } },
      { everyone: "none", people: { [BOB]: "edit" } },
    ]) {
      const refused = await put(next);
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe("bot_sharing_off");
    }
    expect(store.bot(bot.id)!.access).toEqual({ everyone: "none", people: { [BOB]: "chat" } });
  });

  it("still lets someone be taken off, so nobody is stuck in a share", async () => {
    const { store, bot, put } = fixture();
    const removed = await put({ everyone: "none", people: {} });
    expect(removed.status).toBe(200);
    expect(store.bot(bot.id)!.access).toEqual({ everyone: "none", people: {} });
  });

  it("shares again when the flag is turned on", async () => {
    process.env.DUSK_BOT_SHARING = "on";
    const { put } = fixture();
    expect((await put({ everyone: "none", people: { [BOB]: "chat", "cara@acme.test": "view" } })).status).toBe(200);
  });
});

describe("POST /api/teams/export with sharing off", () => {
  const handler = () => createTeamRoutes({
    store: new Store(() => sonnet), routines: () => null, orgLibrary: () => null, authorName: () => "Ada",
  } as unknown as TeamRouteDeps);
  const preset = { format: "package", version: 2, kind: "library", presetName: "Support agent", dryRun: true };

  it("refuses a preset share, preview included", async () => {
    const refused = await call(handler(), "POST", "/api/teams/export", preset);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("bot_sharing_off");
  });
});
