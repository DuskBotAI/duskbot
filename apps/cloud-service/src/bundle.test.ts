import { expect, it } from "vitest";
import { makeTar } from "./backups.ts";
import { bundleMismatches, checkLines, layerOf, openBundle, sealBundle, volumeManifest } from "./bundle.ts";
import { PLATFORM_ENTRIES } from "./home.ts";

const CLOUD = `c${"a".repeat(24)}`;
const volume = (prefix: string, extra: Array<{ name: string; data: string }> = []) => makeTar([
  { name: `${prefix}.omb-cloud-home.json`, data: JSON.stringify({ version: 1, machine: CLOUD }) },
  { name: `${prefix}.openmausbot/bots.json`, data: "[{\"id\":\"b1\"}]" },
  { name: `${prefix}.openmausbot/messages.db`, data: "chats" },
  { name: `${prefix}.openmausbot/workspaces/b1/MEMORY.md`, data: "remembers" },
  { name: `${prefix}.openmausbot/routines.json`, data: "[]" },
  { name: `${prefix}.openmausbot/mcp-oauth.json`, data: "{\"token\":\"secret\"}" },
  { name: `${prefix}.openmausbot/agent-browser-profiles/b1/Default/Cookies`, data: "cookie" },
  { name: `${prefix}.openmausbot/dashboard-link.json`, data: "{}" },
  { name: `${prefix}.openmausbot/phone-relay.json`, data: "{}" },
  { name: `${prefix}.openmausbot/tmp/x`, data: "scratch" },
  { name: `${prefix}.claude/.credentials.json`, data: "engine" },
  ...extra,
]);

it("sorts a volume into the layers of home-data.md and hashes every file", () => {
  for (const prefix of ["data/"]) {
    const m = volumeManifest(volume(prefix), CLOUD, { kind: "managed", host: "instabox" }, 1);
    expect(m.files.map(f => [f.path, f.layer])).toEqual(expect.arrayContaining([
      [".omb-cloud-home.json", "marker"], [".openmausbot/bots.json", "identity"], [".openmausbot/messages.db", "chats"], [".openmausbot/workspaces/b1/MEMORY.md", "memory"],
      [".openmausbot/routines.json", "routines"], [".openmausbot/mcp-oauth.json", "credentials"], [".openmausbot/agent-browser-profiles/b1/Default/Cookies", "browser"],
      [".openmausbot/dashboard-link.json", "machine"], [".openmausbot/phone-relay.json", "machine"], [".openmausbot/tmp/x", "disposable"], [".claude/.credentials.json", "engines"],
    ]));
    expect(m.layers.browser).toEqual({ files: 1, bytes: 6 });
    expect(m.files.every(f => /^[a-f0-9]{64}$/.test(f.sha256))).toBe(true);
  }
  expect(() => volumeManifest(makeTar([{ name: "data/x", data: "y" }]), CLOUD, { kind: "managed" })).toThrow("no marker");
  expect(() => volumeManifest(volume("data/"), `c${"b".repeat(24)}`, { kind: "managed" })).toThrow("Another cloud");
  expect(layerOf("somewhere/else")).toBe("other");
});

it("checks the restored volume but never the machine's own identity or what the target keeps for itself", () => {
  const m = volumeManifest(volume("data/", [{ name: "data/home/user-file", data: "platform" }, { name: "data/odd\nname", data: "x" }]), CLOUD, { kind: "managed" });
  const { text, checked, skipped } = checkLines(m, { keep: PLATFORM_ENTRIES });
  expect(text).toContain("  /data/.openmausbot/bots.json\n");
  expect(text).not.toContain("dashboard-link.json");
  expect(text).not.toContain("/data/home/");
  expect(skipped).toBe(1);
  expect(checked).toBe(text.trim().split("\n").length);
});

it("seals a bundle under a passphrase, refuses a wrong one or a changed byte, and spots a changed file", () => {
  const tar = volume("data/");
  const m = volumeManifest(tar, CLOUD, { kind: "mac" });
  const sealed = sealBundle(m, tar, "correct horse battery");
  expect(sealed.includes(Buffer.from("secret"))).toBe(false);
  const opened = openBundle(sealed, "correct horse battery");
  expect(opened.tar.equals(tar)).toBe(true);
  expect(opened.manifest.files).toHaveLength(m.files.length);
  expect(() => openBundle(sealed, "wrong horse battery")).toThrow("does not open");
  const flipped = Buffer.from(sealed); flipped[flipped.length - 40] ^= 1;
  expect(() => openBundle(flipped, "correct horse battery")).toThrow("does not open");
  expect(() => sealBundle(m, tar, "short")).toThrow("12 characters");
  expect(bundleMismatches(m, volume("data/", [{ name: "data/.openmausbot/bots.json", data: "[]" }]))).toEqual([".openmausbot/bots.json"]);
});
