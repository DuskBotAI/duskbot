import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "../config.ts";

export interface AuditRecord {
  seq: number;
  at: number;
  botId: string;
  tool: string;
  decision: "ALLOW" | "REQUIRE_APPROVAL" | "DENY";
  reason: string;
  argsSha256: string;
  prevHash: string;
  hash: string;
}

const LEDGER_PATH = join(DATA_DIR, "audit-ledger.jsonl");

export class AuditLedger {
  private lastHash = "0000000000000000000000000000000000000000000000000000000000000000";
  private seq = 0;
  private filePath: string;

  constructor(filePath = LEDGER_PATH) {
    this.filePath = filePath;
    this.hydrate();
  }

  private hydrate(): void {
    if (!existsSync(this.filePath)) {
      mkdirSync(dirname(this.filePath), { recursive: true });
      return;
    }
    const lines = readFileSync(this.filePath, "utf-8").trim().split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as AuditRecord;
        this.seq = record.seq;
        this.lastHash = record.hash;
      } catch {
        break;
      }
    }
  }

  record(entry: {
    botId: string;
    tool: string;
    decision: "ALLOW" | "REQUIRE_APPROVAL" | "DENY";
    reason: string;
    args: unknown;
  }): AuditRecord {
    const at = Date.now();
    const argsSha256 = createHash("sha256")
      .update(JSON.stringify(entry.args ?? {}))
      .digest("hex");
    const seq = ++this.seq;
    const prevHash = this.lastHash;

    const payload = `${seq}:${at}:${entry.botId}:${entry.tool}:${entry.decision}:${entry.reason}:${argsSha256}:${prevHash}`;
    const hash = createHash("sha256").update(payload).digest("hex");

    const record: AuditRecord = {
      seq,
      at,
      botId: entry.botId,
      tool: entry.tool,
      decision: entry.decision,
      reason: entry.reason,
      argsSha256,
      prevHash,
      hash,
    };

    appendFileSync(this.filePath, JSON.stringify(record) + "\n", "utf-8");
    this.lastHash = hash;
    return record;
  }

  verifyChain(): { valid: boolean; recordsCount: number; brokenSeq?: number } {
    if (!existsSync(this.filePath)) return { valid: true, recordsCount: 0 };
    const lines = readFileSync(this.filePath, "utf-8").trim().split("\n");
    let prev = "0000000000000000000000000000000000000000000000000000000000000000";
    let count = 0;

    for (const line of lines) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line) as AuditRecord;
      count++;
      if (rec.prevHash !== prev) {
        return { valid: false, recordsCount: count, brokenSeq: rec.seq };
      }
      const payload = `${rec.seq}:${rec.at}:${rec.botId}:${rec.tool}:${rec.decision}:${rec.reason}:${rec.argsSha256}:${rec.prevHash}`;
      const expectedHash = createHash("sha256").update(payload).digest("hex");
      if (rec.hash !== expectedHash) {
        return { valid: false, recordsCount: count, brokenSeq: rec.seq };
      }
      prev = rec.hash;
    }
    return { valid: true, recordsCount: count };
  }
}
