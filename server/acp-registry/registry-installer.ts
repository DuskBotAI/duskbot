import { AcpRegistryClient } from "./registry-client.ts";

export interface InstalledAgentRecord {
  agentId: string;
  version: string;
  installedAt: number;
  entrypoint: string;
  runtime: string;
  status: "installed" | "updating" | "failed";
}

export class AcpRegistryInstaller {
  private registry: AcpRegistryClient;
  private installed = new Map<string, InstalledAgentRecord>();

  constructor(registry = new AcpRegistryClient()) {
    this.registry = registry;
  }

  isInstalled(agentId: string): boolean {
    return this.installed.has(agentId);
  }

  getInstalledRecord(agentId: string): InstalledAgentRecord | undefined {
    return this.installed.get(agentId);
  }

  listInstalled(): InstalledAgentRecord[] {
    return Array.from(this.installed.values());
  }

  async installAgent(agentId: string): Promise<InstalledAgentRecord> {
    const manifest = this.registry.getAgent(agentId);
    if (!manifest) {
      throw new Error(`ACP agent "${agentId}" not found in registry.`);
    }

    const record: InstalledAgentRecord = {
      agentId: manifest.id,
      version: manifest.version,
      installedAt: Date.now(),
      entrypoint: manifest.entrypoint,
      runtime: manifest.runtime,
      status: "installed",
    };

    this.installed.set(agentId, record);
    return record;
  }

  async uninstallAgent(agentId: string): Promise<boolean> {
    return this.installed.delete(agentId);
  }

  generateInstanceConfig(agentId: string): { driver: string; displayName: string; config: { cli: string } } {
    const manifest = this.registry.getAgent(agentId);
    if (!manifest) throw new Error(`Agent "${agentId}" not found in registry`);

    return {
      driver: "customAcp",
      displayName: manifest.name,
      config: { cli: manifest.entrypoint },
    };
  }
}
