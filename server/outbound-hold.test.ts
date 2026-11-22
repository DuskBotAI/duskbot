import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Notification } from "../shared/notification.ts";
import { flushDecisionLog, readDecisions } from "./decision-log.ts";
import { OutboundCounts } from "./outbound-counts.ts";
import { DECLINED_BEFORE, sendKey } from "../shared/declined-sends.ts";
import { createOutboundHold, type OutboundHold, type OutboundHoldDeps } from "./outbound-hold.ts";
import { OutboundRequestService } from "./outbound-requests.ts";

type HoldBot = Parameters<OutboundHold["hold"]>[0]["bot"];

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const calls = [{ slug: "GMAIL_SEND_EMAIL", arguments: { to: "ana@example.com", subject: "Hello" } }];

function setup(bot: HoldBot) {
  const dataDir = mkdtempSync(join(tmpdir(), "outbound-hold-"));
  dirs.push(dataDir);
  const appended: Array<{ threadId: string; message: { id: string; card?: Record<string, unknown> } & Record<string, unknown> }> = [];
  const patches: Array<{ threadId: string; messageId: string; patch: Record<string, unknown> }> = [];
  const activity: string[] = [];
  const notified: Array<Notification | null> = [];
  const store = {
    appendMessage: (threadId: string, message: Record<string, unknown>) => {
      const row = { ...message, id: `m${appended.length + 1}` };
      appended.push({ threadId, message: row });
      return row;
    },
    bot: (id: string) => (id === bot.id ? bot : undefined),
    messagesFor: (threadId: string) => appended.filter((entry) => entry.threadId === threadId).map((entry) => entry.message),
    patchMessage: (threadId: string, messageId: string, patch: Record<string, unknown>) => {
      patches.push({ threadId, messageId, patch });
      return null;
    },
    setActivity: (_botId: string, value: string) => {
      activity.push(`bot:${value}`);
      return null;
    },
    setTaskActivity: (_botId: string, _threadId: string, value: string) => {
      activity.push(`task:${value}`);
      return null;
    },
    taskByThread: () => ({ busy: true }),
  };
  const outboundRequests = new OutboundRequestService();
  const outboundCounts = new OutboundCounts(join(dataDir, "outbound-counts.json"));
  const deps: OutboundHoldDeps = {
    store: store as unknown as OutboundHoldDeps["store"],
    dataDir,
    outboundRequests,
    outboundCounts,
    holdMs: 1_000,
    connectorThread: () => ({ group: undefined }),
    activeGroupTurnForBot: () => null,
    notify: (notification) => notified.push(notification),
  };
  const input = { bot, threadId: "t1", tool: "GMAIL_SEND_EMAIL", calls, opaque: false, fullAccess: false };
  return { hold: createOutboundHold(deps), dataDir, appended, patches, activity, notified, outboundRequests, input };
}

const bot = (outbound: HoldBot["outbound"], notifications = true): HoldBot => ({ id: "b1", name: "Scout", color: "green", outbound, notifications });

describe("createOutboundHold", () => {
  it("allow policy under the cap approves without a card and records the row", async () => {
    const { hold, dataDir, appended, notified, input } = setup(bot({ policy: "allow", dailyCap: 2 }));
    await expect(hold.hold({ ...input, active: () => true })).resolves.toEqual({ ok: true, approved: false });
    expect(appended).toEqual([]);
    expect(notified).toEqual([]);

    hold.reserve({ ...input, approved: false });
    hold.reserve({ ...input, approved: false });
    expect(() => hold.reserve({ ...input, approved: false })).toThrow(/daily outbound limit/);

    await flushDecisionLog(dataDir);
    const rows = readDecisions(dataDir, 10);
    expect(rows.map((row) => row.rule)).toEqual(["daily-allowance:1/2", "daily-allowance:2/2"]);
    expect(rows[0]).toMatchObject({ threadId: "t1", botId: "b1", botName: "Scout", tool: "GMAIL_SEND_EMAIL", decision: "auto-approved", source: "outbound" });

    // The cap is spent: the next hold refuses before any card.
    await expect(hold.hold({ ...input, active: () => true })).resolves.toMatchObject({ ok: false, text: expect.stringMatching(/daily limit of 2 outbound actions/) });
  });

  it("ask policy posts the card and resolves on allow", async () => {
    const { hold, dataDir, appended, activity, notified, outboundRequests, input } = setup(bot({ policy: "ask", dailyCap: 10 }));
    const pending = hold.hold({ ...input, active: () => true });

    expect(appended).toHaveLength(1);
    const card = appended[0].message;
    expect(appended[0].threadId).toBe("t1");
    expect(card).toMatchObject({
      role: "bot",
      kind: "options",
      card: {
        title: "Send on your behalf?",
        options: ["Allow", "Deny"],
        requestId: expect.any(String),
        tool: "GMAIL_SEND_EMAIL",
        heldCode: "approval.held.outbound",
        outboundRequest: { tool: "GMAIL_SEND_EMAIL", app: "Gmail" },
      },
    });
    expect(card).not.toHaveProperty("from");
    expect(activity).toEqual(["task:waiting-on-you"]);
    expect(notified).toMatchObject([{ kind: "approval", botId: "b1", threadId: "t1" }]);

    const requestId = card.card!.requestId as string;
    expect(outboundRequests.resolve({ threadId: "t1", requestId, behavior: "allow" })).toEqual({ claimed: true, state: "allowed" });
    await expect(pending).resolves.toEqual({ ok: true, approved: true });
    expect(outboundRequests.pending("t1")).toEqual([]);

    await flushDecisionLog(dataDir);
    expect(readDecisions(dataDir, 10)).toMatchObject([{ requestId, decision: "card-shown", source: "outbound", tool: "GMAIL_SEND_EMAIL" }]);
    // An approved hold lets the dispatch through without spending the allowance.
    expect(() => hold.reserve({ ...input, bot: bot({ policy: "ask", dailyCap: 10 }), approved: true })).not.toThrow();

    // A bot the user muted still posts the card, but sends no notification.
    const muted = setup(bot({ policy: "ask", dailyCap: 10 }, false));
    const mutedPending = muted.hold.hold({ ...muted.input, active: () => true });
    expect(muted.appended).toHaveLength(1);
    expect(muted.notified).toEqual([null]);
    muted.outboundRequests.resolve({ threadId: "t1", requestId: muted.appended[0].message.card!.requestId as string, behavior: "allow" });
    await expect(mutedPending).resolves.toEqual({ ok: true, approved: true });
  });

  it("a line typed while the card waits stops the wait, so the turn reads it; the card shows it is no longer waiting", async () => {
    const typed = setup(bot({ policy: "ask", dailyCap: 10 }));
    const pending = typed.hold.hold({ ...typed.input, active: () => true });
    const elsewhere = typed.outboundRequests.open({ botId: "b1", threadId: "t2", tool: "GMAIL_SEND_EMAIL", timeoutMs: 60_000 });
    expect(typed.outboundRequests.replied("t1")).toEqual([typed.appended[0].message.card!.requestId]);
    await expect(pending).resolves.toEqual({ ok: false, text: expect.stringMatching(/wrote in the chat instead of answering the card\. Read their message/) });
    expect(typed.patches).toMatchObject([{ threadId: "t1", messageId: "m1", patch: { card: { answered: "unavailable", dismissed: true } } }]);
    expect(typed.outboundRequests.pending("t2")).toEqual([elsewhere.requestId]);
    expect(typed.outboundRequests.replied("t1")).toEqual([]);
  });

  it("deny answers the decline text; timeout marks the card unavailable", async () => {
    const denied = setup(bot(undefined));
    const pending = denied.hold.hold({ ...denied.input, active: () => true });
    const requestId = denied.appended[0].message.card!.requestId as string;
    denied.outboundRequests.resolve({ threadId: "t1", requestId, behavior: "deny" });
    await expect(pending).resolves.toEqual({ ok: false, text: expect.stringMatching(/the user declined/) });
    expect(denied.patches.map((one) => one.patch)).toEqual([{ card: expect.objectContaining({ send: expect.objectContaining({ declined: true }) }) }]);

    vi.useFakeTimers();
    const timed = setup(bot(undefined));
    const waiting = timed.hold.hold({ ...timed.input, active: () => true });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(waiting).resolves.toEqual({ ok: false, text: expect.stringMatching(/nobody answered/) });
    expect(timed.patches).toHaveLength(1);
    expect(timed.patches[0]).toMatchObject({ threadId: "t1", messageId: timed.appended[0].message.id, patch: { card: { answered: "unavailable", dismissed: true, title: "Send on your behalf?" } } });
  });

  it("reserve refuses when the hold was not approved and the policy is ask", async () => {
    const { hold, input } = setup(bot({ policy: "ask", dailyCap: 10 }));
    expect(() => hold.reserve({ ...input, fullAccess: false, approved: false })).toThrow(/outbound policy changed/);
  });
});

describe("Full access with no sending rule of its own", () => {
  const send = async (held: ReturnType<typeof setup>) => {
    const answer = await held.hold.hold({ ...held.input, fullAccess: true, active: () => true });
    if (answer.ok) held.hold.reserve({ ...held.input, fullAccess: true, approved: answer.approved });
    return answer;
  };

  it("sends 25 a day without a card and refuses the 26th, sending nothing", async () => {
    const held = setup(bot(undefined));
    for (let sent = 0; sent < 25; sent++) await expect(send(held)).resolves.toEqual({ ok: true, approved: false });
    await expect(send(held)).resolves.toEqual({ ok: false, text: expect.stringMatching(/did not send this\. Scout has reached its daily limit of 25 outbound actions at Full access\. Tell the user it was not sent/) });
    expect(held.appended, "never a card").toEqual([]);
    expect(held.notified).toEqual([]);
    expect(held.outboundRequests.pending("t1")).toEqual([]);
    // A send that passed the hold just before the 25th was spent is still stopped at dispatch.
    expect(() => held.hold.reserve({ ...held.input, fullAccess: true, approved: false })).toThrow(/daily outbound limit\. Nothing was sent/);
    await flushDecisionLog(held.dataDir);
    const rules = readDecisions(held.dataDir, 100).map((row) => row.rule);
    expect(rules[0]).toBe("full-access:1/25");
    expect(rules[24]).toBe("full-access:25/25");
    expect(rules[25]).toBe("full-access-cap:25");
  });

  it("starts the count again the next day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 4, 23, 30));
    const held = setup(bot(undefined));
    for (let sent = 0; sent < 25; sent++) await send(held);
    await expect(send(held)).resolves.toMatchObject({ ok: false });
    vi.setSystemTime(new Date(2026, 10, 5, 0, 5));
    await expect(send(held)).resolves.toEqual({ ok: true, approved: false });
    await flushDecisionLog(held.dataDir);
    expect(readDecisions(held.dataDir, 100).map((row) => row.rule).at(-1)).toBe("full-access:1/25");
  });

  it("keeps a stored rule exactly as set: ask still asks, allow keeps its own cap", async () => {
    const asking = setup(bot({ policy: "ask", dailyCap: 100 }));
    const pending = asking.hold.hold({ ...asking.input, fullAccess: true, active: () => true });
    expect(asking.appended).toHaveLength(1);
    asking.outboundRequests.resolve({ threadId: "t1", requestId: asking.appended[0].message.card!.requestId as string, behavior: "allow" });
    await expect(pending).resolves.toEqual({ ok: true, approved: true });

    const allowing = setup(bot({ policy: "allow", dailyCap: 30 }));
    for (let sent = 0; sent < 30; sent++) await expect(send(allowing)).resolves.toEqual({ ok: true, approved: false });
    await expect(send(allowing)).resolves.toEqual({ ok: false, text: expect.stringMatching(/daily limit of 30 outbound actions\. Tell the user it was not sent, and ask them to raise the limit/) });
  });

  it("counts a call it cannot inspect too, and never turns it into a card", async () => {
    const held = setup(bot(undefined));
    for (let sent = 0; sent < 25; sent++) await held.hold.hold({ ...held.input, opaque: true, fullAccess: true, active: () => true }).then((answer) => answer.ok && held.hold.reserve({ ...held.input, opaque: true, fullAccess: true, approved: false }));
    await expect(held.hold.hold({ ...held.input, opaque: true, fullAccess: true, active: () => true })).resolves.toMatchObject({ ok: false });
    expect(held.appended).toEqual([]);
  });
});

describe("purchases and emails on their own cards", () => {
  const requestOf = (held: ReturnType<typeof setup>) => held.appended.at(-1)!.message.card!.requestId as string;

  it("a purchase waits on Confirm purchase at Full access and under a daily allowance", async () => {
    for (const rule of [undefined, { policy: "allow" as const, dailyCap: 25 }]) {
      const held = setup(bot(rule));
      const order = [{ slug: "SHOPIFY_CREATE_ORDER", arguments: { line_items: [{ title: "Mug", quantity: 2 }] } }];
      const pending = held.hold.hold({ ...held.input, tool: "SHOPIFY_CREATE_ORDER", calls: order, fullAccess: true, active: () => true });
      expect(held.appended[0]!.message.card).toMatchObject({ title: "Confirm purchase", options: ["Confirm purchase", "Cancel"], outboundRequest: { purchase: true } });
      held.outboundRequests.resolve({ threadId: "t1", requestId: requestOf(held), behavior: "deny" });
      await expect(pending).resolves.toEqual({ ok: false, text: expect.stringMatching(/did not buy this: the user declined/) });
      expect(() => held.hold.reserve({ ...held.input, tool: "SHOPIFY_CREATE_ORDER", calls: order, fullAccess: true, approved: false })).toThrow(/Ask for approval again/);
    }
  });

  it("an email at Full access shows its recipients, subject and text, and goes out as the person edited it", async () => {
    const held = setup(bot(undefined));
    const args: Record<string, unknown> = { user_id: "me", recipient_email: "ana@example.com", subject: "Friday", body: "See you at 5." };
    const pending = held.hold.hold({ ...held.input, calls: [{ slug: "GMAIL_SEND_EMAIL", arguments: args }], fullAccess: true, active: () => true });
    expect(held.appended[0]!.message.card).toMatchObject({
      title: "Send this email?", options: ["Send email", "Don't send"],
      email: { app: "Gmail", to: ["ana@example.com"], subject: "Friday", body: "See you at 5." },
    });
    held.outboundRequests.resolve({ threadId: "t1", requestId: requestOf(held), behavior: "allow", edits: { to: "ana@example.com, ben@example.com", body: "See you at 6." } });
    await expect(pending).resolves.toEqual({ ok: true, approved: true });
    expect(args).toEqual({ user_id: "me", recipient_email: "ana@example.com", extra_recipients: ["ben@example.com"], subject: "Friday", body: "See you at 6." });
    expect(held.patches.at(-1)!.patch.card).toMatchObject({ email: { to: ["ana@example.com", "ben@example.com"], body: "See you at 6." } });
  });

  it("edits with an address that is not one send nothing", async () => {
    const held = setup(bot(undefined));
    const args = { recipient_email: "ana@example.com", subject: "Hi", body: "Hello" };
    const pending = held.hold.hold({ ...held.input, calls: [{ slug: "GMAIL_SEND_EMAIL", arguments: args }], fullAccess: true, active: () => true });
    held.outboundRequests.resolve({ threadId: "t1", requestId: requestOf(held), behavior: "allow", edits: { to: "not an address" } });
    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(args.recipient_email).toBe("ana@example.com");
  });

  it("a saved draft sent by id shows its real text, offers no edits, and asks at Full access", async () => {
    const held = setup(bot(undefined));
    const draft = { app: "Gmail", to: ["sam@example.com"], subject: "Friday", body: "See you at 5." };
    const calls = [{ slug: "GMAIL_SEND_DRAFT", arguments: { user_id: "me", draft_id: "r-1" } }];
    const readDraft = vi.fn(async () => draft);
    const pending = held.hold.hold({ ...held.input, tool: "GMAIL_SEND_DRAFT", calls, fullAccess: true, active: () => true, readDraft });
    await vi.waitFor(() => expect(held.appended).toHaveLength(1));
    expect(readDraft).toHaveBeenCalledWith("r-1");
    expect(held.appended[0]!.message.card).toMatchObject({ title: "Send this email?", email: { ...draft, draft: true } });
    held.outboundRequests.resolve({ threadId: "t1", requestId: requestOf(held), behavior: "allow", edits: { body: "Changed" } });
    await expect(pending).resolves.toMatchObject({ ok: false, text: expect.stringMatching(/saved draft goes out as saved/) });

    const unread = setup(bot(undefined));
    const plain = unread.hold.hold({ ...unread.input, tool: "GMAIL_SEND_DRAFT", calls, fullAccess: true, active: () => true, readDraft: async () => null });
    await vi.waitFor(() => expect(unread.appended).toHaveLength(1));
    expect(unread.appended[0]!.message.card).toMatchObject({ title: "Send on your behalf?" });
    unread.outboundRequests.resolve({ threadId: "t1", requestId: requestOf(unread), behavior: "allow" });
    await expect(plain).resolves.toEqual({ ok: true, approved: true });
  });

  it("a message below Full access shows where it goes and its text, and goes out as the person edited it", async () => {
    const held = setup(bot(undefined));
    const args: Record<string, unknown> = { to_number: "+15551234567", text: "On my way", phone_number_id: "1" };
    const pending = held.hold.hold({ ...held.input, tool: "WHATSAPP_SEND_MESSAGE", calls: [{ slug: "WHATSAPP_SEND_MESSAGE", arguments: args }], active: () => true });
    expect(held.appended[0]!.message.card).toMatchObject({
      title: "Send this message?", subtitle: "To +15551234567\n\nOn my way", options: ["Send", "Don't send"],
      messageReview: { app: "WhatsApp", to: "+15551234567", text: "On my way" },
    });
    expect(held.outboundRequests.resolve({ threadId: "t1", requestId: requestOf(held), behavior: "allow", edits: { body: "email-shaped" } })).toEqual({ claimed: true, state: "denied" });
    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(args.text).toBe("On my way");

    const again = setup(bot(undefined));
    const sent = again.hold.hold({ ...again.input, tool: "WHATSAPP_SEND_MESSAGE", calls: [{ slug: "WHATSAPP_SEND_MESSAGE", arguments: args }], active: () => true });
    again.outboundRequests.resolve({ threadId: "t1", requestId: requestOf(again), behavior: "allow", edits: { text: "Running 10 late" } });
    await expect(sent).resolves.toEqual({ ok: true, approved: true });
    expect(args).toEqual({ to_number: "+15551234567", text: "Running 10 late", phone_number_id: "1" });
    expect(again.patches.at(-1)!.patch.card).toMatchObject({ messageReview: { text: "Running 10 late" }, subtitle: "To +15551234567\n\nRunning 10 late" });
  });

  it("app-formatted text goes out only as the bot wrote it", async () => {
    const held = setup(bot(undefined));
    const calls = [{ slug: "MICROSOFT_TEAMS_TEAMS_POST_CHAT_MESSAGE", arguments: { chat_id: "19:abc", content: "<p>Hi</p>", content_type: "html" } }];
    const pending = held.hold.hold({ ...held.input, tool: calls[0]!.slug, calls, active: () => true });
    held.outboundRequests.resolve({ threadId: "t1", requestId: requestOf(held), behavior: "allow", edits: { text: "Changed" } });
    await expect(pending).resolves.toMatchObject({ ok: false, text: expect.stringMatching(/formatted for the app/) });
    expect(calls[0]!.arguments.content).toBe("<p>Hi</p>");
  });

  it("by default (Full access, no sending rule) a message sends without a card, an email waits on its card", async () => {
    const held = setup(bot(undefined));
    const slack = [{ slug: "SLACK_SEND_MESSAGE", arguments: { channel: "launch", markdown_text: "Hi" } }];
    await expect(held.hold.hold({ ...held.input, tool: "SLACK_SEND_MESSAGE", calls: slack, fullAccess: true, active: () => true })).resolves.toEqual({ ok: true, approved: false });
    expect(held.appended).toEqual([]);
    const email = held.hold.hold({ ...held.input, fullAccess: true, calls: [{ slug: "GMAIL_SEND_EMAIL", arguments: { to: "ana@example.com", subject: "Hi", body: "Hello" } }], active: () => true });
    expect(held.appended[0]!.message.card).toMatchObject({ title: "Send this email?" });
    held.outboundRequests.resolve({ threadId: "t1", requestId: requestOf(held), behavior: "deny" });
    await email;
    await flushDecisionLog(held.dataDir);
  });

  it("an email allowance the person set still sends on its own", async () => {
    const held = setup(bot({ policy: "allow", dailyCap: 5 }));
    const send = [{ slug: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "ana@example.com", subject: "Hi", body: "Hello" } }];
    await expect(held.hold.hold({ ...held.input, calls: send, fullAccess: true, active: () => true })).resolves.toEqual({ ok: true, approved: false });
    expect(held.appended).toEqual([]);
  });

  it("confirm_purchase waits on its summary card; a recorded one is posted already answered", async () => {
    const held = setup(bot(undefined));
    const summary = { merchant: "Acme", items: [{ name: "Kettle", quantity: 1, price: "$40.00" }], total: "$45.00", shipping: "$5.00", paymentMethod: "Visa •••• 4242", address: "1 Main St" };
    const pending = held.hold.confirmPurchase({ bot: bot(undefined), threadId: "t1", summary, recorded: false, active: () => true });
    expect(held.appended[0]!.message.card).toMatchObject({ title: "Confirm purchase", purchase: summary, tool: "confirm_purchase" });
    held.outboundRequests.resolve({ threadId: "t1", requestId: requestOf(held), behavior: "allow" });
    await expect(pending).resolves.toEqual({ ok: true, approved: true });

    await expect(held.hold.confirmPurchase({ bot: bot(undefined), threadId: "t1", summary, recorded: true, active: () => true })).resolves.toEqual({ ok: true, approved: true });
    expect(held.appended[1]!.message.card).toMatchObject({ answered: "allow", purchase: { recorded: true, merchant: "Acme" } });
    expect(held.outboundRequests.pending("t1")).toEqual([]);
  });
});

describe("a declined send is final for the chat", () => {
  const applied = (state: ReturnType<typeof setup>) => {
    for (const { messageId, patch } of state.patches.splice(0)) {
      const row = state.appended.find((entry) => entry.message.id === messageId);
      if (row) Object.assign(row.message, patch);
    }
  };

  it("refuses the same content again without a card until the person asks to send it again", async () => {
    const state = setup(bot({ policy: "ask", dailyCap: 10 }));
    const first = state.hold.hold({ ...state.input, active: () => true });
    state.outboundRequests.resolve({ threadId: "t1", requestId: state.appended[0]!.message.card!.requestId as string, behavior: "deny" });
    await expect(first).resolves.toMatchObject({ ok: false });
    applied(state);
    expect(state.appended[0]!.message.card).toMatchObject({ send: { declined: true, key: sendKey(calls) } });

    // the same words, spaced and cased differently: refused, no second card
    const again = [{ slug: "GMAIL_SEND_EMAIL", arguments: { subject: "hello ", to: "Ana@example.com" } }];
    await expect(state.hold.hold({ ...state.input, calls: again, active: () => true })).resolves.toEqual({ ok: false, text: DECLINED_BEFORE });
    expect(state.appended).toHaveLength(1);

    // other content is a new send and gets its own card
    const other = state.hold.hold({ ...state.input, calls: [{ slug: "GMAIL_SEND_EMAIL", arguments: { to: "ana@example.com", subject: "Lunch?" } }], active: () => true });
    expect(state.appended).toHaveLength(2);
    state.outboundRequests.resolve({ threadId: "t1", requestId: state.appended[1]!.message.card!.requestId as string, behavior: "allow" });
    await expect(other).resolves.toEqual({ ok: true, approved: true });
  });

});
