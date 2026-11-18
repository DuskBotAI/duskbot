import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SendTurnInput } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { mountChatTools, type ChatToolSession } from "./chat-mcp-tools.ts";

type Integrations = NonNullable<SendTurnInput["integrations"]>;

const DESKTOP = `#!/usr/bin/env node
import { createInterface } from "node:readline";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") reply(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} } });
  else if (message.method === "tools/list") reply(message.id, { tools: [{ name: "click", description: "Click", inputSchema: { type: "object", properties: {} } }] });
  else reply(message.id, { content: [{ type: "text", text: "clicked" }] });
});
`;
const RECORDING_SHELL = `#!/bin/sh
printf '%s\\n' "$3" >> "$HOST_SHELL_HANDED"
echo "Recorded in $(pwd), not run."
`;

const sessions: ChatToolSession[] = [];
const folders: string[] = [];
let ownShell: string | undefined;

beforeEach(() => { ownShell = process.env.SHELL; });
afterEach(async () => {
  if (ownShell === undefined) delete process.env.SHELL; else process.env.SHELL = ownShell;
  delete process.env.HOST_SHELL_HANDED;
  await Promise.all(sessions.splice(0).map((session) => session.close().catch(() => {})));
  for (const folder of folders.splice(0)) await removeTempDir(folder);
});

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "dusk-chat-host-shell-")));
  folders.push(directory);
  const desktopScript = join(directory, "desktop.mjs");
  writeFileSync(desktopScript, DESKTOP);
  chmodSync(desktopScript, 0o755);
  const shell = join(directory, "recording-shell");
  writeFileSync(shell, RECORDING_SHELL);
  chmodSync(shell, 0o755);
  const handedFile = join(directory, "handed.txt");
  process.env.SHELL = shell;
  process.env.HOST_SHELL_HANDED = handedFile;
  const desktop = { command: desktopScript, args: [], env: {} };
  const controller = new AbortController();
  return {
    directory, controller,
    hostDesktop: { ...desktop, scope: "local-computer" } as Integrations["localComputer"],
    sandboxDesktop: desktop as Integrations["localComputer"],
    handed: (): string[] => existsSync(handedFile) ? readFileSync(handedFile, "utf8").trim().split("\n") : [],
    async mount(integrations: Integrations, options: { computerUse?: boolean; toolScope?: Parameters<typeof mountChatTools>[3]; resultFolder?: string } = {}) {
      const session = await mountChatTools(integrations, controller.signal, options.computerUse ?? true, options.toolScope, undefined, undefined, options.resultFolder);
      sessions.push(session);
      return { session, names: session.definitions.map((tool) => tool.function.name) };
    },
  };
}

describe.skipIf(process.platform === "win32")("the person's own shell in a chat turn", () => {
  it("is listed beside this computer's tools, ahead of them", async () => {
    const f = fixture();
    const { names, session } = await f.mount({ localComputer: f.hostDesktop, hostShell: { cwd: f.directory } });
    expect(names).toEqual(["shell_run_command", "computer_click"]);
    expect(session.definitions[0]!.function.parameters).toMatchObject({ required: ["command"] });
    expect(session.parallel("shell_run_command", { command: "ls" })).toBe(false);
  });

  it("is not listed without the integration, off this computer, or for a runtime that drives no computer", async () => {
    const f = fixture();
    expect((await f.mount({ localComputer: f.hostDesktop })).names).toEqual(["computer_click"]);
    expect((await f.mount({ localComputer: f.sandboxDesktop, hostShell: { cwd: f.directory } })).names).toEqual(["computer_click"]);
    expect((await f.mount({ hostShell: { cwd: f.directory } })).names).toEqual([]);
    expect((await f.mount({ localComputer: f.hostDesktop, hostShell: { cwd: f.directory } }, { computerUse: false })).names).toEqual([]);
  });

  it("follows the bot's tool selection", async () => {
    const f = fixture();
    const integrations = { localComputer: f.hostDesktop, hostShell: { cwd: f.directory } };
    const without = await f.mount(integrations, { toolScope: { allow: ["mcp:computer:*"] } });
    expect(without.names).toEqual(["computer_click"]);
    expect(() => without.session.validate("shell_run_command", { command: "ls" })).toThrow("not advertised");
    const withShell = await f.mount(integrations, { toolScope: { allow: ["mcp:shell:run_command"] } });
    expect(withShell.names).toEqual(["shell_run_command"]);
  });

  it("asks for every command, and a kept allow covers that exact command in that folder only", async () => {
    const f = fixture();
    const { session } = await f.mount({ localComputer: f.hostDesktop, hostShell: { cwd: f.directory } });
    const view = session.view("shell_run_command", { command: "git status" });
    expect(view).toMatchObject({ title: "shell_run_command", input: { command: "git status" }, ask: true });
    expect(JSON.parse(view.grant!)).toEqual(["shell", expect.stringMatching(/^[0-9a-f]{64}$/u), "git status", null]);
    expect(session.view("shell_run_command", { command: "git status" }).grant).toBe(view.grant);
    expect(session.view("shell_run_command", { command: "git status --short" }).grant).not.toBe(view.grant);
    expect(session.view("shell_run_command", { command: "git status", cwd: "~" }).grant).not.toBe(view.grant);
    expect(session.view("computer_click", {})).toEqual({ title: "computer_click", input: {}, ask: true });
  });

  it("holds a call to the tool's schema", async () => {
    const f = fixture();
    const { session } = await f.mount({ localComputer: f.hostDesktop, hostShell: { cwd: f.directory } });
    expect(() => session.validate("shell_run_command", {})).toThrow("input schema");
    expect(() => session.validate("shell_run_command", { command: "ls", sudo: true })).toThrow("input schema");
    expect(() => session.validate("shell_run_command", { command: "ls", timeout_seconds: 4_000 })).toThrow("input schema");
    expect(() => session.validate("shell_run_command", { command: "ls", cwd: "~", timeout_seconds: 30 })).not.toThrow();
    expect(f.handed()).toEqual([]);
  });

  it("runs an allowed command through the person's shell, in the folder the turn gave or the one the call names", async () => {
    const f = fixture();
    const { session } = await f.mount({ localComputer: f.hostDesktop, hostShell: { cwd: f.directory } });
    const first = await session.execute("shell_run_command", { command: "ls -la" }, f.controller.signal);
    expect(first).toEqual({ ok: true, text: `exit code 0\nRecorded in ${f.directory}, not run.\n` });
    const second = await session.execute("shell_run_command", { command: "pwd", cwd: tmpdir() }, f.controller.signal);
    expect(second.text).toBe(`exit code 0\nRecorded in ${realpathSync(tmpdir())}, not run.\n`);
    expect(f.handed()).toEqual(["ls -la", "pwd"]);
  });

  it("starts in the turn's own folder when the integration names none", async () => {
    const f = fixture();
    const { session } = await f.mount({ localComputer: f.hostDesktop, hostShell: {} }, { resultFolder: f.directory });
    expect((await session.execute("shell_run_command", { command: "pwd" }, f.controller.signal)).text).toContain(`Recorded in ${f.directory}, not run.`);
  });
});
