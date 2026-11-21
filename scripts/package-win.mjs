// runs electron-builder for windows, Authenticode-signed when the environment holds a signing identity:
// WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD (a .pfx, read by electron-builder itself) or Azure Artifact Signing (below).
// with neither the build is unsigned.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** electron-builder's win.azureSignOptions field and the variable that fills it. */
export const AZURE_SIGNING_VARIABLES = {
  endpoint: "AZURE_SIGNING_ENDPOINT",
  codeSigningAccountName: "AZURE_SIGNING_ACCOUNT",
  certificateProfileName: "AZURE_SIGNING_PROFILE",
  publisherName: "WIN_PUBLISHER_NAME",
};
/** Read by the TrustedSigning PowerShell module (Azure.Identity EnvironmentCredential), not by electron-builder. */
export const AZURE_CREDENTIAL_VARIABLES = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"];

export function winSigningArgs(env) {
  const names = [...Object.values(AZURE_SIGNING_VARIABLES), ...AZURE_CREDENTIAL_VARIABLES];
  if (!names.some((name) => env[name])) return [];
  const missing = names.filter((name) => !env[name]);
  if (missing.length) throw new Error(`Azure Artifact Signing is partly set up; missing ${missing.join(", ")}`);
  return Object.entries(AZURE_SIGNING_VARIABLES).map(([field, name]) => `-c.win.azureSignOptions.${field}=${env[name]}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cli = join(dirname(createRequire(import.meta.url).resolve("electron-builder/package.json")), "cli.js");
  const args = [cli, "--config", "build/electron-builder.yml", "--win", "--publish", "never", ...winSigningArgs(process.env), ...process.argv.slice(2)];
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  process.exit(result.status ?? 1);
}
