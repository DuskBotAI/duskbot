import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { signPolicy, verifyPolicy } from "../apps/cloud-service/src/update-policy.ts";
import type { FleetAnswer } from "../apps/dashboard/server/admin/ops/fleet.ts";
import { configOf, createRelease, judge, macUpdateSigned, nextPolicy, release, rolloutSteps } from "./release-all.ts";
import { releaseAssets } from "./release-assets.ts";

const { privateKey } = generateKeyPairSync("ed25519");
const signing = `test-rel:${privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url")}`;
const publicKeys = `test-rel:${createPublicKey(privateKey).export({ format: "jwk" }).x}`;
const MIN = 60_000;

const fleetOf = (over: { desktops?: FleetAnswer["desktops"]["versions"]; canary?: FleetAnswer["clouds"]["canary"] } = {}): FleetAnswer =>
  ({ at: 0, desktops: { days: 14, versions: over.desktops ?? [] }, clouds: { versions: [], canary: over.canary ?? [] }, servers: null });
const cloud = (id: string, version: string | null, extra: object = {}) => ({ id, version, trial: null, rolledBack: null, refused: null, stuck: false, ...extra });

describe("the release tool's decisions", () => {
  it("rolls desktops out in growing steps that end at 100, or at once", () => {
    expect(rolloutSteps(undefined, false)).toEqual([10, 50, 100]);
    expect(rolloutSteps("5,100", false)).toEqual([5, 100]);
    expect(rolloutSteps("50,10,100", true)).toEqual([100]);
    expect(() => rolloutSteps("50,10,100", false)).toThrow();
    expect(() => rolloutSteps("10,50", false)).toThrow();
  });

  it("signs each policy past the served serial, keeps the floor and blocks, and drops a finished rollout", () => {
    const served = { serial: 7, floor: "0.2.0", blocked: ["0.2.20"] };
    const staged = nextPolicy(served, 0, { rollout: ["0.2.26", 10] });
    expect(staged).toEqual({ serial: 8, floor: "0.2.0", blocked: ["0.2.20"], rollout: { "0.2.26": 10 } });
    const widened = nextPolicy(staged, 9, { rollout: ["0.2.26", 100] });
    expect(widened).toEqual({ serial: 10, floor: "0.2.0", blocked: ["0.2.20"] });
    expect(nextPolicy(widened, 0, { block: "0.2.26", rollout: ["0.2.26", null] })).toEqual({ serial: 11, floor: "0.2.0", blocked: ["0.2.20", "0.2.26"] });
    expect(nextPolicy(nextPolicy(widened, 0, { paused: true }), 0, { paused: false })).toEqual({ serial: 12, floor: "0.2.0", blocked: ["0.2.20"] });
    expect(nextPolicy({ ...widened, blocked: ["0.2.20", "0.2.26"] }, 0, { unblock: "0.2.26" })).toEqual({ serial: 11, floor: "0.2.0", blocked: ["0.2.20"] });
  });

  it("halts on a canary cloud that rolled the version back or a desktop error spike, and widens only after the watch", () => {
    const base = { version: "0.2.26", canary: ["c1", "c2"], startedAt: 0, watchMs: 30 * MIN, maxWaitMs: 120 * MIN };
    expect(judge(fleetOf({ canary: [cloud("c1", "0.2.25", { rolledBack: "0.2.26" }), cloud("c2", "0.2.26")] }), { ...base, now: MIN }).verdict).toBe("halt");
    expect(judge(fleetOf({ canary: [cloud("c1", "0.2.26", { stuck: true })] }), { ...base, now: MIN }).verdict).toBe("halt");
    const spike = [{ version: "0.2.26", installs: 40, errors: 60, errorInstalls: 12 }, { version: "0.2.25", installs: 400, errors: 80, errorInstalls: 30 }];
    expect(judge(fleetOf({ desktops: spike }), { ...base, canary: [], now: MIN })).toMatchObject({ verdict: "halt" });
    const calm = [{ version: "0.2.26", installs: 40, errors: 10, errorInstalls: 4 }, { version: "0.2.25", installs: 400, errors: 80, errorInstalls: 30 }];
    const through = [cloud("c1", "0.2.26", { trial: "passed" }), cloud("c2", "0.2.25")];
    expect(judge(fleetOf({ desktops: calm, canary: through }), { ...base, now: 10 * MIN }).verdict).toBe("wait");
    expect(judge(fleetOf({ desktops: calm, canary: through }), { ...base, now: 31 * MIN }).verdict).toBe("healthy");
    // few installs say nothing yet about errors
    expect(judge(fleetOf({ desktops: [{ version: "0.2.26", installs: 3, errors: 30, errorInstalls: 3 }], canary: through }), { ...base, now: 31 * MIN }).verdict).toBe("healthy");
    const pending = [cloud("c1", "0.2.26", { trial: "pending" }), cloud("c2", "0.2.25")];
    expect(judge(fleetOf({ canary: pending }), { ...base, now: 31 * MIN }).verdict).toBe("wait");
    expect(judge(fleetOf({ canary: pending }), { ...base, now: 121 * MIN }).verdict).toBe("timeout");
    // a canary still on the version before's trial installs nothing new until it settles: the wait says why
    const onTrial = [cloud("c1", "0.2.25", { trial: "passed" })];
    expect(judge(fleetOf({ canary: onTrial }), { ...base, canary: ["c1"], now: 31 * MIN })).toEqual({ verdict: "wait",
      why: "no canary cloud is through its self-test yet; c1 is still on its 0.2.25 update trial, and takes 0.2.26 only once that settles (2 runs or 24 h after its install)" });
    expect(judge(fleetOf({ canary: onTrial }), { ...base, canary: ["c1"], now: 121 * MIN }).why).toMatch(/^no canary cloud took 0\.2\.26; c1 is still on its 0\.2\.25 update trial/);
  });

  it("reads errors from one or two installs against a version before that sent none as those installs, not a spread", () => {
    const base = { version: "0.2.29", canary: [], startedAt: 0, now: MIN, watchMs: 30 * MIN, maxWaitMs: 120 * MIN };
    const quiet = { version: "0.2.28", installs: 300, errors: 0, errorInstalls: 0 };
    expect(judge(fleetOf({ desktops: [{ version: "0.2.29", installs: 25, errors: 12, errorInstalls: 2 }, quiet] }), base).verdict).toBe("wait");
    expect(judge(fleetOf({ desktops: [{ version: "0.2.29", installs: 25, errors: 12, errorInstalls: 2 }] }), base).verdict).toBe("wait");
    expect(judge(fleetOf({ desktops: [{ version: "0.2.29", installs: 25, errors: 12, errorInstalls: 3 }, quiet] }), base)).toMatchObject({ verdict: "halt" });
    const noisy = { version: "0.2.28", installs: 300, errors: 3, errorInstalls: 3 };
    expect(judge(fleetOf({ desktops: [{ version: "0.2.29", installs: 25, errors: 12, errorInstalls: 2 }, noisy] }), base)).toMatchObject({ verdict: "halt" });
    // a fleet view from before errorInstalls was counted judges by the ratio alone
    const { errorInstalls: _, ...older } = { version: "0.2.29", installs: 25, errors: 12, errorInstalls: 2 };
    expect(judge(fleetOf({ desktops: [older as never, quiet] }), base)).toMatchObject({ verdict: "halt" });
  });
});

describe("a release run", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  function world(o: { codesign?: string; fleet: () => FleetAnswer; served?: { serial: number; floor: string | null; blocked: string[] } }) {
    const stateDir = mkdtempSync(join(tmpdir(), "dusk-release-all-")); dirs.push(stateDir);
    const ran: string[] = [], placed: Array<{ to: string; text: string }> = [];
    let policyDoc: string | null = o.served ? JSON.stringify(signPolicy(o.served, signing)) : null, clock = 1_000_000;
    const env = { DUSK_RELEASE_SIGNING_KEY: signing, DUSK_RELEASE_PUBLIC_KEYS: publicKeys, DUSK_OPS_TOKEN: "o".repeat(32) };
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/v1/updates/policy")) return policyDoc ? new Response(policyDoc) : new Response("{}", { status: 404 });
      if (url.includes("/v1/ops/fleet")) return new Response(JSON.stringify(o.fleet()));
      if (url.endsWith("/releases/latest.json")) return new Response(JSON.stringify({ version: "0.2.26" }));
      if (url.endsWith("/v1/release")) return new Response(JSON.stringify({ v: 1, agent: { version: "9.9.9" } }));
      return new Response("no", { status: 404 });
    }) as unknown as typeof fetch;
    const sh = (cmd: string, args: string[], input?: string) => {
      const line = `${cmd} ${args.join(" ")}`;
      ran.push(line);
      if (cmd === "git" && args[0] === "rev-parse") return "c".repeat(40);
      if (cmd === "git" && args[0] === "status") return "";
      if (cmd === "sh" && args[1]?.includes("codesign")) return o.codesign ?? "Authority=Developer ID Application: Siddharth Meena (S85QBF7KWC)\nTeamIdentifier=S85QBF7KWC";
      if (cmd === "gh" && args[0] === "release") return JSON.stringify({ assets: releaseAssets("0.2.26").map(a => ({ name: a.name })) });
      if (cmd === "ssh" && input !== undefined) {
        const to = /mv -f '[^']+' '([^']+)'/.exec(args.at(-1)!)![1]!;
        placed.push({ to, text: input });
        if (to.endsWith("home/update-policy.json")) policyDoc = input;
      }
      return "";
    };
    const changelogFile = join(stateDir, "changelog.json");
    writeFileSync(changelogFile, JSON.stringify({ v: 1, releases: [{ version: "0.2.26", date: "2026-11-21", items: [] }] }));
    const r = createRelease({ cfg: configOf({}), env, dryRun: false, fetchImpl, sh, now: () => (clock += MIN), sleep: async () => {}, log: () => {}, stateDir, siteDir: stateDir, changelogFile });
    return { r, ran, placed, stateDir, policy: () => verifyPolicy(JSON.parse(policyDoc!), [{ kid: "test-rel", x: publicKeys.split(":")[1]! }]) };
  }
  const options = { version: "0.2.26", now: false, canary: ["c1"], steps: [10, 100], watchMs: 5 * MIN, maxWaitMs: 20 * MIN, skipBuild: true, dryRun: false, pollMs: 0 };

  it("reads an ad-hoc Mac build as unsigned and a release team Developer ID build as signed", () => {
    expect(macUpdateSigned("Identifier=bot.dusk.app\nSignature=adhoc\nTeamIdentifier=not set")).toBe(false);
    expect(macUpdateSigned("Authority=Developer ID Application: Someone Else (ABCDE12345)\nTeamIdentifier=ABCDE12345")).toBe(false);
    expect(macUpdateSigned("Authority=Developer ID Application: Siddharth Meena (S85QBF7KWC)\nTeamIdentifier=S85QBF7KWC")).toBe(true);
  });

  it("refuses to offer a release whose Mac update zips are ad-hoc signed, before any desktop gets it", async () => {
    const w = world({ codesign: "Signature=adhoc\nTeamIdentifier=not set", fleet: () => fleetOf(), served: { serial: 3, floor: null, blocked: [] } });
    await expect(release(w.r, options)).rejects.toThrow(/DuskBot-0\.2\.26-arm64\.zip is not signed by Developer ID/);
    expect(w.ran.some(line => line.includes("publish-downloads"))).toBe(false);
    expect(w.placed.length).toBe(0);
  });

  it("halts and blocks the version everywhere when the canary cloud rolls it back, and a rerun stays halted", async () => {
    const w = world({ fleet: () => fleetOf({ canary: [cloud("c1", "0.2.25", { rolledBack: "0.2.26" })] }), served: { serial: 3, floor: null, blocked: [] } });
    // the cloud package step needs a built package; stand one in
    const pkgDir = join(process.cwd(), "release", "home");
    const made = !existsSync(join(pkgDir, "omb-home.tgz"));
    if (made) { mkdirSync(pkgDir, { recursive: true }); writeFileSync(join(pkgDir, "omb-home.tgz"), "home package"); }
    try {
      expect(await release(w.r, options)).toBe("halted");
      expect(w.policy()).toMatchObject({ blocked: ["0.2.26"] });
      expect(w.policy().rollout).toBeUndefined();
      const releaseFile = w.placed.find(p => p.to.endsWith("home/release.json"))!;
      expect(JSON.parse(releaseFile.text)).toMatchObject({ version: "0.2.26", clouds: ["c1"], file: "/var/lib/dusk-account-prod/home/omb-home-0.2.26.tgz" });
      expect(w.placed.filter(p => p.to.endsWith("update-policy.json")).map(p => p.to)).toEqual(expect.arrayContaining(["/var/lib/dusk-account-prod/home/update-policy.json", "/root/omb-link-data/packages/update-policy.json"]));
      expect(w.ran.some(line => line.includes("build-vps-package"))).toBe(false);
      const state = JSON.parse(readFileSync(w.r.stateFile("0.2.26"), "utf8"));
      expect(state.halted).toMatch(/rolled 0.2.26 back/);
      expect(await release(w.r, options)).toBe("halted");
    } finally {
      if (made) rmSync(join(pkgDir, "omb-home.tgz"));
    }
  });

  it("widens to every cloud and desktop after a healthy canary, and a rerun skips what is done", async () => {
    const healthy = () => fleetOf({ canary: [cloud("c1", "0.2.26", { trial: "passed" })] });
    const w = world({ fleet: healthy, served: { serial: 3, floor: null, blocked: [] } });
    const pkgDir = join(process.cwd(), "release", "home");
    const made = !existsSync(join(pkgDir, "omb-home.tgz"));
    if (made) { mkdirSync(pkgDir, { recursive: true }); writeFileSync(join(pkgDir, "omb-home.tgz"), "home package"); }
    try {
      await expect(release(w.r, options)).rejects.toThrow(/manifest\.json|ENOENT|not signed/);
      const releases = w.placed.filter(p => p.to.endsWith("home/release.json")).map(p => JSON.parse(p.text));
      expect(releases.at(-1)).not.toHaveProperty("clouds");
      expect(w.policy().rollout).toBeUndefined();
      expect(w.policy().serial).toBe(5);
      const state = JSON.parse(readFileSync(w.r.stateFile("0.2.26"), "utf8"));
      expect(Object.keys(state.done)).toEqual(["preflight", "github-files", "mac-signature", "desktop-rollout", "desktop", "cloud-package", "canary", "cloud-widen", "desktop-100"]);
      const before = w.ran.length;
      await expect(release(w.r, options)).rejects.toThrow();
      expect(w.ran.slice(before).some(line => line.includes("build-home-package"))).toBe(false);
    } finally {
      if (made) rmSync(join(pkgDir, "omb-home.tgz"));
    }
  });
  it("stops at preflight when the version is not tagged yet, and a dry run says so and goes on", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "dusk-release-all-")); dirs.push(stateDir);
    const sh = (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse" && args.at(-1)!.startsWith("v")) throw new Error("unknown revision");
      return cmd === "git" && args[0] === "rev-parse" ? "c".repeat(40) : "";
    };
    const fetchImpl = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    const real = createRelease({ cfg: configOf({}), env: {}, dryRun: false, fetchImpl, sh, log: () => {}, stateDir });
    await expect(release(real, options)).rejects.toThrow(/there is no tag v0\.2\.26/);
    const lines: string[] = [];
    const dry = createRelease({ cfg: configOf({}), env: {}, dryRun: true, fetchImpl, sh, log: line => lines.push(line), stateDir });
    await release(dry, { ...options, now: true, steps: [100], dryRun: true });
    expect(lines).toContain("  (dry run) there is no tag v0.2.26");
    expect(lines).toContain("- desktop");
  });

  it("refuses a release whose changelog entry or GitHub files are missing, and a dry run lists every file it lacks", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "dusk-release-all-")); dirs.push(stateDir);
    const changelogFile = join(stateDir, "changelog.json");
    writeFileSync(changelogFile, JSON.stringify({ v: 1, releases: [{ version: "0.2.25", date: "x", items: [] }] }));
    const desktopOnly = releaseAssets("0.2.26").filter(a => a.kind !== "cli" && a.kind !== "android").map(a => ({ name: a.name }));
    const sh = (cmd: string, args: string[]) => cmd === "gh" ? JSON.stringify({ assets: desktopOnly }) : cmd === "git" && args[0] === "rev-parse" ? "c".repeat(40) : "";
    const fetchImpl = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    const env = { DUSK_RELEASE_SIGNING_KEY: signing, DUSK_RELEASE_PUBLIC_KEYS: publicKeys };
    const real = createRelease({ cfg: configOf({}), env, dryRun: false, fetchImpl, sh, log: () => {}, stateDir, changelogFile });
    await expect(release(real, options)).rejects.toThrow(/changelog\.json has no 0\.2\.26 entry/);
    writeFileSync(changelogFile, JSON.stringify({ v: 1, releases: [{ version: "0.2.26", date: "x", items: [] }] }));
    await expect(release(real, options)).rejects.toThrow(/lacks DuskBot\.apk, duskbot\.tgz, duskbot-0\.2\.26\.tgz/);
    const lines: string[] = [];
    rmSync(real.stateFile("0.2.26"), { force: true });
    const dry = createRelease({ cfg: configOf({}), env: {}, dryRun: true, fetchImpl, sh, log: line => lines.push(line), stateDir, changelogFile });
    await release(dry, { ...options, now: true, steps: [100], dryRun: true });
    expect(lines.filter(l => l.includes("MISSING")).map(l => l.trim().split(/\s+/)[1])).toEqual(["DuskBot.apk", "duskbot.tgz", "duskbot-0.2.26.tgz"]);
  });
});
