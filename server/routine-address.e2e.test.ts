// Real server, fake Claude CLI: a routine's own address runs that routine, and goes when the routine does.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { verificationServerEnvironment } from "../scripts/control-dusk.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_CLI = join(ROOT, "server/testing/fake-claude-cli.ts");
const homes: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) await waitForExit(child, { signal: "SIGTERM" });
  for (const home of homes.splice(0)) await removeTempDir(home);
});

it("gives a routine an address that runs it with the posted data, refuses a wrong secret, and deletes it with the routine", async () => {
  const home = mkdtempSync(join(tmpdir(), "dusk-routine-address-"));
  homes.push(home);
  mkdirSync(join(home, "tmp"), { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", displayName: "Verification fixture", config: { cli: FAKE_CLI } } } }));
  const port = await freePortBlock([0, 1]);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], {
    cwd: ROOT, env: verificationServerEnvironment({ ...process.env }, home, port), stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout!.on("data", (chunk) => { output += chunk; });
  child.stderr!.on("data", (chunk) => { output += chunk; });
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
    try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
  }, { timeout: 20_000, interval: 50 }).toBe(true);
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(base + path, { ...init, headers: { origin: base, "content-type": "application/json", ...init.headers } });
    return { status: response.status, body: await response.json() as any };
  };

  const [bot] = (await call("/api/bots?messages=0")).body.bots;
  const routine = (await call("/api/routines", { method: "POST", body: JSON.stringify({
    name: "Price watch", prompt: "Check the price and tell me if it dropped.", botId: bot.id, enabled: false, schedule: { type: "daily", time: "09:00", weekdays: [1] },
  }) })).body.routine;
  const created = await call("/api/webhooks", { method: "POST", body: JSON.stringify({ name: "Price watch", prompt: "", botId: bot.id, routineId: routine.id }) });
  expect(created.status).toBe(201);
  expect(created.body.webhook.routineId).toBe(routine.id);
  const url: string = created.body.credential.url;

  expect((await fetch(url.replace(/\/[^/]+$/, "/wrong"), { method: "POST", body: "{}" })).status).toBe(401);
  const posted = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "idempotency-key": "d1" }, body: "price=19.99" });
  expect(posted.status).toBe(202);
  const { runId } = await posted.json() as { runId: string };
  const run = (await call("/api/routines")).body.runs.find((one: any) => one.id === runId);
  expect(run).toMatchObject({ triggerSource: "webhook", webhookId: created.body.webhook.id, routineName: "Price watch" });

  const mailDoor = await fetch(`${url.split("/hooks/")[0]}/hooks/mail/mb_unknownmailbox`, { method: "POST", headers: { authorization: "Bearer x" }, body: "{}" });
  expect(mailDoor.status).toBe(401);

  expect((await call(`/api/routines/${routine.id}`, { method: "DELETE" })).status).toBeLessThan(300);
  await expect.poll(async () => (await call("/api/webhooks")).body.webhooks.length, { timeout: 5_000 }).toBe(0);
}, 60_000);
