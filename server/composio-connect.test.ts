import { describe, expect, it, vi } from "vitest";

import { composioCallFailure, composioConnectActive, composioConnectServer, createComposioConnectRoutes, hasComposioConnectMounted, isComposioConnectUrl, readAppAccounts, readAppConnection, withoutComposioConnect } from "./composio-connect.ts";
import { McpHttpError } from "./mcp-http.ts";
import { PASS } from "./routes/table.ts";

const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

describe("Composio Connect's manage-connections answer", () => {
  it("reads an active app, a started one with its link, and a refusal", () => {
    expect(readAppConnection(text({ successful: true, data: { message: "ok", results: { gmail: { status: "ACTIVE" } } } }), "gmail")).toEqual({ status: "connected" });
    expect(readAppConnection(text({ successful: true, data: { results: { notion: { status: "initiated", redirect_url: "https://connect.composio.dev/link/ln_1" } } } }), "notion"))
      .toEqual({ status: "started", url: "https://connect.composio.dev/link/ln_1" });
    expect(readAppConnection(text({ successful: false, error: "Toolkit nope not found", data: { message: "failed", results: {} } }), "nope"))
      .toEqual({ status: "failed", message: "Toolkit nope not found" });
  });

  it("finds the link in plain text or in fields the docs do not name", () => {
    expect(readAppConnection({ content: [{ type: "text", text: "Connect Slack here: https://connect.composio.dev/link/ln_2." }] }, "slack"))
      .toEqual({ status: "started", url: "https://connect.composio.dev/link/ln_2." });
    expect(readAppConnection(text({ data: { results: { SLACK: { connection: { link: "https://connect.composio.dev/link/ln_3" } } } } }), "slack"))
      .toEqual({ status: "started", url: "https://connect.composio.dev/link/ln_3" });
  });
});

// the live tool's answers to action "list" on 2026-11-07, ids made up
const listed = (accounts: unknown[], status = "initiated") => text({ successful: true, data: { message: "x", results: { googlemeet: { toolkit: "googlemeet", status, accounts } },
  summary: { total_toolkits: 1, active_connections: 0, initiated_connections: 1, failed_connections: 0 } }, error: null, log_id: "log_1" });

describe("Composio Connect's list answer", () => {
  it("is connected when any account is active, whatever the toolkit's own status says", () => {
    expect(readAppAccounts(listed([{ id: "googlemeet_a", status: "initializing" }, { id: "googlemeet_b", status: "active", is_default: true }], "active"), "googlemeet")).toEqual({ status: "connected" });
    expect(readAppAccounts(listed([{ id: "googlemeet_a", status: "ACTIVE" }]), "GoogleMeet")).toEqual({ status: "connected" });
  });
  it("is waiting while a link is out, and none with no accounts (the toolkit still says initiated)", () => {
    expect(readAppAccounts(listed([{ id: "googlemeet_a", status: "initiated" }]), "googlemeet")).toEqual({ status: "waiting" });
    expect(readAppAccounts(listed([]), "googlemeet")).toEqual({ status: "none" });
  });
  it("passes Composio's refusal on", () => {
    expect(readAppAccounts({ isError: true, content: [{ type: "text", text: "Toolkit not found" }] }, "x")).toEqual({ status: "failed", message: "Toolkit not found" });
    expect(readAppAccounts(text({ successful: false, error: "rate limited", data: {} }), "x")).toEqual({ status: "failed", message: "rate limited" });
  });
});

describe("a failed Composio call", () => {
  it("asks to authorize again on 401, says unreachable on a network error", () => {
    expect(composioCallFailure(new McpHttpError("status", "HTTP 401", 401))).toMatchObject({ status: 409, body: { code: "composio_connect_signed_out" } });
    expect(composioCallFailure(new McpHttpError("network", "request failed"))).toMatchObject({ status: 502, body: { code: "composio_unreachable" } });
    expect(composioCallFailure(new Error("boom"))).toMatchObject({ status: 502, body: { code: "composio_failed", error: "boom" } });
  });
});

describe("the Composio Connect routes", () => {
  const server = { type: "http", url: "https://connect.composio.dev/mcp", headers: {}, enabled: true };
  const call = async (handler: ReturnType<typeof createComposioConnectRoutes>, method: string, path: string) => {
    const sent: { status?: number; body?: unknown } = {};
    const out = await handler({ method, path, res: {}, json: (_res: unknown, status: number, body: unknown) => { sent.status = status; sent.body = body; } } as never);
    return out === PASS ? PASS : sent;
  };

  it("finds the server by its address, whatever it is called", () => {
    expect(composioConnectServer({ mine: server, other: { type: "http", url: "https://example.com/mcp", headers: {}, enabled: true } })?.name).toBe("mine");
    expect(composioConnectServer({})).toBeNull();
    expect(isComposioConnectUrl(server.url)).toBe(true);
    expect(isComposioConnectUrl("https://example.com/mcp")).toBe(false);
    expect(isComposioConnectUrl(undefined)).toBe(false);
  });

  it("reports active, mounted, and filtered state for Composio Connect", () => {
    const servers = { mine: server, other: { type: "http", url: "https://example.com/mcp", headers: {}, enabled: true } };
    expect(composioConnectActive(servers, () => true)).toBe(true);
    expect(composioConnectActive(servers, () => false)).toBe(false);
    expect(composioConnectActive({ mine: { ...server, enabled: false } }, () => true)).toBe(false);
    expect(hasComposioConnectMounted({ mine: server }, servers)).toBe(true);
    expect(hasComposioConnectMounted({ other: servers.other }, servers)).toBe(false);
    expect(Object.keys(withoutComposioConnect({ mine: { type: "http", url: server.url, headers: {} }, other: { type: "http", url: "https://example.com/mcp", headers: {} } }))).toEqual(["other"]);
  });

  it("connects an app through the signed-in server, and asks for the sign-in first", async () => {
    const manage = vi.fn(async () => ({ status: "started" as const, url: "https://connect.composio.dev/link/ln_4" }));
    let signedIn = false;
    const handler = createComposioConnectRoutes({
      servers: () => ({ "composio-connect": server }), signedIn: () => signedIn,
      withToken: async (_name, stored) => ({ ...stored, headers: { Authorization: "Bearer t" } }), refusal: (slug) => slug === "blocked" ? "Your organization turned this app off." : null, manage,
    });
    expect(await call(handler, "GET", "/api/connectors/composio-connect")).toEqual({ status: 200, body: { added: true, name: "composio-connect", signedIn: false, enabled: true } });
    expect(await call(handler, "POST", "/api/connectors/composio-connect/apps/notion")).toMatchObject({ status: 409, body: { code: "composio_connect_signed_out" } });
    signedIn = true;
    expect(await call(handler, "POST", "/api/connectors/composio-connect/apps/notion")).toEqual({ status: 200, body: { status: "started", url: "https://connect.composio.dev/link/ln_4" } });
    expect(manage).toHaveBeenCalledWith(expect.objectContaining({ headers: { Authorization: "Bearer t" } }), "notion", undefined, "add");
    await call(handler, "GET", "/api/connectors/composio-connect/apps/notion");
    expect(manage, "a status check only reads").toHaveBeenLastCalledWith(expect.anything(), "notion", undefined, "list");
    manage.mockRejectedValueOnce(new McpHttpError("status", "HTTP 401", 401));
    expect(await call(handler, "GET", "/api/connectors/composio-connect/apps/notion")).toMatchObject({ status: 409, body: { code: "composio_connect_signed_out" } });
    expect(await call(handler, "POST", "/api/connectors/composio-connect/apps/blocked")).toMatchObject({ status: 403 });
    expect(await call(handler, "GET", "/api/connectors/other")).toBe(PASS);
  });

  it("accepts Composio app slugs with a leading underscore", async () => {
    const manage = vi.fn(async () => ({ status: "connected" as const }));
    const handler = createComposioConnectRoutes({
      servers: () => ({ "composio-connect": server }), signedIn: () => true,
      withToken: async (_name, stored) => stored, refusal: () => null, manage,
    });
    expect(await call(handler, "POST", "/api/connectors/composio-connect/apps/_1password")).toEqual({ status: 200, body: { status: "connected" } });
    expect(manage).toHaveBeenCalledWith(expect.anything(), "_1password", undefined, "add");
    await call(handler, "GET", "/api/connectors/composio-connect/apps/_1password");
    expect(manage).toHaveBeenLastCalledWith(expect.anything(), "_1password", undefined, "list");
  });

  it("reads where Composio signs in ahead of the press while nobody is signed in yet", async () => {
    const warm = vi.fn();
    let servers: Record<string, unknown> = {};
    let signedIn = false;
    const handler = createComposioConnectRoutes({ servers: () => servers, signedIn: () => signedIn, withToken: async () => null, refusal: () => null, warm });
    await call(handler, "GET", "/api/connectors/composio-connect");
    expect(warm, "not added yet: its usual address").toHaveBeenLastCalledWith("https://connect.composio.dev/mcp");
    servers = { mine: server };
    signedIn = true;
    await call(handler, "GET", "/api/connectors/composio-connect");
    expect(warm, "signed in: nothing to warm").toHaveBeenCalledTimes(1);
  });
});
