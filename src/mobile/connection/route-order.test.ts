import { describe, expect, it } from "vitest";

import type { MobileTransport } from "../../../shared/mobile-link";
import { DIRECT_BUDGET_MS, DIRECT_TRY_MS, directStillWorthIt, routeOrder, routeTimeout } from "./route-order";

const relay: MobileTransport = { kind: "relay", base: "https://link.dusk.bot", channel: "abcdefghij", token: "t", key: "k".repeat(43) };
const lan: MobileTransport = { kind: "companion", url: "http://192.168.1.20:8810", net: "lan", priority: 200 };
const tailnet: MobileTransport = { kind: "companion", url: "http://mac.tail.ts.net:8810", net: "tailnet", priority: 100 };
const https: MobileTransport = { kind: "https", url: "https://box.example.com" };

describe("route order", () => {
  it("tries a computer's tailnet and wi-fi first, briefly, and its relay after them", () => {
    const routes = [relay, tailnet, lan];
    expect(routeOrder(routes)).toEqual([tailnet, lan, relay]);
    expect(routeTimeout(lan, routes, 15_000)).toBe(DIRECT_TRY_MS);
    expect(routeTimeout(relay, routes, 20_000)).toBe(20_000);
  });

  it("keeps a server's order and a companion-only computer's full wait", () => {
    expect(routeOrder([https, relay])).toEqual([https, relay]);
    expect(routeOrder([lan, tailnet])).toEqual([lan, tailnet]);
    expect(routeTimeout(lan, [lan], 15_000)).toBe(15_000);
  });

  it("stops trying direct routes once their budget is spent, only when a relay waits", () => {
    expect(directStillWorthIt(lan, [lan, relay], 0, DIRECT_BUDGET_MS - 1)).toBe(true);
    expect(directStillWorthIt(lan, [lan, relay], 0, DIRECT_BUDGET_MS)).toBe(false);
    expect(directStillWorthIt(relay, [lan, relay], 0, DIRECT_BUDGET_MS * 10)).toBe(true);
    expect(directStillWorthIt(lan, [lan], 0, DIRECT_BUDGET_MS * 10)).toBe(true);
  });
});
