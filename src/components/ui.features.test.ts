import { describe, expect, it } from "vitest";

describe("Frontend Feature Components", () => {
  it("imports and exports component types cleanly", async () => {
    const { GlobalCommandPalette } = await import("./command-palette/GlobalCommandPalette.tsx");
    const { DiffReviewModal } = await import("./diff/DiffReviewModal.tsx");
    const { TokenCapacityBar } = await import("./gauge/TokenCapacityBar.tsx");
    const { SandpackArtifact } = await import("./artifacts/SandpackArtifact.tsx");

    expect(typeof GlobalCommandPalette).toBe("function");
    expect(typeof DiffReviewModal).toBe("function");
    expect(typeof TokenCapacityBar).toBe("function");
    expect(typeof SandpackArtifact).toBe("function");
  });
});
