import { describe, expect, it } from "vitest";
import type { InstanceConfigMap } from "../contracts.ts";
import { withInstanceConfig, type SelectableInstance } from "../default-model-selection.ts";
import { createAntigravityAccountRoutes } from "./antigravity-accounts.ts";

describe("POST /api/instances/antigravity-accounts", () => {
  it("marks a newly added account as chosen so default-CLI installs are never flagged as found", async () => {
    let persisted: InstanceConfigMap = {
      antigravity: { driver: "antigravityAgent", displayName: "Antigravity" },
    };
    const handler = createAntigravityAccountRoutes({
      instances: () => structuredClone(persisted),
      persist: async (_id, next) => { persisted = next; },
      describe: async () => Object.entries(persisted).map(([instanceId, entry]) => ({
        instanceId,
        driverKind: entry.driver,
        displayName: entry.displayName,
        snapshot: { state: "available" as const, authenticated: false },
        models: { default: "gemini", options: [] },
      })),
      exclusive: (work) => work(),
    });

    let status = 0;
    let body: { instanceId?: string; instances?: SelectableInstance[] } = {};
    await handler({
      req: { headers: { "content-type": "application/json" } } as never,
      res: {} as never,
      url: new URL("http://127.0.0.1/api/instances/antigravity-accounts"),
      path: "/api/instances/antigravity-accounts",
      method: "POST",
      auth: { kind: "loopback", scopes: ["admin", "client"] },
      json: ((_res: unknown, code: number, payload: unknown) => { status = code; body = payload as typeof body; }) as never,
      readBody: (async () => ({ displayName: "College", sourceInstanceId: "antigravity" })) as never,
    });

    expect(status).toBe(201);
    const id = body.instanceId!;
    expect(id).toMatch(/^antigravity-/);
    expect(persisted[id]).toMatchObject({ driver: "antigravityAgent", displayName: "College", chosen: true, config: {} });

    const selectable = withInstanceConfig(body.instances!, persisted, () => false);
    expect(selectable.find((entry) => entry.instanceId === id)?.found).toBeUndefined();
    expect(selectable.find((entry) => entry.instanceId === "antigravity")?.found).toBe(true);
  });
});
