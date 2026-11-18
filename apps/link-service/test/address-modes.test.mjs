// the ways a server is reached, chosen on the one line (`| sh -s -- --tailscale`): what the installer accepts, what it
// writes for the agent, what the agent tells the app, and what the link service lets through to the app
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { currentAddress, sealKeyOf, x25519Pair } from "../agent.mjs";
import { newLinkKeys, openResult, seal } from "../../../electron/vps-link-protocol.mjs";
import { installerAsk } from "../src/app.mjs";

const run = promisify(execFile);
const script = (await readFile(new URL("../install.sh", import.meta.url), "utf8")).replace(/\nmain "\$@"\s*$/, "\n");

async function sourced(body, args = [], shell = "sh") {
  const dir = await mkdtemp(join(tmpdir(), "omb-ways-"));
  try {
    const file = join(dir, "fixture.sh");
    await writeFile(file, `${script}
STATE=${dir}/state ADDRESS=${dir}/address.json UNITS=${dir}/units
mkdir -p "$STATE" "$UNITS"
${body}
`);
    const out = await run(shell, [file, ...args], { env: { PATH: "/usr/bin:/bin", TERM: "dumb" } }).then((done) => done, (error) => error);
    let address = null;
    try { address = JSON.parse(await readFile(join(dir, "address.json"), "utf8")); } catch { /* none written */ }
    return { stdout: out.stdout, stderr: out.stderr, code: out.code ?? 0, address };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const parsed = (args) => sourced('parse_ways "$@"; printf "%s|%s\\n" "$WANT" "$ARGS_WANT"', ["abcdefghij-abcdefghijklmnopqrstuvwxyz", ...args]);

describe("the line's way", () => {
  it("takes each way after the token", async () => {
    expect((await parsed([])).stdout.trim()).toBe("|");
    expect((await parsed(["--tailscale"])).stdout.trim()).toBe("tailscale|tailscale");
    expect((await parsed(["--cloudflare"])).stdout.trim()).toBe("cloudflare|cloudflare");
    expect((await parsed(["--ssh"])).stdout.trim()).toBe("ssh|ssh");
    expect((await parsed(["--relay"])).stdout.trim()).toBe("relay|relay");
  });

  it("turns an old line's own-domain, direct or token way into a Cloudflare tunnel, with a note, not an error", async () => {
    for (const args of [["--domain", "bots.example.com"], ["--domain=bots.example.com"], ["--direct"], ["--cloudflare-token", "tok", "--domain", "b.example.com"]]) {
      const out = await parsed(args);
      expect(out.code).toBe(0);
      expect(out.stdout.trim()).toBe("cloudflare|cloudflare");
      expect(out.stderr).toContain("is no longer offered; using a Cloudflare tunnel instead.");
    }
    // a way named on the same line wins
    expect((await parsed(["--tailscale", "--domain", "a.example.com"])).stdout.trim()).toBe("tailscale|tailscale");
    expect((await parsed(["--direct", "--relay"])).stdout.trim()).toBe("relay|relay");
  });

  it("hands the way on to root's run of the script, keys never on the command line", async () => {
    const args = (list) => sourced('parse_ways "$@"; way_args', ["abcdefghij-abcdefghijklmnopqrstuvwxyz", ...list]);
    expect((await args(["--tailscale", "--tailscale-key", "tskey-secret"])).stdout).toBe("--tailscale");
    expect((await args(["--cloudflare"])).stdout).toBe("--cloudflare");
    expect((await args(["--domain", "bots.example.com"])).stdout).toBe("--cloudflare");
    expect((await args([])).stdout).toBe("");
  });

  it("refuses what it does not know, before doing anything", async () => {
    const unknown = await parsed(["--tailscal"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("Unknown option --tailscal");
  });

  it("writes the address the agent reads: not pinned for a quick tunnel, whose name it looks up", async () => {
    const quick = await sourced("use_address direct cloudflare abc-def.trycloudflare.com 0");
    expect(quick.address).toEqual({ v: 1, mode: "direct", via: "cloudflare", host: "abc-def.trycloudflare.com", pin: false, quick: "http://127.0.0.1:20241/quicktunnel" });
    const relay = await sourced("WANT=ssh; relay_address");
    expect(relay.address).toMatchObject({ mode: "relay", via: "ssh" });
  });

  it("names a public address to the server only where it stays put", async () => {
    const unit = (via, named = "") => sourced(`TMP=$STATE; HARDENING=; NAME=box; put_file() { cat "$TMP/new"; }; state_set mode direct; state_set host h.example.com; state_set via ${via}; state_set cf-named "${named}"; server_unit`);
    expect((await unit("tailscale")).stdout).toContain("--public-url https://h.example.com");
    expect((await unit("cloudflare")).stdout).not.toContain("--public-url");
    expect((await unit("cloudflare", "1")).stdout).toContain("--public-url https://h.example.com");
  });
});

// debian and ubuntu run the line with dash, whose subshells keep set -e
const dash = ["/bin/dash", "/usr/bin/dash"].find((path) => existsSync(path));
describe("a wait for the person (tailscale's sign-in and https)", () => {
  it.skipIf(!dash)("ends as soon as the command fails, under the step's set -e, not when the wait runs out", async () => {
    const started = Date.now();
    const out = await sourced('set -e; TMP=$STATE; redact() { cat; }; ask() { cat >/dev/null; }\n'
      + 'if ts_with_link tailscale-login 30 "x" "words" -- sh -c "exit 3"; then echo ok; else echo gave-up; fi', [], dash);
    expect(out.stdout.trim()).toBe("gave-up");
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe.skipIf(!dash || !existsSync("/usr/bin/node"))("tailnet https port 443", () => {
  const ours = '{"TCP":{"443":{"HTTPS":true}},"Web":{"box.tail1.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8799"}}}}}';
  const other = '{"TCP":{"443":{"HTTPS":true}},"Web":{"box.tail1.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}}}';
  const forwarded = '{"TCP":{"443":{"TCPForward":"127.0.0.1:5432"}}}';
  const address = (status) => sourced(`TMP=$STATE; PORT=8799; WANT=tailscale; redact() { cat; }; ask_clear() { :; }; restart_for_address() { :; }
tailscale_install() { :; }; tailscale_daemon() { :; }; ts_field() { [ "$1" = DNSName ] && echo box.tail1.ts.net || echo Running; }
ts() { if [ "$1 $2" = "serve status" ]; then printf '%s' '${status}'; fi; }
ts_with_link() { shift 3; while [ "$1" != -- ]; do shift; done; shift; echo "serve-call: $*"; }
manifest_add() { echo "manifest: $1"; }
address_tailscale && echo rc=0 || echo "rc=$?"`, [], dash);

  it("serves it when nothing holds it", async () => {
    for (const status of ["{}", "", "not json"]) {
      const out = await address(status);
      expect(out.stdout).toContain("serve-call: ts serve --bg --https=443 http://127.0.0.1:8799");
      expect(out.stdout).toContain("manifest: tailscale-serve 443");
      expect(out.address).toMatchObject({ via: "tailscale", host: "box.tail1.ts.net" });
    }
  });

  it("serves it again when it already proxies to this server", async () => {
    const out = await address(ours);
    expect(out.stdout).toContain("serve-call: ts serve --bg --https=443 http://127.0.0.1:8799");
    expect(out.address).toMatchObject({ via: "tailscale" });
  });

  it("leaves another service on it alone and uses the private relay", async () => {
    for (const status of [other, forwarded]) {
      const out = await address(status);
      expect(out.stdout).not.toContain("serve-call");
      expect(out.stdout).not.toContain("manifest:");
      expect(out.stdout).toContain("already serves something else");
      expect(out.stdout).toContain("rc=11");
      expect(out.address).toMatchObject({ mode: "relay" });
    }
  });

  it("is turned off on uninstall only while it still proxies to this server", async () => {
    const uninstall = (await readFile(new URL("../uninstall.sh", import.meta.url), "utf8")).replace(/\nmain "\$@"\s*$/, "\n");
    const dir = await mkdtemp(join(tmpdir(), "omb-ways-"));
    try {
      const holds = async (status) => {
        const file = join(dir, "fixture.sh");
        await writeFile(file, `${uninstall}\ntailscale() { printf '%s' '${status}'; }\nts_443_ours && echo ours || echo not\n`);
        return (await run(dash, [file], { env: { PATH: "/usr/bin:/bin", TERM: "dumb" } })).stdout.trim();
      };
      expect(await holds(ours)).toBe("ours");
      for (const status of [other, forwarded, "{}", "not json"]) expect(await holds(status)).toBe("not");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the agent's word on where its server is", () => {
  const read = (value) => () => JSON.stringify(value);
  it("reads the relay, a pinned address with its key, and a quick tunnel's current name", async () => {
    expect(await currentAddress({ read: read({ v: 1, mode: "relay", via: "ssh", host: "" }) })).toEqual({ mode: "relay", via: "ssh", origin: null, spki: null });
    expect(await currentAddress({ read: read({ v: 1, mode: "direct", via: "domain", host: "bots.example.com", pin: true }), spki: async () => "k".repeat(43) + "=" }))
      .toEqual({ mode: "direct", via: "domain", origin: "https://bots.example.com", spki: "k".repeat(43) + "=" });
    expect(await currentAddress({ read: read({ v: 1, mode: "direct", via: "cloudflare", host: "old.trycloudflare.com", pin: false, quick: "http://127.0.0.1:20241/quicktunnel" }), quick: async () => "new-one.trycloudflare.com" }))
      .toEqual({ mode: "direct", via: "cloudflare", origin: "https://new-one.trycloudflare.com", spki: null });
  });

  it("says nothing rather than an address without the pin it needs, or one it cannot read", async () => {
    expect(await currentAddress({ read: read({ v: 1, mode: "direct", via: "direct", host: "1-2-3-4.sslip.io", pin: true }), spki: async () => { throw new Error("down"); } })).toBeNull();
    expect(await currentAddress({ read: () => { throw new Error("ENOENT"); } })).toBeNull();
    expect(await currentAddress({ read: read({ v: 1, mode: "direct", via: "domain", host: "bad host", pin: false }) })).toBeNull();
  });
});

describe("what the installer may ask the app to show", () => {
  it("passes sign-in links only on the provider's own host, and records, ports and ssh as plain values", () => {
    expect(installerAsk({ kind: "tailscale-login", url: "https://login.tailscale.com/a/abc123" })).toEqual({ kind: "tailscale-login", url: "https://login.tailscale.com/a/abc123", state: "waiting" });
    expect(installerAsk({ kind: "tailscale-login", url: "https://login.tailscale.com.evil.example/a" })).toBeUndefined();
    expect(installerAsk({ kind: "cloudflare-login", url: "http://dash.cloudflare.com/argotunnel" })).toBeUndefined();
    expect(installerAsk({ kind: "dns", host: "bots.example.com", type: "A", value: "203.0.113.7", state: "found" })).toEqual({ kind: "dns", host: "bots.example.com", type: "A", value: "203.0.113.7", state: "found" });
    expect(installerAsk({ kind: "dns", host: "bots.example.com", type: "TXT", value: "x" })).toBeUndefined();
    expect(installerAsk({ kind: "ssh", user: "ubuntu", host: "203.0.113.7", state: "done" })).toMatchObject({ kind: "ssh", user: "ubuntu" });
    expect(installerAsk({ kind: "ssh", user: "a;rm -rf /", host: "203.0.113.7" })).toBeUndefined();
    expect(installerAsk({ kind: "none" })).toEqual({ kind: "none" });
    expect(installerAsk({ kind: "anything" })).toBeUndefined();
  });
});

describe("the sealed result the app opens", () => {
  const sealed = (fields) => {
    const app = newLinkKeys(), vps = x25519Pair(), id = "abcdefghij";
    const body = { v: 1, name: "box", pairing: { code: "ABCD-2345-EFGH" }, tunnel: { id, key: "k", token: "t" }, ...fields };
    return () => openResult({ id, priv: app.priv, pub: app.pub, vpsPub: vps.pub, sealed: seal(sealKeyOf(vps.priv, vps.pub, app.pub, id), id, Buffer.from(JSON.stringify(body))) });
  };
  it("takes an unpinned address only from tailscale or cloudflare, which hold their own certificates", () => {
    expect(sealed({ mode: "direct", via: "tailscale", origin: "https://box.tail1.ts.net", spki: null })()).toMatchObject({ via: "tailscale" });
    expect(sealed({ mode: "direct", via: "cloudflare", origin: "https://a-b.trycloudflare.com", spki: null })()).toMatchObject({ via: "cloudflare" });
    expect(sealed({ mode: "direct", via: "domain", origin: "https://bots.example.com", spki: null })).toThrow(/not one this app understands/);
    expect(sealed({ mode: "direct", via: "direct", origin: "https://1-2-3-4.sslip.io", spki: "k".repeat(43) + "=" })()).toMatchObject({ via: "direct" });
  });
});
