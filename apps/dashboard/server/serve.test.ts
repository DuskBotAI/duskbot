import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { gracefulStop, listenWhenFree, readyGate } from "./serve.ts";

const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise<void>(resolve => { s.closeAllConnections(); s.close(() => resolve()); }); });
const port = (s: Server) => (s.address() as { port: number }).port;

describe("a restart of the account service", () => {
  it("holds requests while the service starts and answers them once it is ready, or 503 when it takes too long", async () => {
    const gate = readyGate(300);
    const server = createServer((req, res) => gate.handle(req, res));
    servers.push(server);
    await listenWhenFree(server, { port: 0, host: "127.0.0.1" });
    const base = `http://127.0.0.1:${port(server)}`;
    const early = fetch(`${base}/v1/health`);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(gate.held()).toBe(1);
    gate.open((_req, res) => { res.writeHead(200).end("ok"); });
    expect(await (await early).text()).toBe("ok");
    const slow = readyGate(100);
    const other = createServer((req, res) => slow.handle(req, res));
    servers.push(other);
    await listenWhenFree(other, { port: 0, host: "127.0.0.1" });
    const late = await fetch(`http://127.0.0.1:${port(other)}/`);
    expect(late.status).toBe(503);
    expect(late.headers.get("retry-after")).toBe("5");
  });

  it("waits for the port the stopping service still holds instead of exiting", async () => {
    const old = createServer((_req, res) => res.end("old"));
    servers.push(old);
    await listenWhenFree(old, { port: 0, host: "127.0.0.1" });
    const taken = port(old), lines: string[] = [];
    const next = createServer((_req, res) => res.end("new"));
    servers.push(next);
    let freed = false;
    const listening = listenWhenFree(next, { port: taken, host: "127.0.0.1", everyMs: 20, log: line => lines.push(line) });
    setTimeout(() => { old.close(); freed = true; }, 150);
    await listening;
    expect(freed).toBe(true);
    expect(lines[0]).toMatch(/still taken/);
    expect(await (await fetch(`http://127.0.0.1:${taken}/`)).text()).toBe("new");
  });

  it("on SIGTERM stops listening, closes the app, then writes and gives the lease back, inside the supervisor's 5 s", async () => {
    const server = createServer((_req, res) => res.end("x"));
    await listenWhenFree(server, { port: 0, host: "127.0.0.1" });
    const order: string[] = [];
    const how = await gracefulStop({ server, closeApp: () => { order.push(`app (listening ${server.listening})`); }, closeDatabase: async () => { order.push("database"); } });
    expect(how).toBe("clean");
    expect(order).toEqual(["app (listening false)", "database"]);
    // a database that hangs never keeps the process past hardMs, and an app that throws does not stop the release
    const stuck = createServer();
    await listenWhenFree(stuck, { port: 0, host: "127.0.0.1" });
    const started = Date.now();
    const forced = await gracefulStop({ server: stuck, closeApp: () => { throw new Error("boom"); }, closeDatabase: () => new Promise(() => {}), hardMs: 100, log: () => {} });
    expect(forced).toBe("forced");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
