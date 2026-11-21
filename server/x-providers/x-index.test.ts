import { describe, expect, it } from "vitest";

import { applyIncludedXIndexMessage, xIndexAccess } from "./x-index.ts";

describe("X index access", () => {
  const token = `dusk_xi_${"b".repeat(43)}`;

  it("takes a desktop's token only for the account service's index path, over https or loopback", () => {
    expect(applyIncludedXIndexMessage({ type: "other" })).toBe(false);
    expect(() => applyIncludedXIndexMessage({ type: "duskbot:included-x-index", access: { url: "http://dusk.bot/api/cloud/x-index", token } })).toThrow();
    expect(() => applyIncludedXIndexMessage({ type: "duskbot:included-x-index", access: { url: "https://dusk.bot/elsewhere", token } })).toThrow();
    expect(() => applyIncludedXIndexMessage({ type: "duskbot:included-x-index", access: { url: "https://dusk.bot/api/cloud/x-index", token: "omc_x" } })).toThrow();
    expect(applyIncludedXIndexMessage({ type: "duskbot:included-x-index", access: { url: "https://dusk.bot/api/cloud/x-index", token } })).toBe(true);
    expect(xIndexAccess(null)).toEqual({ kind: "desktop", url: "https://dusk.bot/api/cloud/x-index", token });
    expect(applyIncludedXIndexMessage({ type: "duskbot:included-x-index", access: null })).toBe(true);
    expect(xIndexAccess(null)).toBeNull();
  });

  it("gives a Cloud home its own signed access", () => {
    expect(xIndexAccess({ adminOrigin: "https://dusk.bot", machineId: "m1", bootstrapSecret: "s" })).toEqual({ kind: "home", url: "https://dusk.bot/api/cloud/x-index", machineId: "m1", secret: "s" });
  });
});
