// "Cloud bots use this Mac", live: a real server booted as a dusk cloud home (its own data folder, its link key, a
// stand-in edge's headers) whose bots run on a real engine through the local gateway, and the Mac app's own core
// (electron/cloud-mac.mjs) in this process, paired the way the app pairs, against a scratch home folder. Screen calls go
// to the real cua-driver 0.28.2 when CUA_DRIVER is given, as `mcp --embedded --direct`: it runs on the grants of the
// terminal that started it and never prompts; only reads are asked for. Prints a transcript per turn.
//
//   HOME=<scratch home> [CUA_DRIVER=<cua-driver 0.28.2>] node --experimental-strip-types scripts/cloud-mac-live/run.ts [--model gpt-6.2-sol] [--only n,m]
//
// HOME must be the scratch home: mac_exec's shell inherits it, as the app's does on a real Mac.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { createCloudMac } from "../../electron/cloud-mac.mjs";
import { createScreenDriver } from "../../electron/cloud-screen.mjs";
import { createMacExecutor, macLogFile } from "../../electron/mac-control-tools.mjs";
import { cloudPairingSignature } from "../../server/cloud-home.ts";
import { gatewayFromEnv } from "../memory-eval/sandbox.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const arg = (name: string) => { const at = process.argv.indexOf(`--${name}`); return at > 0 ? process.argv[at + 1] : undefined; };
const MODEL = arg("model") ?? "gpt-6.2-sol";
const ONLY = arg("only")?.split(",").map(Number);
const HOME = homedir();
if (!HOME.includes("dusk-cloud-mac-live")) throw new Error("run with HOME set to a scratch folder whose path holds dusk-cloud-mac-live, never the real home");
const HOST = "dusk-t-0123456789ab.fly.dev";
const EDGE = { host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}` };

const TURNS: Array<{ text: string; screen?: boolean }> = [
  { text: "what's in ~/Downloads on my Mac?" },
  { text: "make a folder called trip-plans on my Mac and put a file in it with a short packing list" },
  { text: "download https://www.rfc-editor.org/rfc/rfc2549.txt to my Mac" },
  { text: "send me the invoice pdf from my Mac's Documents folder" },
  { text: "run `sw_vers` on my Mac and tell me what it says" },
  { text: "which apps are open on my Mac right now?", screen: true },
  { text: "take a screenshot of my Mac's screen and tell me what you see", screen: true },
];

const secret = randomBytes(32).toString("base64url");
const link = generateKeyPairSync("ed25519");
const linkPublic = link.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const root = realpathSync(mkdtempSync(join(tmpdir(), "dusk-cloud-mac-live-server-")));
// the cloud and the Mac share this disk here, never in real life: the Mac's shell may not see the cloud's folder
const shell = join(root, "mac-shell");
writeFileSync(shell, `#!/bin/sh\nexec /usr/bin/sandbox-exec -p '(version 1)(allow default)(deny file-read* file-write* (subpath "${root}"))' /bin/zsh "$@"\n`);
chmodSync(shell, 0o700);
const dataDir = join(root, "cloud");
mkdirSync(join(dataDir, "tmp"), { recursive: true });
const gateway = gatewayFromEnv(MODEL);
writeFileSync(join(dataDir, "config.json"), JSON.stringify({ features: { smartSetupChoices: false },
  instances: { gw: { driver: "openai-compat", displayName: "Live gateway", config: { url: gateway.url, key: gateway.key, model: gateway.model } } } }, null, 2), { mode: 0o600 });
writeFileSync(join(dataDir, "dashboard-link.json"), JSON.stringify({ v: 1, url: "https://cloud.example.test", workspaceId: "w1", publicKey: linkPublic,
  privateKey: link.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"), enrolledAt: Date.now(), claimed: true }), { mode: 0o600 });

let log = "";
const port = 7400 + 2 * Math.floor(Math.random() * 250);
const base = `http://127.0.0.1:${port}`;
// the cloud reaches nothing but loopback (the gateway, itself): no Admin, no dusk.bot
const offline = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
const child: ChildProcess = spawn(process.execPath, ["--experimental-strip-types", "--import", offline, join(REPO, "server", "index.ts")], {
  cwd: REPO,
  env: { PATH: process.env.PATH, HOME: dataDir, TMPDIR: join(dataDir, "tmp"), LANG: "en_US.UTF-8", DUSK_DATA_DIR: dataDir, DUSK_PORT: String(port), DUSK_WEBHOOK_PORT: String(port + 1),
    DUSK_SAVED_SECRETS_KEY_FILE: join(root, "saved-secrets.key"), DUSK_NO_TEST_BOTS: "1",
    DUSK_CLOUD_ROLE: "home", DUSK_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", DUSK_CLOUD_ADMIN_URL: "https://cloud.example.test",
    DUSK_CLOUD_BOOTSTRAP_SECRET: secret, DUSK_PUBLIC_URL: `https://${HOST}` },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout?.on("data", (chunk) => { log += chunk; });
child.stderr?.on("data", (chunk) => { log += chunk; });
const out: string[] = [];
const say = (line = "") => { out.push(line); console.log(line); };

async function until(check: () => boolean | Promise<boolean>, what: string, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${log.slice(-3000)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

let token = "";
async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, { method, headers: { ...EDGE, authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

function tree(dir: string, skip = new Set(["Library", ".zsh_history", ".zsh_sessions"])): Map<string, number> {
  const files = new Map<string, number>();
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      if (skip.has(name)) continue;
      const full = join(at, name);
      const info = statSync(full);
      if (info.isDirectory()) { files.set(`${relative(dir, full)}/`, 0); walk(full); } else files.set(relative(dir, full), info.size);
    }
  };
  walk(dir);
  return files;
}

const cut = (text: string, n = 600) => (text.length > n ? `${text.slice(0, n)}… (${text.length} chars)` : text);

let app: ReturnType<typeof createCloudMac> | undefined;
try {
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`the server exited:\n${log}`);
    try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
  }, "the cloud to start", 120_000);
  const body = JSON.stringify({ label: "dusk bot app (Cloud)", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const granted = await (await fetch(`${base}/api/cloud/pairing`, { method: "POST", headers: { ...EDGE, "content-type": "application/json",
    "x-dusk-cloud-timestamp": timestamp, "x-dusk-cloud-nonce": nonce, "x-dusk-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}` }, body })).json() as { code: string };
  token = (await (await fetch(`${base}/api/auth/pair`, { method: "POST", headers: { ...EDGE, "content-type": "application/json" }, body: JSON.stringify({ code: granted.code }) })).json() as { token: string }).token;
  if (!token?.startsWith("dusk_sess_")) throw new Error("pairing gave no session");

  const cua = process.env.CUA_DRIVER;
  let prefs: Record<string, unknown> = {};
  app = createCloudMac({
    fetch: (input: string, init?: RequestInit) => fetch(input, { ...init, headers: { ...init?.headers as Record<string, string>, ...EDGE, authorization: `Bearer ${token}` } }),
    name: () => "Live test Mac", home: HOME, log: (line: string) => say(`  [mac app] ${line}`),
    prefs: { read: () => prefs, write: (value: Record<string, unknown>) => { prefs = value; } },
    cloud: () => ({ origin: base, awake: true }), linkKey: async () => linkPublic,
    execute: createMacExecutor({ home: HOME, source: "cloud", shell, defaultCwd: () => "~" }),
    ...(cua ? { screen: createScreenDriver({ connection: () => ({ mode: "embedded", mcpCommand: cua, mcpArgs: ["mcp", "--embedded", "--direct"], mcpEnv: { CUA_DRIVER_EMBEDDED: "1", CUA_DRIVER_RS_UPDATE_CHECK: "0", CUA_DRIVER_RS_TELEMETRY_ENABLED: "0" } }) }) } : {}),
  });
  await app.sync();
  await until(async () => (await api("GET", "/api/mac")).body?.online === true, "the Mac to reach its cloud");
  if (cua) await until(async () => (await api("GET", "/api/mac")).body?.cloud?.screen === true, "the Mac's screen tools", 30_000);
  say(`mac status: ${JSON.stringify((await api("GET", "/api/mac")).body)}`);

  const bot = (await api("POST", "/api/bots", { name: "Nova", instanceId: "gw" })).body.bot;
  if (!bot) throw new Error("no bot");
  say(`bot: ${bot.name} on ${bot.instanceId ?? "?"} (${MODEL})`);
  const messages = async () => (await api("GET", `/api/threads/${bot.threadId}/messages`)).body.messages as any[];

  for (const [index, turn] of TURNS.entries()) {
    if (ONLY && !ONLY.includes(index + 1)) continue;
    if (turn.screen && !cua) { say(`\n### turn ${index + 1}: skipped (no CUA_DRIVER)`); continue; }
    const before = tree(HOME);
    const logBefore = existsSync(macLogFile(HOME)) ? readFileSync(macLogFile(HOME), "utf8").length : 0;
    const seen = new Set((await messages()).map((message) => message.id));
    say(`\n### turn ${index + 1}\nperson: ${turn.text}`);
    const sent = await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: turn.text, sendId: `live-${Date.now()}-${index}` });
    if (sent.status !== 202) throw new Error(`send answered ${sent.status} ${JSON.stringify(sent.body)}`);
    const answered = new Set<string>();
    await until(async () => {
      for (const message of await messages()) {
        if (message.card && !message.card.answered && !answered.has(message.card.requestId)) {
          answered.add(message.card.requestId);
          say(`  [card] ${message.card.title} | ${String(message.card.subtitle ?? "").replace(/\n/g, " / ")} -> Allow`);
          await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: message.card.requestId, behavior: "allow" });
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return (await api("GET", "/api/bots")).body.bots.find((entry: any) => entry.id === bot.id)?.busy === false;
    }, `turn ${index + 1}`, 300_000);
    for (const message of (await messages()).filter((entry) => !seen.has(entry.id))) {
      if (message.role === "user" || message.sender === "user") continue;
      if (message.tool) say(`  [tool] ${message.tool.name} ${cut(JSON.stringify(message.tool.input ?? {}), 300)} -> ${message.tool.ok === false ? "FAILED " : ""}${cut(String(message.tool.output ?? ""), 400).replace(/\n/g, " ")}`);
      else if (message.card || String(message.text ?? "").startsWith("[digest]")) continue;
      else say(`  [${message.role ?? message.kind ?? "message"}] ${cut(String(message.text ?? message.body ?? JSON.stringify(message)), 1500)}${message.attachments?.length ? `\n  [attachments] ${JSON.stringify(message.attachments.map((a: any) => ({ name: a.name, size: a.size ?? a.bytes, type: a.mimeType ?? a.type })))}` : ""}`);
    }
    const after = tree(HOME);
    const changes = [...after].filter(([name, size]) => before.get(name) !== size).map(([name, size]) => `${before.has(name) ? "changed" : "new"} ~/${name}${name.endsWith("/") ? "" : ` (${size} B)`}`);
    say(`  mac side: ${changes.length ? changes.join(", ") : "no file changes"}`);
    const logged = existsSync(macLogFile(HOME)) ? readFileSync(macLogFile(HOME), "utf8").slice(logBefore).trim() : "";
    if (logged) for (const line of logged.split("\n")) say(`  mac log: ${line.replace(/^\S+ /, "")}`);
  }
} catch (error) {
  say(`\nHARNESS ERROR: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
} finally {
  app?.close();
  child.kill("SIGTERM");
  writeFileSync(join(root, "transcript.txt"), out.join("\n"));
  writeFileSync(join(root, "server.log"), log);
  console.log(`\nserver data: ${dataDir}\nserver log: ${join(root, "server.log")}`);
}
