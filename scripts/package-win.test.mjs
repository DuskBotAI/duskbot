import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { browserBundleSpec } from "../server/browser-bundle-release.ts";
import { AZURE_CREDENTIAL_VARIABLES, AZURE_SIGNING_VARIABLES, winSigningArgs } from "./package-win.mjs";

const builder = createRequire(createRequire(import.meta.url).resolve("electron-builder/package.json"));
builder("app-builder-lib");
const { WinPackager } = builder("app-builder-lib/out/winPackager");
const config = builder("js-yaml").load(readFileSync(new URL("../build/electron-builder.yml", import.meta.url), "utf8"));
const signs = (file) => WinPackager.prototype.shouldSignFile.call({ platformSpecificBuildOptions: config.win }, file, true);

const azure = Object.fromEntries([...Object.values(AZURE_SIGNING_VARIABLES), ...AZURE_CREDENTIAL_VARIABLES].map((name) => [name, `${name}-value`]));

describe("windows signing", () => {
  it("builds unsigned when no signing identity is set", () => {
    expect(winSigningArgs({})).toEqual([]);
    expect(winSigningArgs({ WIN_CSC_LINK: "cert", WIN_CSC_KEY_PASSWORD: "pw" })).toEqual([]);
  });

  it("turns on Azure Artifact Signing only when every value is set", () => {
    expect(winSigningArgs({ ...azure, WIN_PUBLISHER_NAME: "dusk bot, Inc." })).toEqual([
      "-c.win.azureSignOptions.endpoint=AZURE_SIGNING_ENDPOINT-value",
      "-c.win.azureSignOptions.codeSigningAccountName=AZURE_SIGNING_ACCOUNT-value",
      "-c.win.azureSignOptions.certificateProfileName=AZURE_SIGNING_PROFILE-value",
      "-c.win.azureSignOptions.publisherName=dusk bot, Inc.",
    ]);
    expect(() => winSigningArgs({ ...azure, AZURE_CLIENT_SECRET: "" })).toThrow(/missing AZURE_CLIENT_SECRET/);
  });

  it("signs the app, installer, uninstaller and derived cua daemon, never a pinned or vendor-signed executable", () => {
    for (const file of ["Dusk Bot.exe", "DuskBot-0.2.25-setup.exe", "__uninstaller-nsis-duskbot.exe", "C:\\r\\resources\\cua-driver-background.exe", "elevate.exe"]) {
      expect(signs(file), file).toBe(true);
    }
    const browser = browserBundleSpec("win32-x64");
    for (const file of ["C:\\r\\resources\\cloudflared\\cloudflared.exe", "C:\\r\\resources\\cua-driver.exe", basename(browser.engine.executable), basename(browser.chrome.executable)]) {
      expect(signs(file), file).toBe(false);
    }
  });
});
