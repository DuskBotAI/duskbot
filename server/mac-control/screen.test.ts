import { describe, expect, it } from "vitest";

import { screenCatalog, withoutMacFileOutputs } from "./screen.ts";

describe("the Mac's screen tools as a cloud bot sees them", () => {
  it("offers no way to write a screenshot to a path on the Mac: the picture comes back in the answer", () => {
    // get_desktop_state as cua-driver 0.28.2 lists it
    const catalog = screenCatalog(JSON.stringify({ driver: "0.28.2", tools: [{ name: "get_desktop_state", description: "Capture the full display.", inputSchema: {
      type: "object", additionalProperties: false, required: ["screenshot_out_file"],
      properties: { screenshot_out_file: { type: "string", description: "Write PNG here instead of base64." }, session: { type: "string" } },
    } }] }));
    expect(catalog?.tools).toEqual([{ name: "mac_get_desktop_state", description: "On the person's own computer (their screen): Capture the full display.",
      inputSchema: { type: "object", additionalProperties: false, required: [], properties: { session: { type: "string" } } } }]);
    expect(withoutMacFileOutputs({ screenshot_out_file: "/tmp/x.png", pid: 4, window_id: 7 })).toEqual({ pid: 4, window_id: 7 });
  });
});
