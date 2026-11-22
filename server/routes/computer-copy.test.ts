import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { RouteContext } from "./table.ts";
import { COPY_TO_COMPUTER, copyDestination, createComputerCopyRoutes, type CopyTarget } from "./computer-copy.ts";

const dir = () => mkdtempSync(join(tmpdir(), "dusk-copy-"));

async function call(deps: { root: string; target: CopyTarget | undefined; owns?: boolean; runner?: Parameters<typeof createComputerCopyRoutes>[0]["runner"] }, body: Record<string, unknown>) {
  const route = createComputerCopyRoutes({
    owns: () => deps.owns ?? true, roots: () => [deps.root], target: async () => deps.target, requireActive: () => {},
    body: async () => body, ...(deps.runner ? { runner: deps.runner } : {}),
  });
  let answer: { status: number; body: any } | undefined;
  await route({ method: "POST", path: COPY_TO_COMPUTER, res: {} as RouteContext["res"], json: ((_res: unknown, status: number, sent: unknown) => { answer = { status, body: sent }; }) as RouteContext["json"] } as RouteContext);
  return answer!;
}

describe("copy_to_computer", () => {
  it("lands in the workspace under the file's name, or where to says, and never outside it", () => {
    expect(copyDestination(undefined, "clip.mp4")).toBe("/home/cua/workspace/clip.mp4");
    expect(copyDestination("reddit/", "clip.mp4")).toBe("/home/cua/workspace/reddit/clip.mp4");
    expect(copyDestination("/home/cua/workspace/reddit/demo.mp4", "clip.mp4")).toBe("/home/cua/workspace/reddit/demo.mp4");
    expect(() => copyDestination("/etc/passwd", "clip.mp4")).toThrow(/home\/cua\/workspace/);
    expect(() => copyDestination("../../etc/x", "clip.mp4")).toThrow(/home\/cua\/workspace/);
    expect(() => copyDestination(5, "clip.mp4")).toThrow(/home\/cua\/workspace/);
  });

  it("copies a working-folder file into a Local VM's workspace in one call", async () => {
    const root = dir(), vm = dir();
    writeFileSync(join(root, "clip.mp4"), Buffer.alloc(300_000, 7));
    const answer = await call({ root, target: { localVm: vm } }, { path: "clip.mp4", to: "reddit/" });
    expect(answer).toEqual({ status: 200, body: { ok: true, path: "/home/cua/workspace/reddit/clip.mp4", bytes: 300_000 } });
    expect(readFileSync(join(vm, "reddit", "clip.mp4")).equals(Buffer.alloc(300_000, 7))).toBe(true);
    expect(readdirSync(join(vm, "reddit")), "no part file left behind").toEqual(["clip.mp4"]);
  });

  it("refuses a link the VM left in its workspace, so the copy can't land elsewhere on the host", async () => {
    const root = dir(), vm = dir(), elsewhere = dir();
    writeFileSync(join(root, "clip.mp4"), "video");
    symlinkSync(elsewhere, join(vm, "out"));
    const answer = await call({ root, target: { localVm: vm } }, { path: "clip.mp4", to: "out/clip.mp4" });
    expect(answer.status).toBe(400);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("reads only the bot's own folder", async () => {
    const root = dir(), vm = dir(), other = dir();
    writeFileSync(join(other, "secret.txt"), "no");
    expect(await call({ root, target: { localVm: vm } }, { path: join(other, "secret.txt") })).toMatchObject({ status: 403, body: { error: expect.stringMatching(/isn't in your working folder/) } });
    expect((await call({ root, target: { localVm: vm } }, { path: "missing.mp4" })).status).toBe(404);
    expect((await call({ root, target: { localVm: vm } }, {})).status).toBe(400);
    expect((await call({ root, target: { localVm: vm }, owns: false }, { path: "x" })).status).toBe(403);
    mkdirSync(join(root, "a"));
    writeFileSync(join(root, "a", "b.txt"), "ok");
    expect((await call({ root, target: undefined }, { path: "a/b.txt" })).status).toBe(409);
    expect(existsSync(join(vm, "b.txt"))).toBe(false);
  });

  it("sends a file to a VPS desktop as one stdin stream and checks the size it wrote", async () => {
    const root = dir();
    writeFileSync(join(root, "clip.mp4"), Buffer.from("orbit video bytes"));
    const calls: Array<{ args: string[]; input?: string }> = [];
    const runner = async (args: string[], options?: { input?: string }) => {
      calls.push({ args, ...(options?.input !== undefined ? { input: options.input } : {}) });
      return { stdout: `${Buffer.from(options!.input!, "base64").length}\n`, stderr: "" };
    };
    const target = { vps: { alias: "dusk-vps", containerId: "0123456789abcdef" } };
    const answer = await call({ root, target, runner }, { path: "clip.mp4" });
    expect(answer).toEqual({ status: 200, body: { ok: true, path: "/home/cua/workspace/clip.mp4", bytes: 17 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(expect.arrayContaining(["exec", "-i", "-u", "cua", "0123456789abcdef", "/home/cua/workspace/clip.mp4"]));
    expect(Buffer.from(calls[0]!.input!, "base64").toString()).toBe("orbit video bytes");
    const short = async () => ({ stdout: "3\n", stderr: "" });
    expect((await call({ root, target, runner: short }, { path: "clip.mp4" })).status).toBe(502);
  });
});
