import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { claudeDenyRules, claudeRulePath, codexWorkspaceFilesystem, engineReadScope } from "./engine-read-scope.ts";

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function dataDir() {
  const root = mkdtempSync(join(tmpdir(), "dusk-read-scope-"));
  roots.push(root);
  const data = join(root, "data"), home = join(root, "home"), project = join(root, "project");
  const chat = join(data, "task-workspaces", "b1", "t1"), otherChat = join(data, "task-workspaces", "b2", "t9");
  for (const dir of [join(chat, "context-archive"), otherChat, join(data, "workspaces", "b1"), join(data, "engine-homes"), home, project]) mkdirSync(dir, { recursive: true });
  return { data, home, project, chat, otherChat };
}

const covers = (paths: readonly string[], target: string) => paths.some((path) => target === path || target.startsWith(`${path}/`));

it("leaves the chat's own folder readable to Claude and Codex from a project folder, boxed or not, and hides other bots' chats", () => {
  const { data, home, project, chat, otherChat } = dataDir();
  for (const boxed of [false, true]) {
    const scope = engineReadScope({ dataDir: data, home, cwd: project, botId: "b1", threadId: "t1", boxed });
    expect(scope.readable).toContain(chat);
    const archive = join(chat, "context-archive", "through-m4.md");
    expect(covers(scope.hidden, archive)).toBe(false);
    expect(covers(scope.hidden, otherChat)).toBe(true);
    const denied = (path: string) => claudeDenyRules(scope).some((rule) => rule.startsWith("Read(") && covers([rule.slice(5, -1).replace(/\/\*\*$/, "")], claudeRulePath(path)));
    expect(denied(archive)).toBe(false);
    expect(denied(join(otherChat, "notes.md"))).toBe(true);
    const codex = codexWorkspaceFilesystem(scope);
    const codexHides = (path: string) => Object.entries(codex).some(([root, access]) => access === "none" && covers([root], path));
    expect(codexHides(archive)).toBe(false);
    expect(codexHides(otherChat)).toBe(true);
    expect(codex[":root"]).toBe("read");
  }
});

it("adds nothing for the chat's folder when the chat works in it", () => {
  const { data, home, chat } = dataDir();
  const scope = engineReadScope({ dataDir: data, home, cwd: chat, botId: "b1", threadId: "t1", boxed: true });
  expect(scope.readable).not.toContain(chat);
  expect(covers(scope.hidden, join(chat, "context-archive"))).toBe(false);
});
