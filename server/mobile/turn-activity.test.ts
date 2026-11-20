import { createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, type KeyObject } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { activityMessage, pushCategory as relayCategory } from "../../apps/link-service/src/push-relay.mjs";
import { pushCategory, TURN_LINE_SEAL } from "../../shared/phone-activity.ts";
import type { ActivityPush } from "./push.ts";
import { createTurnActivities, sealTurnLine, STEP_PUSH_GAP_MS, turnActivityAttributes, type ActivityTarget } from "./turn-activity.ts";

const T0 = 1_800_000_000_000;
let clock = T0;

function setup(startTargets: Array<ActivityTarget & { deviceId: string }> = []) {
  const sent: Array<{ target: ActivityTarget; push: ActivityPush }> = [];
  const activities = createTurnActivities({
    now: () => clock,
    send: async (target, push) => { sent.push({ target, push }); return "sent"; },
    startTargets: () => startTargets,
  });
  return { activities, sent };
}

function openLine(privateKey: KeyObject, sealed: string): string {
  const raw = Buffer.from(sealed, "base64url");
  const ephemeral = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: raw.subarray(0, 32).toString("base64url") }, format: "jwk" });
  const key = Buffer.from(hkdfSync("sha256", diffieHellman({ privateKey, publicKey: ephemeral }), TURN_LINE_SEAL.salt, TURN_LINE_SEAL.info, 32));
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(32, 44));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([decipher.update(raw.subarray(44, raw.length - 16)), decipher.final()]).toString("utf8");
}

afterEach(() => { vi.useRealTimers(); clock = T0; });

describe("turn activities", () => {
  it("pushes nothing for a thread no phone shows", () => {
    const { activities, sent } = setup();
    activities.event("t1", { type: "step", activity: "web" });
    activities.event("t1", { type: "done" }, { reply: "hi" });
    expect(sent).toEqual([]);
  });

  it("pushes an ask at once, holds steps to one per gap, and ends with the sealed first line", async () => {
    vi.useFakeTimers({ now: T0 });
    const phone = generateKeyPairSync("x25519");
    const key = phone.publicKey.export({ format: "jwk" }).x!;
    const { activities, sent } = setup();
    activities.register("d1", { threadId: "t1", token: "ab".repeat(16), key, startedAt: T0 / 1000 - 5 });

    activities.event("t1", { type: "step", activity: "web" });
    activities.event("t1", { type: "step", activity: "read" });
    activities.event("t1", { type: "step", activity: "fetch" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.push).toMatchObject({ event: "update", priority: 5, state: { phase: "working", step: "web", steps: 1, startedAt: T0 / 1000 - 5 } });

    clock += STEP_PUSH_GAP_MS;
    await vi.advanceTimersByTimeAsync(STEP_PUSH_GAP_MS);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.push.state).toMatchObject({ step: "fetch", steps: 3 });

    activities.event("t1", { type: "ask", kind: "approve", requestId: "r1" });
    expect(sent[2]!.push).toMatchObject({ priority: 10, state: { phase: "needs-you", ask: { kind: "approve", requestId: "r1" } } });

    activities.event("t1", { type: "done" }, { reply: "**Booked** the 9:40 train\nDetails follow" });
    const end = sent[3]!.push;
    expect(end).toMatchObject({ event: "end", priority: 10, dismissAt: Math.floor(clock / 1000) + 20, state: { phase: "done" } });
    expect(JSON.stringify(end)).not.toContain("Booked");
    expect(openLine(phone.privateKey, end.state.sealed!)).toBe("Booked the 9:40 train");
    expect(activityMessage(end)?.state.sealed).toBe(end.state.sealed);
    expect(activities.state("t1")).toEqual([]);
  });

  it("ends without a line for a phone that registered no key", () => {
    const { activities, sent } = setup();
    activities.register("d1", { threadId: "t1", token: "ab".repeat(16) });
    activities.event("t1", { type: "done" }, { reply: "secret plans" });
    expect(sent[0]!.push.state).toEqual({ phase: "done", steps: 0, startedAt: Math.floor(T0 / 1000) });
  });

  it("starts an activity by push for an ask nobody's phone shows, once per ask", () => {
    const { activities, sent } = setup([{ deviceId: "d1", token: "cd".repeat(16) }]);
    const attributes = turnActivityAttributes({ id: "b1", name: "Nova", color: "blue", mascotBody: "pixel" }, "t1");
    expect(attributes).toEqual({ botId: "b1", botName: "Nova", threadId: "t1", color: "blue", body: "tofu" });
    activities.event("t1", { type: "ask", kind: "answer", requestId: "r1" }, { attributes });
    activities.event("t1", { type: "ask", kind: "answer", requestId: "r1" }, { attributes });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.push).toMatchObject({ event: "start", priority: 10, attributes, state: { phase: "needs-you", ask: { kind: "answer", requestId: "r1" } } });
    expect(activityMessage(sent[0]!.push)).not.toBeNull();
  });

  it("forgets a phone's activities with the phone, and replaces its own on a new registration", () => {
    const { activities } = setup();
    activities.register("d1", { threadId: "t1", token: "ab".repeat(16) });
    activities.register("d1", { threadId: "t1", token: "ef".repeat(16) });
    activities.register("d2", { threadId: "t1", token: "cd".repeat(16) });
    expect(activities.state("t1").map((one) => one.deviceId)).toEqual(["d1", "d2"]);
    activities.forgetDevice("d1");
    expect(activities.state("t1").map((one) => one.deviceId)).toEqual(["d2"]);
  });

  it("seals to a key only its holder can open", () => {
    const phone = generateKeyPairSync("x25519");
    const sealed = sealTurnLine(phone.publicKey.export({ format: "jwk" }).x!, "hello");
    expect(openLine(phone.privateKey, sealed)).toBe("hello");
    expect(() => openLine(generateKeyPairSync("x25519").privateKey, sealed)).toThrow();
  });

  it("gives the relay the same buttons as the bot host", () => {
    for (const kind of ["approval", "question", "done", "mention", "brief", "wait", "delegation-settled", "spend", "incident"]) {
      for (const extra of [{}, { requestId: "r" }, { groupId: "g" }]) expect(relayCategory({ kind, ...extra })).toBe(pushCategory({ kind, ...extra }));
    }
  });
});
