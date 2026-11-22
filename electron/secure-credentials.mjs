import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileDurably } from "./desktop-prefs.mjs";
import { migrateWorkspaceCredentials } from "./workspace-credentials.mjs";

// "unavailable" (could not read) must never look like "empty": a caller would register a fresh installation over the real one.
// macOS says "temporarily unavailable. Please try again." for a keychain that is busy at launch, so retry briefly first.
export const CREDENTIAL_READ_DELAYS_MS = [100, 200, 400, 800];

const message = (error) => (error instanceof Error ? error.message : String(error));

/** "unreadable": the store works (a fresh value round-trips) but this file does not open with it, so it can be set aside
 * instead of blocking every later save: a truncated write, or a Safe Storage keychain item that was deleted or replaced. */
export async function readSecureCredentials({
  exists,
  isAvailable,
  readFile,
  decrypt,
  sleep,
  roundTrips = async () => false,
  delays = CREDENTIAL_READ_DELAYS_MS,
}) {
  if (!exists()) return { status: "empty", credentials: {} };
  const unreadable = async (error) => ((await roundTrips().catch(() => false))
    ? { status: "unreadable", credentials: {}, error }
    : { status: "unavailable", credentials: {}, error });

  let lastError = "the operating-system credential store is unavailable";
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await sleep(delays[attempt - 1]);
    try {
      if (!(await isAvailable())) {
        lastError = "the operating-system credential store is unavailable";
        continue;
      }
      const encrypted = readFile();
      if (!encrypted?.length) return unreadable("the credential store file is empty");
      const decrypted = await decrypt(encrypted);
      const text = typeof decrypted === "string" ? decrypted : decrypted?.result;
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return unreadable("the credential store is not readable");
        return { status: "ok", credentials: parsed };
      } catch {
        return unreadable("the credential store is not readable");
      }
    } catch (error) {
      lastError = message(error);
    }
  }
  return unreadable(lastError);
}

/** The encrypted credentials.bin behind Electron's safeStorage. `unavailable()` is true when the store could not be read,
 * which is not the same as nothing saved. */
export function createCredentialFile({ file, safeStorage, log }) {
  let unavailable = false;
  async function load() {
    const result = await readSecureCredentials({
      exists: () => fs.existsSync(file),
      isAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
      readFile: () => fs.readFileSync(file),
      decrypt: (buffer) => safeStorage.decryptStringAsync(buffer),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      roundTrips: async () => {
        const probe = randomUUID();
        const opened = await safeStorage.decryptStringAsync(await safeStorage.encryptStringAsync(probe));
        return (typeof opened === "string" ? opened : opened?.result) === probe;
      },
    });
    if (result.status === "unreadable") {
      const aside = `${file}.unreadable-${Date.now()}`;
      try {
        fs.renameSync(file, aside);
        log(`credential store file does not open with this keychain (${result.error}); kept it as ${path.basename(aside)} and started an empty one`);
      } catch (error) {
        log(`credential store file could not be set aside (${error?.message ?? error}); saved keys are not loaded this launch`);
        unavailable = true;
        return {};
      }
    }
    unavailable = result.status === "unavailable";
    if (unavailable) {
      log(`credential store unreadable after retries (${result.error}); saved keys are not loaded this launch`);
    }
    return result.credentials;
  }
  async function save(credentials) {
    // Writing from an unread store would drop the secrets it could not read.
    if (unavailable) {
      throw new Error("The operating-system credential store could not be read this launch");
    }
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new Error("The operating-system credential store is unavailable");
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(credentials));
    writeFileDurably(file, encrypted);
  }
  return { load, save, unavailable: () => unavailable };
}

function writeConfig(configPath, config) {
  const temporary = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, configPath);
}

/** Moves a plaintext Composio key out of config.json into `credentials` (in place) and drops unread legacy fields. */
export async function secureComposioConfig({ configPath, credentials, save, log }) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!config?.composio || typeof config.composio !== "object") return;
    let changed = false;
    const apiKey = config?.composio?.apiKey;
    if (typeof apiKey === "string" && apiKey.trim()) {
      if (!credentials.composioApiKey) {
        const key = apiKey.trim();
        await save({ ...credentials, composioApiKey: key });
        credentials.composioApiKey = key;
      }
      config.composio.apiKey = "";
      changed = true;
    }
    // Unread legacy fields, removed so an unused secret is not left in plaintext.
    for (const field of ["key", "url"]) {
      if (Object.hasOwn(config.composio, field)) {
        delete config.composio[field];
        changed = true;
      }
    }
    if (!changed) return;
    writeConfig(configPath, config);
  } catch (error) {
    if (error?.code !== "ENOENT") log(`credential migration failed: ${error?.message ?? error}`);
  }
}

/** Moves plaintext workspace secrets out of config.json; returns the credentials to keep using. */
export async function secureWorkspaceConfig({ configPath, credentials, save, log }) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const migrated = migrateWorkspaceCredentials(config, credentials);
    // credentials.bin first, so a failed save never loses the only copy of a secret.
    if (migrated.credentialsChanged) await save(migrated.credentials);
    credentials = migrated.credentials;
    if (!migrated.configChanged) return credentials;
    writeConfig(configPath, migrated.config);
  } catch (error) {
    if (error?.code !== "ENOENT") log(`credential migration failed: ${error?.message ?? error}`);
  }
  return credentials;
}
