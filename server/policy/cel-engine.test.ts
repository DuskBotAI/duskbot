import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditLedger } from "./audit-ledger.ts";
import { PolicyGateway } from "./cel-engine.ts";
import { DEFAULT_POLICY_RULES } from "./cel-rules.ts";

describe("CEL Policy Gateway and Audit Ledger", () => {
  let tempDir: string;
  let ledgerPath: string;
  let ledger: AuditLedger;
  let gateway: PolicyGateway;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dusk-policy-test-"));
    ledgerPath = join(tempDir, "test-ledger.jsonl");
    ledger = new AuditLedger(ledgerPath);
    gateway = new PolicyGateway(DEFAULT_POLICY_RULES, ledger);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("denies access to credentials and ssh keys", () => {
    const check = gateway.evaluate({
      botId: "nova",
      tool: "read_file",
      args: { Path: "/home/user/.ssh/id_rsa" },
    });

    expect(check.decision).toBe("DENY");
    expect(check.ruleId).toBe("fs-credential-isolation");
    expect(check.reason).toContain("credential path");
  });

  it("denies destructive terminal commands", () => {
    const check = gateway.evaluate({
      botId: "echo",
      tool: "run_command",
      args: { CommandLine: "rm -rf / --no-preserve-root" },
    });

    expect(check.decision).toBe("DENY");
    expect(check.ruleId).toBe("cmd-destructive-rejection");
  });

  it("requires approval for banking and identity logins", () => {
    const check = gateway.evaluate({
      botId: "quill",
      tool: "browser_navigate",
      args: { url: "https://accounts.google.com/signin" },
    });

    expect(check.decision).toBe("REQUIRE_APPROVAL");
    expect(check.ruleId).toBe("browser-auth-payment-checkpoint");
  });

  it("allows safe read operations within workspace", () => {
    const check = gateway.evaluate({
      botId: "nova",
      tool: "read_file",
      args: { Path: "e:/projects/code/duskbot/package.json" },
    });

    expect(check.decision).toBe("ALLOW");
  });

  it("maintains a cryptographically verifiable tamper-evident audit ledger", () => {
    gateway.evaluate({
      botId: "nova",
      tool: "read_file",
      args: { Path: "safe.txt" },
    });
    gateway.evaluate({
      botId: "nova",
      tool: "run_command",
      args: { CommandLine: "rm -rf /" },
    });

    const verification = ledger.verifyChain();
    expect(verification.valid).toBe(true);
    expect(verification.recordsCount).toBe(2);
  });
});
