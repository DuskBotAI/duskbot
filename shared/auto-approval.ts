/** Why the app answered a request without asking, as its transcript chip words it: "approved <tool> (<reason>)". */
export const AUTO_APPROVAL_REASONS = ["full access", "saved command", "always allowed", "its own files", "reads only", "web search"] as const;
export type AutoApprovalReason = (typeof AUTO_APPROVAL_REASONS)[number];

export function autoApprovalChip(tool: string, reason: AutoApprovalReason): string {
  return `approved ${tool} (${reason})`;
}

const CHIP = new RegExp(`^approved \\S+ \\((?:${AUTO_APPROVAL_REASONS.join("|")})\\)(?::|$)`);

/** True for a chip `autoApprovalChip` wrote, with or without the approved action after its colon. */
export function isAutoApprovalChip(name: string | undefined): boolean {
  return typeof name === "string" && CHIP.test(name);
}
