import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Notification } from "../../shared/notification.ts";
import type { DreamConversation } from "../memory-dream.ts";
import type { RequestAuth } from "../request-auth.ts";
import { parseInterests } from "./offer-interests.ts";
import { JUDGE_MARKER, SPOT_MARKER, type SearchResult } from "./offer-prompts.ts";
import { createOffers, OFFER_TIMING, type InterestsFile, type OffersDeps } from "./offers.ts";

const HOUR = 3_600_000;
const NOON = Date.parse("2026-11-20T12:00:00Z");
const OWNER: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const GUEST = { kind: "session", scopes: ["client"], via: "cookie", session: {} } as unknown as RequestAuth;
const PERSON_LINE = "I'm job hunting for product design roles in Lisbon, ideally starting in January.";
const RESULTS: SearchResult[] = [
  { title: "Lisbon Design Jobs Fair, 4 December", url: "https://example.org/lisbon-design-fair", snippet: "Studios hiring product designers meet candidates on 4 December at LX Factory. Free sign-up." },
  { title: "Senior Product Designer, Lisbon", url: "https://jobs.example.com/pd-lisbon", snippet: "Hybrid role in Lisbon, apply by 1 December." },
];
const SPOT = JSON.stringify({ goals: [{ title: "Job hunting: product design roles in Lisbon", search: ["product designer jobs Lisbon", "Lisbon design job fair"], from: 1, evidence: "job hunting for product design roles in Lisbon" }] });
const OFFER = JSON.stringify({ offer: { result: 1, find: "There's a design jobs fair in Lisbon on 4 December where studios hiring product designers meet candidates.", bot: 2, action: "Prep a shortlist of the studios worth meeting", ask: "Want Scout to prep a shortlist of the studios worth meeting?", task: "List the studios at the fair that hire product designers and why each fits." } });

type Row = { id: string; role: string; kind: string; text?: string; serverCard?: true; offer?: { id: string; botName: string; action: string; answer?: string; started?: { botId: string; threadId: string } } };

function setup(over: Partial<OffersDeps> = {}, answers: { spot?: string; judge?: string } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "offers-"));
  dirs.push(dataDir);
  let clock = NOON;
  let file: string | null = null;
  const interests: InterestsFile = { read: () => file, write: (_bot, _before, after) => { file = after; } };
  const bots = [
    { id: "dusk", name: "Dusk", title: "Chief of Staff", description: "", notifications: true, tasks: [{ threadId: "t-dusk", askedAt: NOON - 2 * HOUR }] },
    { id: "scout", name: "Scout", title: "Research", description: "Finds and compares things", notifications: true, tasks: [{ threadId: "t-scout", askedAt: NOON - 3 * HOUR }] },
  ] as Array<Record<string, unknown> & { id: string; name: string; tasks: Array<{ threadId: string; askedAt?: number }>; suggestions?: boolean }>;
  const messages = new Map<string, Row[]>();
  let next = 0;
  const store = {
    bots,
    bot: (id: string) => bots.find((bot) => bot.id === id),
    tasks: (botId: string) => bots.find((bot) => bot.id === botId)?.tasks ?? [],
    taskByThread: (botId: string, threadId: string) => bots.find((bot) => bot.id === botId)?.tasks.find((task) => task.threadId === threadId),
    groupByThread: () => undefined,
    messagesFor: (threadId: string) => messages.get(threadId) ?? [],
    appendMessage: (threadId: string, message: Omit<Row, "id">) => {
      const row = { ...message, id: `m${++next}` } as Row;
      messages.set(threadId, [...(messages.get(threadId) ?? []), row]);
      return row;
    },
    patchMessage: (threadId: string, messageId: string, patch: Partial<Row>) => {
      const row = messages.get(threadId)?.find((one) => one.id === messageId);
      if (row) Object.assign(row, patch);
      return row ?? null;
    },
    patchTask: () => null,
  };
  const prompts: string[] = [];
  const searches: string[][] = [];
  const notified: Notification[] = [];
  const started: Array<{ botId: string; threadId?: string; title: string; text: string }> = [];
  const conversations: Record<string, DreamConversation[]> = { scout: [{ threadId: "t-scout", lines: [{ by: "person", text: PERSON_LINE }, { by: "bot", text: "Good luck! Want me to look?" }] }] };
  const cfg: { features?: { suggestions?: boolean; suggestionsPerDay?: number }; profile?: { aboutMe?: string } } = {};
  let busy = false;
  const offers = createOffers({
    store: store as unknown as OffersDeps["store"], dataDir, team: false, config: () => cfg,
    owner: () => store.bot("dusk") as never,
    writer: () => ({
      generateText: async (prompt: string) => {
        prompts.push(prompt);
        if (prompt.startsWith(SPOT_MARKER)) return answers.spot ?? SPOT;
        if (prompt.startsWith(JUDGE_MARKER)) return answers.judge ?? OFFER;
        return "";
      },
    }),
    search: async (_bot, queries) => { searches.push(queries); return queries.some((query) => /lisbon/i.test(query)) ? RESULTS : RESULTS.map((result) => ({ ...result, url: `${result.url}?for=${encodeURIComponent(queries[0]!)}` })); },
    conversations: (botId, since) => (conversations[botId] ?? []).filter(() => since < NOON - HOUR),
    mainThread: (botId) => `t-${botId}`,
    threadBusy: () => false,
    anyBusy: () => busy,
    timeZone: () => "UTC",
    notify: (notification) => { if (notification) notified.push(notification); },
    start: async (input) => { started.push(input); return input.threadId ?? "t-new"; },
    interests,
    now: () => clock,
    random: () => 0.5,
    ...over,
  });
  return {
    offers, store, prompts, searches, notified, started, cfg, conversations, messages,
    file: () => file,
    setFile: (text: string) => { file = text; },
    at: (ms: number) => { clock = ms; },
    busy: (value: boolean) => { busy = value; },
    /** The first pass only schedules; this makes the next one due. */
    async due() {
      await offers.pass();
      clock += OFFER_TIMING.boot + OFFER_TIMING.jitter;
    },
  };
}

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("suggestions: scheduling and guardrails", () => {
  it("waits after a start with jitter, then runs on its own schedule", async () => {
    const env = setup();
    expect(await env.offers.pass()).toEqual({ kind: "skipped", why: "first pass scheduled" });
    env.at(NOON + OFFER_TIMING.boot);
    expect(await env.offers.pass()).toEqual({ kind: "skipped", why: "not due" });
    env.at(NOON + OFFER_TIMING.boot + OFFER_TIMING.jitter / 2);
    expect((await env.offers.pass()).kind).toBe("offered");
    expect(await env.offers.pass()).toEqual({ kind: "skipped", why: "not due" });
  });

  it("stays quiet at night in the person's time zone, during a conversation, and when switched off", async () => {
    const env = setup();
    await env.due();
    const due = NOON + OFFER_TIMING.boot + OFFER_TIMING.jitter;
    env.at(Date.parse("2026-11-20T22:30:00Z"));
    expect(await env.offers.pass()).toEqual({ kind: "skipped", why: "quiet hours" });
    env.at(due);
    env.busy(true);
    expect(await env.offers.pass()).toEqual({ kind: "skipped", why: "in a conversation" });
    env.busy(false);
    env.store.bots[0]!.tasks[0]!.askedAt = due - 5 * 60_000;
    expect(await env.offers.pass()).toEqual({ kind: "skipped", why: "in a conversation" });
    env.store.bots[0]!.tasks[0]!.askedAt = due - 2 * HOUR;
    env.cfg.features = { suggestions: false };
    expect(await env.offers.pass()).toEqual({ kind: "skipped", why: "off" });
    env.cfg.features = {};
    env.store.bots[0]!.suggestions = false;
    expect(await env.offers.pass()).toEqual({ kind: "skipped", why: "owner off" });
    expect(env.prompts).toEqual([]);
  });

  it("keeps the person's own quiet hours and offers nothing under Never", async () => {
    let prefs = { tell: [] as string[], never: [] as string[], quiet: { from: "11:00", to: "14:00" } as { from: string; to: string } | null };
    const env = setup({ prefs: () => prefs });
    await env.due();
    expect(await env.offers.pass()).toEqual({ kind: "skipped", why: "quiet hours" });
    env.at(Date.parse("2026-11-20T16:00:00Z"));
    prefs = { tell: [], never: ["design jobs"], quiet: null };
    expect(await env.offers.pass()).toEqual({ kind: "quiet", why: "they asked not to hear about this" });
    expect(env.notified).toEqual([]);
  });

  it("is quiet at night in a zone where it is night, though it is noon in UTC", async () => {
    const env = setup({ timeZone: () => "Pacific/Auckland" });
    await env.due();
    expect(await env.offers.pass()).toEqual({ kind: "skipped", why: "quiet hours" });
  });

  it("never sends more than the daily cap, or two close together", async () => {
    const env = setup();
    await env.due();
    const passAt = async (ms: number) => { env.at(ms); return env.offers.pass(); };
    expect(await passAt(NOON + OFFER_TIMING.boot + OFFER_TIMING.jitter)).toMatchObject({ kind: "offered" });
    env.setFile(`${env.file()}- Moving to Porto · weight 1 · since 2026-11-20 · id moving-porto\n`);
    expect(await passAt(Date.parse("2026-11-20T20:30:00Z"))).toMatchObject({ kind: "offered" });
    env.setFile(`${env.file()}- Learning Portuguese · weight 1 · since 2026-11-20 · id portuguese\n`);
    env.at(Date.parse("2026-11-20T20:50:00Z"));
    expect(env.offers.blocked()).toBe("daily cap");
    env.cfg.features = { suggestionsPerDay: 3 };
    expect(env.offers.blocked()).toBe("too soon");
    env.at(Date.parse("2026-11-21T10:00:00Z"));
    expect(env.offers.blocked()).toBeNull();
  });
});

describe("suggestions: spotting and delivery", () => {
  it("keeps the goal in memory and posts one find with one offer in the chat it came up in", async () => {
    const env = setup();
    await env.due();
    const outcome = await env.offers.pass();
    expect(outcome).toMatchObject({ kind: "offered", threadId: "t-scout" });
    expect(parseInterests(env.file(), "2026-11-20")).toEqual([{ id: "job-hunting-product-design-roles-in-lisbon", title: "Job hunting: product design roles in Lisbon", weight: 1, since: "2026-11-20", stopped: false }]);
    expect(env.searches).toEqual([["product designer jobs Lisbon", "Lisbon design job fair"]]);
    const row = env.messages.get("t-scout")!.at(-1)!;
    expect(row).toMatchObject({ role: "bot", kind: "text", serverCard: true, offer: { botName: "Scout", action: "Prep a shortlist of the studios worth meeting" } });
    expect(row.text).toContain("[example.org](<https://example.org/lisbon-design-fair>)");
    expect(row.text).toContain("Want Scout to prep a shortlist of the studios worth meeting?");
    expect(env.notified).toEqual([expect.objectContaining({ kind: "brief", botId: "scout", threadId: "t-scout" })]);
  });

  it("spots no goal from the bot's own words, and escapes what the web said", async () => {
    const env = setup({}, {
      spot: JSON.stringify({ goals: [{ title: "Buying a boat", search: ["boats"], from: 1, evidence: "Want me to look" }] }),
    });
    await env.due();
    expect(await env.offers.pass()).toEqual({ kind: "quiet", why: "no goal due" });
    expect(env.file()).toBeNull();
    const injected = setup({}, { judge: JSON.stringify({ offer: { result: 1, find: "Click [here](https://evil.example) **now** <img src=x>", bot: 1, action: "Look", task: "t" } }) });
    await injected.due();
    await injected.offers.pass();
    const text = injected.messages.get("t-scout")!.at(-1)!.text!;
    expect(text).not.toContain("](https://evil");
    expect(text).not.toContain("<img");
  });

  it("drops an offer that names a result the search never returned, or a bot not on the team", async () => {
    for (const judge of [
      JSON.stringify({ offer: { result: 9, find: "f", bot: 1, action: "a", task: "t" } }),
      JSON.stringify({ offer: { result: 1, find: "f", bot: 7, action: "a", task: "t" } }),
      JSON.stringify({ quiet: true }),
    ]) {
      const env = setup({}, { judge });
      await env.due();
      expect(await env.offers.pass()).toEqual({ kind: "quiet", why: "nothing worth it" });
      expect(env.messages.size).toBe(0);
    }
  });

  it("never reads a Do it request as the person's own words", async () => {
    const env = setup();
    env.conversations.scout = [{ threadId: "t-scout", lines: [{ by: "person", text: "Do it: Prep a shortlist.\n\nWhat dusk bot found: I'm job hunting for product design roles in Lisbon" }] }];
    await env.due();
    expect(await env.offers.pass()).toEqual({ kind: "quiet", why: "no goal due" });
    expect(env.prompts).toEqual([]);
  });

  it("makes no model call when nothing new was said and no goal is due", async () => {
    const env = setup();
    env.conversations.scout = [];
    await env.due();
    expect(await env.offers.pass()).toEqual({ kind: "quiet", why: "no goal due" });
    expect(env.prompts).toEqual([]);
  });
});

describe("suggestions: one tap and what it learns", () => {
  async function offered() {
    const env = setup();
    await env.due();
    const outcome = await env.offers.pass();
    if (outcome.kind !== "offered") throw new Error(`no offer: ${JSON.stringify(outcome)}`);
    const row = env.messages.get(outcome.threadId)!.at(-1)!;
    const tap = (answer: "do" | "notNow" | "never", auth: RequestAuth = OWNER) =>
      env.offers.answer({ threadId: outcome.threadId, messageId: row.id, offerId: row.offer!.id, answer, auth });
    return { env, row, tap };
  }
  const goal = (env: ReturnType<typeof setup>) => parseInterests(env.file(), "2026-11-20")[0]!;

  it("Do it starts the work for the right bot as the person's request, once, and raises the goal", async () => {
    const { env, row, tap } = await offered();
    expect(await tap("do", GUEST)).toEqual({ kind: "refused" });
    expect(await tap("do")).toEqual({ kind: "kept", started: { botId: "scout", threadId: "t-scout" } });
    expect(env.started).toHaveLength(1);
    expect(env.started[0]).toMatchObject({ botId: "scout", threadId: "t-scout", title: "Prep a shortlist of the studios worth meeting" });
    expect(env.started[0]!.text.startsWith("Do it: Prep a shortlist")).toBe(true);
    expect(env.started[0]!.text).toContain("List the studios at the fair");
    expect(env.started[0]!.text).toContain("Source: https://example.org/lisbon-design-fair");
    expect(env.started[0]!.text).toContain("ask me before you sign up, apply, pay, book or send anything");
    expect(row.offer).toMatchObject({ answer: "do", started: { botId: "scout", threadId: "t-scout" } });
    expect(goal(env).weight).toBe(1.5);
    expect(await tap("do")).toMatchObject({ kind: "kept" });
    expect(env.started).toHaveLength(1);
  });

  it("Do it for another bot opens a new conversation of that bot", async () => {
    const env = setup({}, { judge: OFFER.replace('"bot":2', '"bot":1') });
    await env.due();
    const outcome = await env.offers.pass();
    if (outcome.kind !== "offered") throw new Error("no offer");
    const row = env.messages.get(outcome.threadId)!.at(-1)!;
    const answer = await env.offers.answer({ threadId: outcome.threadId, messageId: row.id, offerId: row.offer!.id, answer: "do", auth: OWNER });
    expect(answer).toEqual({ kind: "kept", started: { botId: "dusk", threadId: "t-new" } });
    expect(env.started[0]).toMatchObject({ botId: "dusk" });
    expect(env.started[0]!.threadId).toBeUndefined();
  });

  it("Not now lowers the goal and rests it; Don't suggest this stops it for good", async () => {
    const first = await offered();
    expect(await first.tap("notNow")).toEqual({ kind: "kept" });
    expect(goal(first.env).weight).toBe(0.7);
    expect(first.row.offer?.answer).toBe("notNow");
    first.env.at(NOON + 2 * 24 * HOUR);
    first.env.store.bots.forEach((bot) => bot.tasks.forEach((task) => { task.askedAt = 0; }));
    expect(await first.env.offers.pass()).toEqual({ kind: "quiet", why: "no goal due" });

    const second = await offered();
    expect(await second.tap("never")).toEqual({ kind: "kept" });
    expect(goal(second.env).stopped).toBe(true);
    expect(second.env.file()).toContain("· stopped ·");
    second.env.at(NOON + 30 * 24 * HOUR);
    second.env.store.bots.forEach((bot) => bot.tasks.forEach((task) => { task.askedAt = 0; }));
    await second.env.offers.pass();
    expect(parseInterests(second.env.file(), "2026-12-20").filter((one) => !one.stopped)).toEqual([]);
  });

  it("an offer left unanswered for days counts once as a skip", async () => {
    const { env } = await offered();
    env.at(NOON + OFFER_TIMING.lapse + 4 * HOUR);
    await env.offers.pass();
    await env.offers.pass();
    expect(goal(env).weight).toBe(0.85);
  });

  it("refuses an answer for a line it did not post", async () => {
    const { env, row } = await offered();
    expect(await env.offers.answer({ threadId: "t-dusk", messageId: row.id, offerId: row.offer!.id, answer: "do", auth: OWNER })).toEqual({ kind: "unknown" });
    expect(env.started).toEqual([]);
  });
});
