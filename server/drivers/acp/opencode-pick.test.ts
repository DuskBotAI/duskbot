import { describe, expect, it } from "vitest";

import { openCodeCommand, type OpenCodePickDeps } from "./opencode-pick.ts";
import { OPENCODE_STANDALONE } from "./opencode-release.ts";

const deps = (version: string | null, own: string | null = "/data/tools/standalone/opencode/bin/opencode", found: string | undefined = "/usr/local/bin/opencode"): OpenCodePickDeps =>
  ({ own: () => own, found: () => found, version: async () => version });

describe("which OpenCode a turn runs", () => {
  it("runs the app's pinned build when the copy on PATH is older, since OpenCode Go refuses an old one's requests", async () => {
    expect(await openCodeCommand("opencode", "/usr/local/bin", deps("1.2.0"))).toEqual({ command: "/data/tools/standalone/opencode/bin/opencode", env: OPENCODE_STANDALONE.runEnv });
    expect((await openCodeCommand("opencode", undefined, deps(null))).command, "a copy that gives no version").toBe("/data/tools/standalone/opencode/bin/opencode");
  });

  it("keeps the person's copy when it is as new or newer, a path they typed, or when the app has no build here", async () => {
    expect(await openCodeCommand("opencode", undefined, deps(`opencode ${OPENCODE_STANDALONE.version}`))).toEqual({ command: "opencode" });
    expect(await openCodeCommand("opencode", undefined, deps("9.0.0"))).toEqual({ command: "opencode" });
    expect(await openCodeCommand("/opt/opencode/bin/opencode", undefined, deps("1.0.0"))).toEqual({ command: "/opt/opencode/bin/opencode" });
    expect(await openCodeCommand("opencode", undefined, deps("1.0.0", null))).toEqual({ command: "opencode" });
    expect(await openCodeCommand("opencode", undefined, { ...deps("1.0.0"), found: () => undefined }), "nothing on PATH but the app's own").toEqual({ command: "opencode" });
  });
});
