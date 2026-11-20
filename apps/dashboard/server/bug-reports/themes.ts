/** what a report is about, read from its words; the first rule that matches wins, so the order is the precedence */
export const BUG_REPORT_THEMES = ["phone", "updates", "sign-in and providers", "models", "errors", "look and feel", "feature request", "praise", "other"] as const;
export type BugReportTheme = (typeof BUG_REPORT_THEMES)[number];

const RULES: ReadonlyArray<[BugReportTheme, RegExp]> = [
  ["phone", /\b(?:i?phone|ios|android|mobile|pairing|paired|pair|tailscale)\b/],
  ["updates", /\b(?:update|updates|updating|reinstall|appimage|auto.?updates?)\b/],
  ["sign-in and providers", /\b(?:sign(?:ed)?[ -]?in|log(?:ged)?[ -]?in|login|api key|opencode|provider|providers|subscription|disconnect|connections?|x-opencode-session|antigravity)\b/],
  ["models", /\b(?:model|models|sonnet|opus|gpt|gemini|deepseek|effort|thinking|reasoning)\b/],
  ["errors", /\b(?:error|errors|bug|fails?|failed|failing|broken|crash(?:es|ed)?|mcp|stuck|freez\w*|doesn't work|not work\w*|won't|can't|cannot)\b/],
  ["look and feel", /\b(?:overlap\w*|layout|ui|dock|island|notch|sidebar|button|zoom\w*|colou?rs?|lag\w*|slow|stutter\w*|pin|scroll\w*|dark|theme)\b/],
  ["feature request", /\b(?:add|would be|feature|allow|could you|option|integration|support for|wish|please make)\b/],
  ["praise", /\b(?:love|great|awesome|amazing|insane|good|nice|best|congrats|thanks?|thx|cool)\b/],
];

export function themeOf(description: string): BugReportTheme {
  const text = description.toLowerCase();
  for (const [theme, rule] of RULES) if (rule.test(text)) return theme;
  return "other";
}
export const isTheme = (value: unknown): value is BugReportTheme => typeof value === "string" && (BUG_REPORT_THEMES as readonly string[]).includes(value);
