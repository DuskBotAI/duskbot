import { describe, expect, it } from "vitest";

import type { Message } from "../store.ts";
import { pastedSecret, sameSecretName, valueUnderName } from "./pasted-secret.ts";

const said = (role: "user" | "bot", text: string) => ({ id: text, at: 0, role, kind: "text", text }) as Message;

describe("a secret the person pasted in their own message", () => {
  it("is found under its env name or any wording of its label", () => {
    const block = "set these up\nNITTER_URL=https://nitter.example.test\nexport NITTER_KEY=\"nk_123abc\"\nHindsight token: hs-9f8e7d6c5b4a";
    for (const label of ["NITTER_KEY", "Nitter key", "Nitter access key", "NITTER_ACCESS_KEY", "nitter api token"]) {
      expect(valueUnderName(block, label), label).toBe("nk_123abc");
    }
    expect(valueUnderName(block, "nitter url")).toBe("https://nitter.example.test");
    expect(valueUnderName(block, "HINDSIGHT_TOKEN")).toBe("hs-9f8e7d6c5b4a");
    expect(valueUnderName("XACTIONS_TOKEN=abc123", "xactions token")).toBe("abc123");
    expect(valueUnderName("use NITTER_KEY=nk_123abc and XACTIONS_TOKEN=xa_456def", "xactions token")).toBe("xa_456def");
  });

  it("is found after a sentence that names it", () => {
    const said = "Here's the token for our Telegram bot: 7712345678:AAHk3vXq9-ZpLw2mN8rT5yU1cE4dF6gH0jK. It's in our deals group.";
    for (const label of ["Telegram bot token", "token for our Telegram bot", "TELEGRAM_BOT_TOKEN"]) {
      expect(valueUnderName(said, label), label).toBe("7712345678:AAHk3vXq9-ZpLw2mN8rT5yU1cE4dF6gH0jK");
    }
    expect(valueUnderName(said, "Slack bot token")).toBeNull();
    expect(valueUnderName("the docs are at: https://example.test/docs", "docs token")).toBeNull();
    expect(valueUnderName("my Stripe key is ready: sk_live_123456", "Telegram bot token")).toBeNull();
  });

  it("is not prose, a placeholder, or a secret with another name", () => {
    expect(valueUnderName("Hindsight token: here", "Hindsight token")).toBeNull();
    expect(valueUnderName("XACTIONS_TOKEN=<your token>", "XACTIONS_TOKEN")).toBeNull();
    expect(valueUnderName("XACTIONS_TOKEN=xxxxxxxx", "XACTIONS_TOKEN")).toBeNull();
    expect(valueUnderName("OLD_XACTIONS_TOKEN=abc123", "XACTIONS_TOKEN")).toBeNull();
    expect(valueUnderName("I need the xactions token", "xactions token")).toBeNull();
    expect(valueUnderName("NITTER_URL=https://nitter.example.test", "Nitter access key")).toBeNull();
    expect(sameSecretName("GOOGLE_CLIENT_SECRET", "Google client ID")).toBe(false);
    expect(sameSecretName("STRIPE_SECRET_KEY", "Stripe publishable key")).toBe(false);
    expect(sameSecretName("API_KEY", "API key")).toBe(true);
    expect(sameSecretName("API_KEY", "token")).toBe(false);
  });

  it("comes from the person's newest message, never from a bot's", () => {
    expect(pastedSecret([said("user", "API_KEY=old111"), said("user", "API_KEY=new222")], ["API_KEY"])).toBe("new222");
    expect(pastedSecret([said("bot", "set API_KEY=bot333 like this")], ["API_KEY"])).toBeNull();
  });

  it("is a bare key sent right under the card that asks for it, and nothing else that is bare", () => {
    const card = (label: string, extra: Record<string, unknown> = {}) => ({ id: `card-${label}`, at: 0, role: "bot", kind: "secret", text: "", secret: { label, ...extra } }) as unknown as Message;
    const key = "rk_test_51EvalOnlyFakeKey0000";
    expect(pastedSecret([card("Stripe restricted key"), said("user", key)], ["Stripe restricted key"])).toBe(key);
    expect(pastedSecret([card("Stripe key"), said("bot", "Add it in the card above."), said("user", ` ${key} `)], ["Stripe API key"])).toBe(key);
    expect(pastedSecret([said("user", key)], ["Stripe key"])).toBeNull();
    expect(pastedSecret([card("Telegram bot token"), said("user", key)], ["Stripe key"])).toBeNull();
    expect(pastedSecret([card("Stripe key", { savedAt: 1 }), said("user", key)], ["Stripe key"])).toBeNull();
    expect(pastedSecret([card("Stripe key"), said("user", "go ahead and set it up")], ["Stripe key"])).toBeNull();
    expect(pastedSecret([card("Stripe key"), said("user", "abcdefghijklmnopqrstuv")], ["Stripe key"])).toBeNull();
  });
});
