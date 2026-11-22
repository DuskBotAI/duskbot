import { describe, expect, it, vi } from "vitest";

import type { Message } from "@/state/store";
import { keyInSend, offerToSecretCard, openSecretCard, takeOfferedSecret, watchOfferedSecrets, withoutKeys } from "./composer-secret";

const KEY = "sk-ant-ZZtestFAKE0123456789";
const card = (id: string, secret: Partial<NonNullable<Message["secret"]>> = {}): Message =>
  ({ id, role: "assistant", text: "", secret: { target: "customSecret", label: "Stripe secret key", description: "", ...secret } }) as unknown as Message;

describe("keyInSend", () => {
  it("finds a key in the words and the open Secrets card it belongs in", () => {
    expect(keyInSend(`here is the key ${KEY}`, [card("old", { superseded: true }), card("open")])).toEqual({ key: KEY, cardId: "open" });
  });

  it("finds the key with no card open, and nothing in ordinary words", () => {
    expect(keyInSend(KEY, [])).toEqual({ key: KEY, cardId: null });
    expect(keyInSend(KEY, [card("done", { provided: true }), card("gone", { stopped: true })])?.cardId).toBeNull();
    expect(keyInSend("my api key is in Settings", [card("open")])).toBeNull();
  });
});

describe("openSecretCard", () => {
  it("skips replaced, stopped and answered cards", () => {
    expect(openSecretCard([card("a"), card("b", { superseded: true })])?.id).toBe("a");
    expect(openSecretCard(undefined)).toBeNull();
  });
});

describe("withoutKeys", () => {
  it("takes every key out and keeps the rest of the words", () => {
    expect(withoutKeys(`here is the key ${KEY} and ${KEY} again`)).toBe("here is the key and again");
    expect(withoutKeys(KEY)).toBe("");
  });
});

describe("offering a value to a Secrets card", () => {
  it("tells the cards and hands the value over once", () => {
    const watch = vi.fn();
    const stop = watchOfferedSecrets(watch);
    offerToSecretCard("card-1", KEY);
    expect(watch).toHaveBeenCalledOnce();
    expect(takeOfferedSecret("card-2")).toBeUndefined();
    expect(takeOfferedSecret("card-1")).toBe(KEY);
    expect(takeOfferedSecret("card-1")).toBeUndefined();
    stop();
  });
});
