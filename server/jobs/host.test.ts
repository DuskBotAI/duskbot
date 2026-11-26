import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { cpuTimeMs, JOB_MESSAGES, jobTurnRefusal } from "./host.ts";
import { envNameRefusal } from "./launch.ts";
import { apiBase, messagesOf, wanted } from "./telegram-watch.ts";
import { jobsFixture, PERSON_TURN } from "./testing.ts";

const fixtures: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });

// background jobs refuse Windows by design (server/jobs/launch.ts), so they run where jobs can
describe.skipIf(process.platform === "win32")("background jobs host", () => {
  it("a job's dusk-notify becomes a run of the bot through the event path, and --tell a line in its chat", async () => {
    const fixture = await jobsFixture({ secrets: { "Deals token": "tok-123456789" } });
    fixtures.push(fixture);
    writeFileSync(join(fixture.workspace, "watch.sh"), 'echo "token is $DEALS_TOKEN"\ndusk-notify "deal with Acme moved to contract"\ndusk-notify --tell "watching the deals group now"\nsleep 30\n');
    const started = await fixture.call({ action: "start", label: "Deal watch", command: "sh watch.sh", secrets: { DEALS_TOKEN: "Deals token" }, on_notify: "Tell Ana only when a deal moves forward." });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(String(started.body.text)).toContain("keeps running after this turn");
    await expect.poll(() => fixture.runs.length, { timeout: 10_000 }).toBe(1);
    expect(fixture.runs[0]).toMatchObject({ webhookId: `job:${started.body.id}`, webhookName: "Deal watch", botId: "bot-a", eventSource: "job", resultsThreadId: "t-1" });
    expect(fixture.runs[0]!.prompt).toContain("Tell Ana only when a deal moves forward.");
    expect(fixture.runs[0]!.prompt).toContain("[UNTRUSTED APP EVENT DATA]");
    expect(fixture.runs[0]!.prompt).toContain("deal with Acme moved to contract");
    await expect.poll(() => fixture.lines).toEqual([{ threadId: "t-1", text: "watching the deals group now" }]);
    const logs = await fixture.call({ action: "logs", id: started.body.id });
    expect(String(logs.body.text)).toContain("token is [secret]");
    expect(String((await fixture.call({ action: "list" })).body.text)).toContain("Deal watch");
    expect((await fixture.call({ action: "stop", id: started.body.id })).status).toBe(200);
    expect(fixture.host.busy()).toBe(false);
  }, 30_000);

  it("starts in a new bot's own folder before anything was written there", async () => {
    const fixture = await jobsFixture();
    fixtures.push(fixture);
    rmSync(fixture.workspace, { recursive: true, force: true });
    const started = await fixture.call({ action: "start", label: "Fresh", command: "sleep 30" });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    // started at once in this turn, so the person's Stop on the chat stops it too
    expect(fixture.startedIds).toEqual([started.body.id]);
    expect(existsSync(fixture.workspace)).toBe(true);
    expect((await fixture.call({ action: "stop", id: started.body.id })).status).toBe(200);
  }, 30_000);

  it("refuses what a turn may not do, a secret not in the Vault, a folder outside the bot's, and dusk bot's own names", async () => {
    const fixture = await jobsFixture();
    fixtures.push(fixture);
    expect(await fixture.call({ action: "start", label: "x", command: "true" }, { ...PERSON_TURN, outsideDriven: true })).toEqual({ status: 403, body: { error: JOB_MESSAGES.notPerson } });
    expect((await fixture.call({ action: "start", label: "x", command: "true", secrets: { T: "Missing" } })).body.error).toContain("not in the person's Vault");
    expect((await fixture.call({ action: "start", label: "x", command: "true", cwd: "/etc" })).body.error).toContain("cwd must be inside");
    expect((await fixture.call({ action: "start", label: "x", command: "true", env: { DUSK_JOB_TOKEN: "x" } })).body.error).toContain("set by dusk bot");
    expect((await fixture.call({ action: "start", label: "x", template: "telegram_watch" })).body.error).toContain("needs secret");
    expect((await fixture.call({ action: "list" }, { ...PERSON_TURN, outsideDriven: true })).status).toBe(200);
    expect(jobTurnRefusal({ ...PERSON_TURN, personStarted: false, routineRun: true }, "stop")).toBeNull();
    expect(jobTurnRefusal({ ...PERSON_TURN, guest: true }, "start")).toBe(JOB_MESSAGES.guest);
    expect(jobTurnRefusal({ ...PERSON_TURN, room: true }, "start")).toBe(JOB_MESSAGES.room);
    expect(await fixture.call({ action: "logs", id: "any" }, { ...PERSON_TURN, guest: true })).toEqual({ status: 403, body: { error: JOB_MESSAGES.guest } });
    expect((await fixture.call({ action: "list" }, { ...PERSON_TURN, room: true })).status).toBe(403);
    expect(envNameRefusal("PATH")).toContain("set by dusk bot");
    expect(envNameRefusal("TELEGRAM_BOT_TOKEN")).toBeNull();
  });

  it("at Ask before every action a start waits on one card: Allow starts it, Deny doesn't", async () => {
    const fixture = await jobsFixture();
    fixtures.push(fixture);
    const asked = await fixture.call({ action: "start", label: "Deal watch", command: "sleep 30" }, { ...PERSON_TURN, asksFirst: true });
    expect(asked.status).toBe(202);
    expect(asked.body.text).toContain(JOB_MESSAGES.asked);
    expect(fixture.host.supervisor.list()).toEqual([]);
    expect(fixture.cards).toMatchObject([{ threadId: "t-1", card: { title: "Keep running Deal watch in the background", options: ["Allow", "Deny"], tool: "background_job", requestId: asked.body.requestId } }]);
    expect(fixture.host.ownCards("someone-else", "allow")).toBe(false);
    expect(fixture.host.ownCards(String(asked.body.requestId), "allow")).toBe(true);
    expect(fixture.host.supervisor.list()).toMatchObject([{ label: "Deal watch", state: "running" }]);
    expect(fixture.cards[0]!.card.answered).toBe("allow");
    expect(fixture.lines.at(-1)!.text).toContain("Started Deal watch");
    // the person set it up on the card, so a Stop on the chat never ends it
    expect(fixture.startedIds).toEqual([]);
    expect(fixture.host.ownCards(String(asked.body.requestId), "allow")).toBe(false);

    const denied = await fixture.call({ action: "start", label: "Other", command: "sleep 30" }, { ...PERSON_TURN, asksFirst: true });
    expect(fixture.host.ownCards(String(denied.body.requestId), "deny")).toBe(true);
    expect(fixture.host.supervisor.list().map((job) => job.label)).toEqual(["Deal watch"]);
    expect(fixture.cards[1]!.card.answered).toBe("deny");
  });

  it("reads ps times", () => {
    expect(cpuTimeMs("0:01.50")).toBe(1_500);
    expect(cpuTimeMs("01:02:03")).toBe(3_723_000);
    expect(cpuTimeMs("2-00:00:01")).toBe(172_801_000);
  });
});

describe("telegram_watch", () => {
  const updates = [
    { update_id: 1, message: { message_id: 42, date: 1_700_000_000, text: "Acme signed the LOI", chat: { id: -10, title: "Brand deals", type: "supergroup" }, from: { first_name: "Ana" } } },
    { update_id: 2, message: { date: 1_700_000_060, text: "lunch?", chat: { id: -11, title: "Friends", type: "group" }, from: { username: "bo" } } },
    { update_id: 3, channel_post: { date: 1_700_000_120, caption: "new rate card", chat: { id: -12, title: "Deals channel", type: "channel" }, sender_chat: { title: "Deals channel" } } },
    { update_id: 4, message: { date: 1_700_000_180, chat: { id: -10, title: "Brand deals", type: "supergroup" } } },
  ];
  it("reads group, channel and captioned messages and filters by chat and word", () => {
    const messages = messagesOf(updates as never);
    expect(messages.map((m) => [m.chat, m.from, m.text])).toEqual([["Brand deals", "Ana", "Acme signed the LOI"], ["Friends", "bo", "lunch?"], ["Deals channel", "Deals channel", "new rate card"]]);
    expect(messages.filter((m) => wanted(m, ["deals"], []))).toHaveLength(2);
    expect(messages.filter((m) => wanted(m, [], ["loi"]))).toHaveLength(1);
    expect(messages.filter((m) => wanted(m, ["-11"], []))).toHaveLength(1);
  });
  it("talks to a test Bot API only on loopback, Telegram otherwise", () => {
    expect(apiBase({ DUSK_TELEGRAM_API_URL: "http://127.0.0.1:9123" })).toBe("http://127.0.0.1:9123");
    expect(apiBase({ DUSK_TELEGRAM_API_URL: "http://evil.example:80" })).toBe("https://api.telegram.org");
    expect(apiBase({})).toBe("https://api.telegram.org");
  });
});
