import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-dusk.ts";

it("with bot sharing off, a new bot can be made private but not shared", async () => {
  const { DUSK_BOT_SHARING: _on, ...env } = process.env;
  const fixture = await launchVerificationServer(env);
  try {
    const call = async (body: unknown) => {
      const response = await fetch(`${fixture.info.url}/api/bots`, {
        method: "POST", headers: { "content-type": "application/json", origin: fixture.info.url }, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() as any };
    };
    for (const visibility of ["everyone", { people: ["bob@acme.test"] }]) {
      const refused = await call({ name: "Shared one", visibility });
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe("bot_sharing_off");
    }
    expect((await call({ name: "Private one", visibility: "admins" })).status).toBeLessThan(300);
    expect((await call({ name: "Plain one" })).status).toBeLessThan(300);
  } finally {
    await fixture.close();
  }
}, 120_000);
