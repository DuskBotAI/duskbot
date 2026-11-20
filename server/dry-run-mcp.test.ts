import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";

import { heldInTestRun, testRunMayCall } from "./dry-run-mcp.ts";
import { testRunMounts } from "./dry-run-mounts.ts";

const hint = (readOnly: boolean, destructive = false) => ({ readOnly, destructive });

describe("what a test run may call on a person's MCP server", () => {
  it("lets through only tools that read, by the server's own word or a read name, and holds the rest", () => {
    const hints = new Map([
      ["gmail_search", hint(true)], ["gmail_send", hint(false)], ["sheets_append_rows", hint(false)],
      ["update_record", hint(true)], ["list_issues", hint(false)], ["get_page", hint(true, true)],
    ]);
    expect(testRunMayCall("gmail_search", hints)).toBe(true);
    expect(testRunMayCall("list_issues", hints)).toBe(true);
    expect(testRunMayCall("gmail_send", hints)).toBe(false);
    expect(testRunMayCall("sheets_append_rows", hints)).toBe(false);
    expect(testRunMayCall("update_record", hints)).toBe(false);
    expect(testRunMayCall("get_page", hints)).toBe(false);
    expect(testRunMayCall("list_unlisted", hints)).toBe(false);
  });

  it("answers a held call itself, through the mounted proxy, and passes reads to the server", async () => {
    const upstream = `
      const rl = require("node:readline").createInterface({ input: process.stdin });
      rl.on("line", (line) => { const m = JSON.parse(line);
        if (m.method === "tools/list") return process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [
          { name: "gmail_search", annotations: { readOnlyHint: true } }, { name: "gmail_send", annotations: { readOnlyHint: false } } ] } }) + "\\n");
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "upstream ran " + m.params.name }] } }) + "\\n");
      });`;
    const mounted = testRunMounts({ gmail: { command: process.execPath, args: ["-e", upstream], env: {} } }, {});
    const spec = mounted.gmail as { command: string; args: string[]; env: Record<string, string> };
    const child = spawn(spec.command, ["--experimental-strip-types", ...spec.args], { env: { ...process.env, ...spec.env }, stdio: ["pipe", "pipe", "inherit"] });
    const replies = new Map<number, string>();
    createInterface({ input: child.stdout }).on("line", (line) => { const m = JSON.parse(line); replies.set(m.id, JSON.stringify(m.result)); });
    const send = (id: number, method: string, params: unknown = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    send(1, "tools/list");
    await expect.poll(() => replies.has(1), { timeout: 10_000 }).toBe(true);
    send(2, "tools/call", { name: "gmail_search", arguments: { query: "label:support" } });
    send(3, "tools/call", { name: "gmail_send", arguments: { to: "jen@example.com" } });
    await expect.poll(() => replies.has(2) && replies.has(3), { timeout: 10_000 }).toBe(true);
    child.kill();
    expect(replies.get(2)).toContain("upstream ran gmail_search");
    expect(replies.get(3)).toContain("Test run: gmail gmail_send was not called");
    expect(replies.get(3)).not.toContain("upstream ran");
    expect(heldInTestRun("gmail", "gmail_send", { to: "a" })).toContain('gmail_send {"to":"a"}');
  });
});
