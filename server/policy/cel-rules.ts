import type { PolicyRule } from "./cel-engine.ts";

export const DEFAULT_POLICY_RULES: PolicyRule[] = [
  {
    id: "fs-credential-isolation",
    description: "Prevent direct modification or exfiltration of credential stores and keys",
    evaluate: (ctx) => {
      if (ctx.tool === "write_file" || ctx.tool === "edit_file" || ctx.tool === "read_file") {
        const rawPath = String(ctx.args.Path || ctx.args.path || "");
        const normalized = rawPath.replace(/\\/g, "/").toLowerCase();
        if (
          normalized.includes("/.ssh/") ||
          normalized.includes("/.aws/") ||
          normalized.endsWith("/id_rsa") ||
          normalized.endsWith("/id_ed25519") ||
          normalized.includes("dusk.env") ||
          normalized.endsWith("/.env")
        ) {
          return {
            decision: "DENY",
            reason: `Access to credential path "${rawPath}" is prohibited by security policy`,
          };
        }
      }
      return null;
    },
  },
  {
    id: "fs-system-integrity",
    description: "Disallow modifications to root system directories and critical binaries",
    evaluate: (ctx) => {
      if (ctx.tool === "write_file" || ctx.tool === "edit_file") {
        const rawPath = String(ctx.args.Path || ctx.args.path || "");
        const normalized = rawPath.replace(/\\/g, "/").toLowerCase();
        if (
          normalized.startsWith("/etc/") ||
          normalized.startsWith("/usr/") ||
          normalized.startsWith("/bin/") ||
          normalized.startsWith("c:/windows/") ||
          normalized.startsWith("c:/program files/")
        ) {
          return {
            decision: "DENY",
            reason: `System directory "${rawPath}" is protected against automated modifications`,
          };
        }
      }
      return null;
    },
  },
  {
    id: "cmd-destructive-rejection",
    description: "Deny destructive shell commands that wipe filesystems or alter partition tables",
    evaluate: (ctx) => {
      if (ctx.tool === "run_command" || ctx.tool === "execute" || ctx.tool === "exec") {
        const cmd = String(ctx.args.CommandLine || ctx.args.command || "").trim();
        if (
          /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+[/\\]/i.test(cmd) ||
          /\bmkfs\b/i.test(cmd) ||
          /\bformat\s+[a-zA-Z]:/i.test(cmd) ||
          /\bdd\s+if=/i.test(cmd)
        ) {
          return {
            decision: "DENY",
            reason: "Destructive system-level disk or filesystem command rejected",
          };
        }
      }
      return null;
    },
  },
  {
    id: "browser-auth-payment-checkpoint",
    description: "Require human approval when navigating to banking, payment, or identity providers",
    evaluate: (ctx) => {
      if (ctx.tool === "browser_navigate" || ctx.tool === "agent_browser_open") {
        const url = String(ctx.args.url || ctx.args.targetUrl || "").toLowerCase();
        if (
          url.includes("accounts.google.com") ||
          url.includes("login.live.com") ||
          url.includes("appleid.apple.com") ||
          url.includes("dashboard.stripe.com") ||
          url.includes("paypal.com/signin")
        ) {
          return {
            decision: "REQUIRE_APPROVAL",
            reason: "Navigation to high-privilege identity or payment portal requires operator approval",
          };
        }
      }
      return null;
    },
  },
];
