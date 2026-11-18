import { describe, expect, it } from "vitest";

import { AcpRegistryClient } from "./registry-client.ts";
import { AcpRegistryInstaller } from "./registry-installer.ts";

describe("ACP Registry & Dynamic Community Agents", () => {
  it("initializes registry with verified community agents", () => {
    const client = new AcpRegistryClient();
    const agents = client.listAgents();

    expect(agents.length).toBeGreaterThanOrEqual(4);
    const hermes = client.getAgent("hermes-agent-acp");
    expect(hermes?.name).toBe("Hermes Agent");
    expect(hermes?.runtime).toBe("python");
  });

  it("filters agents by tag and performs fuzzy search", () => {
    const client = new AcpRegistryClient();
    const codingAgents = client.listAgents("Coding");

    expect(codingAgents.some((a) => a.id === "opencode-acp")).toBe(true);

    const searchResults = client.searchAgents("cognition");
    expect(searchResults.length).toBe(1);
    expect(searchResults[0].id).toBe("devin-cli-acp");
  });

  it("installs, configures, and uninstalls community agents dynamically", async () => {
    const client = new AcpRegistryClient();
    const installer = new AcpRegistryInstaller(client);

    expect(installer.isInstalled("opencode-acp")).toBe(false);

    const record = await installer.installAgent("opencode-acp");
    expect(record.status).toBe("installed");
    expect(installer.isInstalled("opencode-acp")).toBe(true);

    const config = installer.generateInstanceConfig("opencode-acp");
    expect(config.driver).toBe("customAcp");
    expect(config.displayName).toBe("OpenCode");
    expect(config.config.cli).toBe("opencode acp");

    const uninstalled = await installer.uninstallAgent("opencode-acp");
    expect(uninstalled).toBe(true);
    expect(installer.isInstalled("opencode-acp")).toBe(false);
  });
});
