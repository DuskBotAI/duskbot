// Google sign-in for an Antigravity profile through `agy acp --login`: the CLI prints a link, the person brings back
// the code its page shows, and the CLI stores the sign-in in the profile.
//
// `--login` code validation adapted from pingdotgg/t3code (MIT License, Copyright (c) 2026 T3 Tools Inc., full text in
// third_party/t3-code/LICENSE): apps/server/src/provider/antigravityAuthSupport.ts,
// AntigravityAuth.ts, and Drivers/AntigravityDriver.ts.
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import { killCliTree, spawnCli } from "../procs.ts";
import { StderrTail, exitDetail } from "./acp/exit-report.ts";
import {
  GRACEFUL_EXIT_MS,
  MAX_DIAGNOSTIC_LINE_CHARS,
  STARTUP_TIMEOUT_MS,
  antigravityAcpArgs,
  antigravityProfileAuthenticated,
  takeLines,
  type AntigravityProfile,
} from "./antigravity-acp.ts";
import {
  antigravityLoginResponse,
  parseAntigravityAuthorizationUrl,
  type AntigravityAuthorizationUrl,
} from "./antigravity-oauth.ts";
import { markAntigravityRuntimeOutdated, type AntigravityRuntime } from "./antigravity-runtime.ts";

export { antigravityLoginResponse };

const AUTH_TIMEOUT_MS = 5 * 60_000;
const COMPLETE_TIMEOUT_MS = 90_000;

export interface AntigravityAuthStart {
  phase: "waiting" | "succeeded";
  flowId: string | null;
  authorizationUrl: string | null;
  expiresAt: string | null;
}

interface LoginFlow {
  id: string;
  child: ChildProcess;
  profile: AntigravityProfile;
  completed: Promise<void>;
  exited: Promise<void>;
  pending: AntigravityAuthorizationUrl;
  expiresAt: number;
  expiryTimer: ReturnType<typeof setTimeout>;
  submitted: boolean;
  stop: () => Promise<boolean>;
}

function loginEnvironment(base: NodeJS.ProcessEnv, profileDirectory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    const upper = key.toUpperCase();
    // Without a display, `agy acp --login` prints the link instead of opening a browser on the server.
    // Antigravity CLI 1.5+ ignores --gemini-dir during --login summary reconciliation and scans $HOME/.gemini/antigravity/conversations.
    if (upper === "DISPLAY" || upper === "WAYLAND_DISPLAY" || upper === "HOME" || upper === "USERPROFILE") continue;
    env[key] = value;
  }
  env.HOME = profileDirectory;
  if (process.platform === "win32") env.USERPROFILE = profileDirectory;
  return env;
}

// Antigravity CLI 1.3 and older read `acp` as a stray prompt; 1.4 has `acp` without `--login`.
const OUTDATED_CLI = /unexpected argument "acp|flags? provided but not defined: -+login|unknown (?:flag|command)[^\n]*(?:login|acp)/iu;

/** The one plain sentence a failed sign-in shows; the CLI's own output goes to the log only. */
export function antigravitySignInFailure(stderr: string): string {
  return antigravityCliOutdated(stderr)
    ? "The Antigravity app on this computer is too old for dusk bot. Try again to install Google's current one."
    : "Antigravity couldn't start Google sign-in. Try again in a moment.";
}

export function antigravityCliOutdated(stderr: string): boolean {
  return OUTDATED_CLI.test(stderr);
}

export class AntigravityAuthController {
  private flow: LoginFlow | null = null;
  private startingStop: (() => Promise<boolean>) | null = null;
  private readonly onSignedIn: () => void;

  constructor(onSignedIn: () => void = () => {}) {
    this.onSignedIn = onSignedIn;
  }

  async start(runtime: AntigravityRuntime, profile: AntigravityProfile): Promise<AntigravityAuthStart> {
    await this.cancelAndWait();
    const child = spawnCli(
      runtime.executablePath,
      [...antigravityAcpArgs(profile.directory), "--login"],
      {
        cwd: profile.directory,
        env: loginEnvironment(profile.environment, profile.directory),
        stdio: ["pipe", "pipe", "pipe"],
        box: { net: "shared" as const },
      },
      "bot",
    );

    let closed = false;
    let stopping: Promise<boolean> | undefined;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    const stderrTail = new StderrTail();
    let settledUrl = false;
    let foundUrl!: (value: AntigravityAuthorizationUrl) => void;
    let failUrl!: (error: Error) => void;
    const urlPromise = new Promise<AntigravityAuthorizationUrl>((resolveUrl, reject) => {
      foundUrl = (value) => { if (!settledUrl) { settledUrl = true; resolveUrl(value); } };
      failUrl = (error) => { if (!settledUrl) { settledUrl = true; reject(error); } };
    });

    let resolveExited!: () => void;
    const exited = new Promise<void>((resolveExit) => { resolveExited = resolveExit; });

    let resolveCompleted!: () => void;
    let rejectCompleted!: (error: Error) => void;
    const completed = new Promise<void>((resolveDone, rejectDone) => {
      resolveCompleted = resolveDone;
      rejectCompleted = rejectDone;
    });
    completed.catch(() => {});

    const stop = (): Promise<boolean> => {
      if (stopping) return stopping;
      closed = true;
      stopping = (async () => {
        try { child.stdin?.end(); } catch {}
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          exited,
          new Promise<void>((resolveWait) => {
            timer = setTimeout(resolveWait, GRACEFUL_EXIT_MS);
            timer.unref?.();
          }),
        ]);
        clearTimeout(timer);
        return killCliTree(child);
      })();
      return stopping;
    };
    this.startingStop = stop;

    const handleStdoutLine = (raw: string) => {
      const trimmed = raw.trim();
      const index = trimmed.indexOf("https://accounts.google.com/");
      if (index === -1) return;
      try {
        foundUrl(parseAntigravityAuthorizationUrl(trimmed.slice(index), "code"));
      } catch (error) {
        failUrl(error instanceof Error ? error : new Error(String(error)));
      }
    };

    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      const { lines, rest } = takeLines(stdoutBuffer + chunk);
      stdoutBuffer = rest.length > MAX_DIAGNOSTIC_LINE_CHARS ? "" : rest;
      for (const line of lines) handleStdoutLine(line);
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      const { lines, rest } = takeLines(stderrBuffer + chunk);
      stderrBuffer = rest.length > MAX_DIAGNOSTIC_LINE_CHARS ? "" : rest;
      for (const line of lines) stderrTail.note(line);
    });
    child.once("error", (error) => {
      failUrl(error);
      rejectCompleted(error);
    });
    child.once("close", (code, signal) => {
      if (stdoutBuffer.trim()) handleStdoutLine(stdoutBuffer);
      stdoutBuffer = "";
      if (stderrBuffer.trim()) stderrTail.note(stderrBuffer);
      stderrBuffer = "";
      resolveExited();
      if (code === 0) {
        resolveCompleted();
      } else if (closed) {
        const error = new Error("Google sign-in was cancelled.");
        failUrl(error);
        rejectCompleted(error);
      } else {
        const detail = exitDetail(code, signal, stderrTail.text);
        console.warn(`antigravity: Google sign-in exited${detail}`);
        if (antigravityCliOutdated(stderrTail.text)) markAntigravityRuntimeOutdated(runtime);
        const error = new Error(antigravitySignInFailure(stderrTail.text));
        failUrl(error);
        rejectCompleted(error);
      }
    });

    try {
      let startupTimer: ReturnType<typeof setTimeout> | undefined;
      const startupTimeout = new Promise<never>((_resolve, reject) => {
        startupTimer = setTimeout(() => reject(new Error("Google sign-in did not start in time.")), STARTUP_TIMEOUT_MS);
        startupTimer.unref?.();
      });
      const outcome = await Promise.race([
        urlPromise.then((request) => ({ kind: "url" as const, request })),
        completed.then(() => ({ kind: "done" as const })),
        startupTimeout,
      ]).finally(() => {
        if (startupTimer) clearTimeout(startupTimer);
      });

      if (this.startingStop === stop) this.startingStop = null;
      if (closed) {
        await stop();
        throw new Error("Google sign-in was cancelled.");
      }

      if (outcome.kind === "done") {
        await stop();
        if (await antigravityProfileAuthenticated(profile)) {
          await rm(profile.legacyTokenPath, { force: true, maxRetries: 4, retryDelay: 250 }).catch(() => {});
          this.onSignedIn();
          return { phase: "succeeded", flowId: null, authorizationUrl: null, expiresAt: null };
        }
        throw new Error("Antigravity sign-in exited without returning a Google sign-in link.");
      }

      const flowId = randomUUID();
      const expiresAt = Date.now() + AUTH_TIMEOUT_MS;
      const expiryTimer = setTimeout(() => {
        if (this.flow?.id === flowId && !this.flow.submitted) {
          this.flow = null;
          void stop();
        }
      }, AUTH_TIMEOUT_MS);
      expiryTimer.unref?.();

      const flow: LoginFlow = {
        id: flowId,
        child,
        profile,
        completed,
        exited,
        pending: outcome.request,
        expiresAt,
        expiryTimer,
        submitted: false,
        stop,
      };
      this.flow = flow;
      void exited.then(() => {
        clearTimeout(expiryTimer);
        if (this.flow === flow) this.flow = null;
      });
      return {
        phase: "waiting",
        flowId,
        authorizationUrl: outcome.request.authorizationUrl,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    } catch (error) {
      if (this.startingStop === stop) this.startingStop = null;
      await stop();
      throw error;
    }
  }

  async complete(flowId: string, response: string): Promise<void> {
    const flow = this.flow;
    if (!flow || flow.id !== flowId || Date.now() >= flow.expiresAt) {
      throw new Error("This Google sign-in is no longer active. Start again.");
    }
    if (flow.submitted) {
      throw Object.assign(new Error("The sign-in code was already sent. Wait for Google to finish."), { status: 409 });
    }
    const validated = antigravityLoginResponse(flow.pending, response);
    if (!validated) {
      throw Object.assign(
        new Error("Paste the code from the Antigravity page, or that page's full URL."),
        { status: 400 },
      );
    }
    flow.submitted = true;
    clearTimeout(flow.expiryTimer);
    let completeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const completeTimeout = new Promise<never>((_resolve, reject) => {
        completeTimer = setTimeout(() => reject(new Error("Google sign-in timed out while finishing.")), COMPLETE_TIMEOUT_MS);
        completeTimer.unref?.();
      });
      flow.child.stdin!.write(`${validated}\n`);
      flow.child.stdin!.end();
      await Promise.race([flow.completed.catch(() => {
        throw new Error("Google didn't accept that code. Start sign-in again and paste the whole code from the Antigravity page.");
      }), completeTimeout]);
      if (!(await antigravityProfileAuthenticated(flow.profile))) {
        throw new Error("Antigravity finished without saving a Google sign-in. Start sign-in again.");
      }
      await rm(flow.profile.legacyTokenPath, { force: true, maxRetries: 4, retryDelay: 250 }).catch(() => {});
      this.onSignedIn();
    } finally {
      if (completeTimer) clearTimeout(completeTimer);
      clearTimeout(flow.expiryTimer);
      if (this.flow === flow) this.flow = null;
      await flow.stop();
    }
  }

  cancel(): void {
    const starting = this.startingStop;
    this.startingStop = null;
    if (starting) void starting();
    const flow = this.flow;
    if (!flow) return;
    this.flow = null;
    clearTimeout(flow.expiryTimer);
    void flow.stop();
  }

  async cancelAndWait(): Promise<void> {
    const starting = this.startingStop;
    this.startingStop = null;
    const flow = this.flow;
    this.flow = null;
    if (flow) clearTimeout(flow.expiryTimer);
    await Promise.all([
      starting ? starting() : Promise.resolve(true),
      flow ? flow.stop() : Promise.resolve(true),
    ]);
  }
}
