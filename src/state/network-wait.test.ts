import { describe, expect, it } from "vitest";
import { waitsForNetwork } from "./network-wait";

const sent = { id: "m1", role: "user" as const };
const unsent = { id: "optimistic-s1", role: "user" as const };
const reply = { id: "m2", role: "bot" as const };

describe("a send waiting for the network", () => {
  it("is a message of the person's still on its way while the device is offline", () => {
    expect(waitsForNetwork([sent, reply, unsent], true)).toBe(true);
  });

  it("is not while the device is online, or once the server has the message or the bot answered", () => {
    expect(waitsForNetwork([sent, reply, unsent], false)).toBe(false);
    expect(waitsForNetwork([sent], true)).toBe(false);
    expect(waitsForNetwork([unsent, reply], true)).toBe(false);
    expect(waitsForNetwork([], true)).toBe(false);
  });
});
