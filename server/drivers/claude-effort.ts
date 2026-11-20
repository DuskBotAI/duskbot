import type { Writable } from "node:stream";
import { randomUUID } from "node:crypto";

import { versionAtLeast } from "./acp/version-probe.ts";
import { CLAUDE_EFFORT_CONTROL_FLOOR, type ClaudeCliVersion } from "./claude-cli-version.ts";

export function claudeEffortByControl(checked: boolean, version: ClaudeCliVersion | null): boolean {
  return checked && version !== null && versionAtLeast(version, CLAUDE_EFFORT_CONTROL_FLOOR);
}

/** `session.effort` is the effort the live CLI runs at (null: its default), undefined when its launch argv carries it.
 * Resolves false when stdin is gone. */
export function applyClaudeEffort(session: { child: { stdin: Writable }; effort?: string | null }, effort: string | undefined,
  logged: (frame: unknown) => void): Promise<boolean> {
  const wanted = effort ?? null;
  const { stdin } = session.child;
  if (session.effort === undefined || session.effort === wanted) return Promise.resolve(true);
  if (!stdin.writable || stdin.destroyed) return Promise.resolve(false);
  const frame = { type: "control_request", request_id: `effort-${randomUUID()}`, request: { subtype: "apply_flag_settings", settings: { effortLevel: wanted } } };
  return new Promise((resolve) => {
    try {
      stdin.write(`${JSON.stringify(frame)}\n`, (error) => {
        if (error) return resolve(false);
        session.effort = wanted;
        logged(frame);
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
