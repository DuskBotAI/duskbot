import { AuditLedger } from "./audit-ledger.ts";

export type PolicyDecision = "ALLOW" | "REQUIRE_APPROVAL" | "DENY";

export interface PolicyContext {
  tool: string;
  botId: string;
  args: Record<string, unknown>;
  environment?: "desktop" | "server" | "cloud";
  timestamp?: number;
}

export interface PolicyRule {
  id: string;
  description: string;
  evaluate: (ctx: PolicyContext) => { decision: PolicyDecision; reason: string } | null;
}

export class PolicyGateway {
  private rules: PolicyRule[] = [];
  private ledger: AuditLedger;

  constructor(rules: PolicyRule[] = [], ledger?: AuditLedger) {
    this.rules = rules;
    this.ledger = ledger ?? new AuditLedger();
  }

  addRule(rule: PolicyRule): void {
    this.rules.push(rule);
  }

  evaluate(ctx: PolicyContext): { decision: PolicyDecision; ruleId?: string; reason: string } {
    const timestamp = ctx.timestamp ?? Date.now();
    const evaluationContext = { ...ctx, timestamp };

    for (const rule of this.rules) {
      const match = rule.evaluate(evaluationContext);
      if (match) {
        this.ledger.record({
          botId: ctx.botId,
          tool: ctx.tool,
          decision: match.decision,
          reason: `[${rule.id}] ${match.reason}`,
          args: ctx.args,
        });
        return { decision: match.decision, ruleId: rule.id, reason: match.reason };
      }
    }

    const defaultDecision: PolicyDecision = "ALLOW";
    const defaultReason = "Permitted under default policy ruleset";
    this.ledger.record({
      botId: ctx.botId,
      tool: ctx.tool,
      decision: defaultDecision,
      reason: defaultReason,
      args: ctx.args,
    });

    return { decision: defaultDecision, reason: defaultReason };
  }
}
