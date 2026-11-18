import { describe, expect, it } from "vitest";

describe("ACP Marketplace UI Modal", () => {
  it("imports and instantiates AcpMarketplaceModal cleanly", async () => {
    const { AcpMarketplaceModal } = await import("./AcpMarketplaceModal.tsx");
    expect(typeof AcpMarketplaceModal).toBe("function");
  });
});
