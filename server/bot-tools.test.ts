import { spawnSync } from "node:child_process";
import { openSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { BOT_APT_PACKAGES, BOT_MEDIA_PACKAGES, BOT_PYTHON_PACKAGES, BOT_TOOLS_LOG, BOT_TOOLS_VERSION, botToolsScript, startBotTools } from "./bot-tools.ts";

const dockerfile = readFileSync(new URL("../deploy/docker/Dockerfile", import.meta.url), "utf8");

function fakeRun(systemd: boolean, failLog = false) {
  const calls: Array<{ command: string; args: string[] }> = [];
  return {
    calls,
    run: {
      hasSystemd: () => systemd,
      spawn: (command: string, args: string[]) => { calls.push({ command, args }); },
      openLog: () => { if (failLog) throw new Error("read-only file system"); return openSync("/dev/null", "a"); },
    },
  };
}

describe("the bots' tools on a natively installed dusk cloud", () => {
  it("installs under a transient systemd unit of its own, so a restart of the home never cuts dpkg off", () => {
    const { calls, run } = fakeRun(true);
    expect(startBotTools({}, run)).toContain(BOT_TOOLS_VERSION);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("systemd-run");
    expect(calls[0]!.args).toEqual(expect.arrayContaining(["--unit=dusk-bot-tools", "--collect", `StandardOutput=append:${BOT_TOOLS_LOG}`, "/bin/bash", "-c", botToolsScript()]));
  });

  it("runs detached under nice without systemd, skips with DUSK_CLOUD_BOT_TOOLS=0, and never throws", () => {
    const plain = fakeRun(false);
    startBotTools({}, plain.run);
    expect(plain.calls[0]).toEqual({ command: "nice", args: ["-n", "10", "/bin/bash", "-c", botToolsScript()] });
    const off = fakeRun(true);
    expect(startBotTools({ DUSK_CLOUD_BOT_TOOLS: "0" }, off.run)).toContain("skipped");
    expect(off.calls).toEqual([]);
    const broken = fakeRun(true, true);
    expect(startBotTools({}, broken.run)).toContain("not started");
    expect(broken.calls).toEqual([]);
  });

  it("is a valid bash script that stops at once when this version is installed, and marks one attempt per version", () => {
    const script = botToolsScript();
    expect(spawnSync("bash", ["-n", "-c", script]).status).toBe(0);
    expect(script.indexOf(`= ${BOT_TOOLS_VERSION} ] && exit 0`)).toBeLessThan(script.indexOf("apt-get"));
    expect(script.trimEnd().split("\n").at(-1)).toContain(`echo ${BOT_TOOLS_VERSION} > "$marker"`);
    expect(script).toContain("dpkg --configure -a");
  });

  it("matches what the cloud-home Docker image bakes in", () => {
    expect(dockerfile).toContain(`ARG BOT_PYTHON_PACKAGES="${BOT_PYTHON_PACKAGES.join(" ")}"`);
    expect(dockerfile).toContain(`ARG BOT_MEDIA_PACKAGES="${BOT_MEDIA_PACKAGES.join(" ")}"`);
    const cloudHome = dockerfile.slice(dockerfile.indexOf("FROM runtime AS cloud-home"), dockerfile.indexOf("FROM runtime AS server"));
    for (const pkg of BOT_APT_PACKAGES) expect(cloudHome, pkg).toMatch(new RegExp(`\\s${pkg}\\s`));
  });
});
