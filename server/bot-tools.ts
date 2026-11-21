// The tools a bot's boxed shell needs for everyday work (documents, data, charts, images, media), which it cannot
// install itself: the box mounts /usr read-only. The cloud-home Docker image bakes them in; a dusk cloud installed
// natively on its machine gets them from the root supervisor, once per version of these lists, in the background
// after the home is already serving.
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";

export const BOT_APT_PACKAGES = [
  "python3-pip", "python3-venv", "python-is-python3", "poppler-utils", "ffmpeg", "imagemagick", "librsvg2-bin",
  "zip", "unzip", "jq", "sqlite3", "wget", "file", "fonts-dejavu-core", "fonts-liberation2",
  "libreoffice-writer-nogui", "libreoffice-calc-nogui", "libreoffice-impress-nogui",
] as const;

export const BOT_PYTHON_PACKAGES = [
  "reportlab==5.1.0", "python-docx==1.2.0", "python-pptx==1.0.2", "openpyxl==3.1.5", "matplotlib==3.11.2", "pandas==3.1.1",
  "numpy==2.4.6", "pillow==13.0.0", "requests==2.34.2", "beautifulsoup4==4.15.0", "lxml==6.1.3", "pypdf==7.1.1",
] as const;

/** Download a video clip and fingerprint the song in it. */
export const BOT_MEDIA_PACKAGES = ["yt-dlp[default]==2026.10.26", "shazamio-core==2.0.0"] as const;

const PYTHON_IMPORTS = "reportlab, docx, pptx, openpyxl, matplotlib, pandas, numpy, PIL, requests, bs4, lxml, pypdf, yt_dlp, shazamio_core";
const COMMANDS = ["python", "pip3", "pdftotext", "ffmpeg", "convert", "rsvg-convert", "zip", "jq", "sqlite3", "wget", "file", "soffice", "yt-dlp"];

export const BOT_TOOLS_VERSION = createHash("sha256").update(JSON.stringify([BOT_APT_PACKAGES, BOT_PYTHON_PACKAGES, BOT_MEDIA_PACKAGES])).digest("hex").slice(0, 16);
export const BOT_TOOLS_MARKER = "/var/lib/dusk-bot-tools/version";
export const BOT_TOOLS_LOG = "/var/log/dusk-bot-tools.log";

/** Root's idempotent installer: nothing when the marker names this version, a quick marker when everything is already
 * there (the Docker image), else apt and pip, best effort, each package alone when the whole set fails (a distribution
 * without one of them). The marker is written after one attempt, so a machine tries once per version, never every boot. */
export function botToolsScript(): string {
  const apt = BOT_APT_PACKAGES.join(" ");
  return `set -u
marker=${BOT_TOOLS_MARKER}
[ "$(cat "$marker" 2>/dev/null)" = ${BOT_TOOLS_VERSION} ] && exit 0
have() { for c in ${COMMANDS.join(" ")}; do command -v "$c" >/dev/null || return 1; done; python3 -c "import ${PYTHON_IMPORTS}" 2>/dev/null; }
if ! have && command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  dpkg --configure -a || true
  opts="-y -q --no-install-recommends -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold"
  apt-get -q -o DPkg::Lock::Timeout=600 update || true
  apt-get install $opts ${apt} || for p in ${apt}; do apt-get install $opts "$p" || echo "bot tools: $p not installed"; done
  python3 -m pip install --no-cache-dir --break-system-packages --ignore-installed ${BOT_PYTHON_PACKAGES.join(" ")} || echo "bot tools: python packages not installed"
  python3 -m pip install --no-cache-dir --break-system-packages ${BOT_MEDIA_PACKAGES.map((pkg) => `'${pkg}'`).join(" ")} || echo "bot tools: media packages not installed"
fi
[ -f /etc/pip.conf ] || printf '[global]\\nbreak-system-packages = true\\n' > /etc/pip.conf
git config --system --get-all url.https://github.com/.insteadOf 2>/dev/null | grep -qx 'git@github.com:' || git config --system --add url.https://github.com/.insteadOf 'git@github.com:' || true
git config --system --get-all url.https://github.com/.insteadOf 2>/dev/null | grep -qx 'ssh://git@github.com/' || git config --system --add url.https://github.com/.insteadOf 'ssh://git@github.com/' || true
if have; then echo "bot tools: ready"; else echo "bot tools: some are missing"; fi
mkdir -p "\${marker%/*}" && echo ${BOT_TOOLS_VERSION} > "$marker"
`;
}

/** Starts the installer as root, detached from the supervisor: under systemd in a transient unit of its own, so a
 * restart of the home's unit (KillMode=mixed) never kills apt halfway through dpkg. Off with DUSK_CLOUD_BOT_TOOLS=0. */
export function startBotTools(env: NodeJS.ProcessEnv, run: {
  hasSystemd: () => boolean;
  spawn: (command: string, args: string[], log: number) => void;
  openLog: () => number;
} = {
  hasSystemd: () => existsSync("/run/systemd/system") && spawnSync("systemd-run", ["--version"], { stdio: "ignore", timeout: 5_000 }).status === 0,
  spawn: (command, args, log) => spawn(command, args, { detached: true, stdio: ["ignore", log, log] }).unref(),
  openLog: () => openSync(BOT_TOOLS_LOG, "a", 0o600),
}): string {
  if (env.DUSK_CLOUD_BOT_TOOLS === "0") return "bot tools: skipped (DUSK_CLOUD_BOT_TOOLS=0)";
  const script = botToolsScript();
  let log: number;
  try { log = run.openLog(); } catch (error) { return `bot tools: not started (${error instanceof Error ? error.message : String(error)})`; }
  try {
    if (run.hasSystemd()) {
      run.spawn("systemd-run", ["--unit=dusk-bot-tools", "--collect", "--quiet", "--nice=10", "-p", "IOSchedulingClass=idle", "-p", `StandardOutput=append:${BOT_TOOLS_LOG}`, "-p", `StandardError=append:${BOT_TOOLS_LOG}`, "/bin/bash", "-c", script], log);
    } else {
      run.spawn("nice", ["-n", "10", "/bin/bash", "-c", script], log);
    }
    return `bot tools: checking in the background (${BOT_TOOLS_VERSION})`;
  } catch (error) {
    return `bot tools: not started (${error instanceof Error ? error.message : String(error)})`;
  } finally {
    closeSync(log);
  }
}
