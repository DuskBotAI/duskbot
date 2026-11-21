// Google's official Antigravity CLI release channel and pinned 1.5.13 baseline.
//
// Manifest parsing and target mapping adapted from pingdotgg/t3code (MIT License,
// Copyright (c) 2026 T3 Tools Inc., full text in third_party/t3-code/LICENSE),
// apps/server/src/provider/antigravityCliRelease.ts.
import { existsSync } from "node:fs";

export const ANTIGRAVITY_CLI_MANIFEST_BASE =
  "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";

export const ANTIGRAVITY_RELEASE_VERSION = "1.5.13";

export interface AntigravityReleaseAsset {
  version: string;
  url: string;
  sha512: string;
  archiveBytes?: number;
  executable: { name: string };
  format: "tar.gz" | "executable";
}

const MANIFEST_TIMEOUT_MS = 10_000;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const SHA512_PATTERN = /^[a-fA-F0-9]{128}$/u;

export function isMuslLinux(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  if (platform !== "linux") return false;
  return existsSync(arch === "arm64" ? "/lib/libc.musl-aarch64.so.1" : "/lib/libc.musl-x86_64.so.1");
}

export function antigravityCliTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl = isMuslLinux(platform, arch),
): string | null {
  if (!["darwin", "linux", "win32"].includes(platform) || !["x64", "arm64"].includes(arch)) {
    return null;
  }
  const os = platform === "win32" ? "windows" : platform;
  return `${os}_${arch === "x64" ? "amd64" : arch}${platform === "linux" && musl ? "_musl" : ""}`;
}

export function parseAntigravityCliRelease(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl = isMuslLinux(platform, arch),
): AntigravityReleaseAsset | null {
  if (!value || typeof value !== "object") return null;
  const manifest = value as { version?: unknown; url?: unknown; sha512?: unknown };
  if (
    typeof manifest.version !== "string" || !VERSION_PATTERN.test(manifest.version) ||
    typeof manifest.url !== "string" ||
    typeof manifest.sha512 !== "string" || !SHA512_PATTERN.test(manifest.sha512) ||
    antigravityCliTarget(platform, arch, musl) === null
  ) {
    return null;
  }
  const os = platform === "darwin" ? "mac" : platform === "win32" ? "windows" : "linux";
  const cpu = arch === "x64" ? "x64" : "arm64";
  const suffix = platform === "linux" && musl ? "_musl" : "";
  const extension = platform === "win32" ? "exe" : "tar.gz";
  const folder = `${platform === "win32" ? "windows" : platform}-${arch === "arm64" ? "arm" : "x64"}${suffix ? "-musl" : ""}`;
  const prefix = `https://storage.googleapis.com/antigravity-public/antigravity-cli/${manifest.version}-`;
  const rest = manifest.url.startsWith(prefix) ? manifest.url.slice(prefix.length) : "";
  if (
    !/^\d+\//u.test(rest) ||
    rest.replace(/^\d+\//u, "") !== `${folder}/cli_${os}_${cpu}${suffix}.${extension}`
  ) {
    return null;
  }
  return {
    version: manifest.version,
    url: manifest.url,
    sha512: manifest.sha512.toLowerCase(),
    executable: { name: platform === "win32" ? "agy.exe" : "antigravity" },
    format: platform === "win32" ? "executable" : "tar.gz",
  };
}

// Baseline captured from Google's official CLI manifests on 2026-11-20 for synchronous
// download size display and fallback when the auto-updater manifest endpoint is unreachable.
const PINNED_RELEASES = new Map<string, AntigravityReleaseAsset>([
  [
    "darwin_arm64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.13-5999302598852608/darwin-arm/cli_mac_arm64.tar.gz",
      sha512: "d9825ebce6954df6b7841970fd7ef3d37acdfe628993f14c396ec73b20ed06bbe95e7b7be047e7c0b0baaf009f75fe95ce051b9f4af5e84b002da15bda4a1f45",
      archiveBytes: 85_497_754,
      executable: { name: "antigravity" },
      format: "tar.gz",
    },
  ],
  [
    "darwin_amd64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.13-5999302598852608/darwin-x64/cli_mac_x64.tar.gz",
      sha512: "6a7087eb847029bead89d496a6c4a5d3ec8552f351a486b3917948fee2a9a72ec6e2be7eae866b975b8ed3fc2a1827cf176b5bd45d6eb9970424fec4352d3930",
      archiveBytes: 91_068_379,
      executable: { name: "antigravity" },
      format: "tar.gz",
    },
  ],
  [
    "linux_amd64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.13-5999302598852608/linux-x64/cli_linux_x64.tar.gz",
      sha512: "014b37387703acab1f47cd532c8bb60167a6a3537b0f9891de03f1b1ffa9614307bc83c4b2f7551273b0877d722716b0cd9e26782f6b2a50705db4f05e18c68f",
      archiveBytes: 100_548_668,
      executable: { name: "antigravity" },
      format: "tar.gz",
    },
  ],
  [
    "linux_arm64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.13-5999302598852608/linux-arm/cli_linux_arm64.tar.gz",
      sha512: "dccea2eb455099f5175f0c87cc47b38fcefe4cb0cb44dea3927469bb4bbf68ac3c0b30fc04affb24c17e90959386a93c3785e8e4b8b1a3338ca4e4d57b80057b",
      archiveBytes: 91_596_782,
      executable: { name: "antigravity" },
      format: "tar.gz",
    },
  ],
  [
    "linux_amd64_musl",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.13-5999302598852608/linux-x64-musl/cli_linux_x64_musl.tar.gz",
      sha512: "d84889054ba7230b34c1f8107df23a533813352831613712d59b84be0f57ee6d2f4deec338eec1c6094e7ebe4c8de10712f0ede9c889c4c12b95ca3dc2c4f546",
      archiveBytes: 92_948_686,
      executable: { name: "antigravity" },
      format: "tar.gz",
    },
  ],
  [
    "linux_arm64_musl",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.13-5999302598852608/linux-arm-musl/cli_linux_arm64_musl.tar.gz",
      sha512: "0bdb2f2202f25a2d3fa63ac871ed1ad7c5e72b19f63ceca1ec9a5e848859c6110ba05651ee20d1dd012cbf4d50ed16d59e6c7684bc097d7a72484bffb95b17da",
      archiveBytes: 87_414_748,
      executable: { name: "antigravity" },
      format: "tar.gz",
    },
  ],
  [
    "windows_amd64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.13-5999302598852608/windows-x64/cli_windows_x64.exe",
      sha512: "6b80a17a2bc34a969ed9ba31500a8201b0b4aad3e7fe061374022d161fec8bd7de49b6dc069a6ac67a90632e8671bbe860a7e94309bc5adbc536d27a75a86b58",
      archiveBytes: 236_040_344,
      executable: { name: "agy.exe" },
      format: "executable",
    },
  ],
  [
    "windows_arm64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.13-5999302598852608/windows-arm/cli_windows_arm64.exe",
      sha512: "c85686d6ae68d4566f86af0c240e4b49a303549ae152757546878193f25a263b02c4d8f1d5030631dc93646a298dcb02713c18e7850390e3db5c9dda6c31265f",
      archiveBytes: 224_102_040,
      executable: { name: "agy.exe" },
      format: "executable",
    },
  ],
]);

export function resolveAntigravityReleaseAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl = isMuslLinux(platform, arch),
): AntigravityReleaseAsset | null {
  const target = antigravityCliTarget(platform, arch, musl);
  return target ? PINNED_RELEASES.get(target) ?? null : null;
}

function compareSemver(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function fetchAntigravityCliRelease(options: {
  platform?: NodeJS.Platform;
  arch?: string;
  musl?: boolean;
  fetchImpl?: typeof fetch;
} = {}): Promise<AntigravityReleaseAsset | null> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const musl = options.musl ?? isMuslLinux(platform, arch);
  const target = antigravityCliTarget(platform, arch, musl);
  if (!target) return null;
  const pinned = PINNED_RELEASES.get(target) ?? null;
  try {
    const response = await (options.fetchImpl ?? fetch)(`${ANTIGRAVITY_CLI_MANIFEST_BASE}/${target}.json`, {
      redirect: "error",
      signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
    });
    if (!response.ok) return pinned;
    const parsed = parseAntigravityCliRelease(await response.json(), platform, arch, musl);
    if (!parsed) return pinned;
    if (pinned && compareSemver(parsed.version, pinned.version) < 0) return pinned;
    return parsed.sha512 === pinned?.sha512 ? pinned : parsed;
  } catch {
    return pinned;
  }
}
