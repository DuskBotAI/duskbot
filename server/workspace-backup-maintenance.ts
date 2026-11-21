/** A backup owns one quiet workspace. Never interrupt a turn to obtain it. */
export class WorkspaceBackupMaintenance {
  active = false;
  pendingRestore = false;
  private requests = 0;
  private updating = false;

  reserveUpdate(idle: () => boolean): (() => void) | null {
    if (this.active || this.requests || !idle()) return null;
    this.active = this.updating = true;
    return () => { this.updating = this.active = false; };
  }

  assertAvailable(): void {
    if (this.updating) throw Object.assign(new Error("The server is installing an update. Try again after it restarts."), { status: 503 });
    if (this.active) throw Object.assign(new Error(this.pendingRestore
      ? "A workspace restore is ready. Fully quit and reopen dusk bot (or restart the hosted server) to finish."
      : "A workspace backup is in progress. Try again when it finishes."), { status: 503 });
  }

  request(): () => void {
    this.assertAvailable();
    this.requests++;
    return () => { this.requests--; };
  }

  async run<T>(work: () => Promise<T>, hooks: { idle: () => boolean; pause: () => void; resume: () => void; flush: () => Promise<void> }, keepLocked = false): Promise<T> {
    this.assertAvailable();
    if (this.requests || !hooks.idle()) throw Object.assign(new Error("Wait for bot turns, approvals, sign-ins, and computer actions to finish before backing up or restoring."), { status: 409 });
    this.active = true;
    let committed = false;
    try {
      hooks.pause();
      await hooks.flush();
      if (!hooks.idle()) throw Object.assign(new Error("The workspace is still finishing background work. Try again shortly."), { status: 409 });
      const result = await work();
      committed = keepLocked;
      this.pendingRestore = keepLocked;
      return result;
    } finally {
      if (!committed) {
        this.active = false;
        hooks.resume();
      }
    }
  }
}
