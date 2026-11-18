export interface AcpAgentManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  homepage?: string;
  tags: string[];
  runtime: "node" | "python" | "binary";
  entrypoint: string;
  installCommand?: {
    npm?: string;
    pip?: string;
    binaryUrl?: { darwin?: string; linux?: string; win32?: string };
  };
  supportedModels: Array<{ id: string; label: string }>;
  capabilities: {
    tools?: boolean;
    prompts?: boolean;
    streaming?: boolean;
  };
}

export const VERIFIED_ACP_REGISTRY: AcpAgentManifest[] = [
  {
    id: "hermes-agent-acp",
    name: "Hermes Agent",
    description: "Autonomous open-source agent with persistent memory and multi-backend sandboxes (Docker, SSH, Modal).",
    version: "0.9.4",
    author: "Nous Research",
    homepage: "https://github.com/NousResearch/hermes-agent",
    tags: ["Autonomous", "Memory", "Sandboxing", "Local"],
    runtime: "python",
    entrypoint: "hermes acp",
    installCommand: { pip: "pip install hermes-agent" },
    supportedModels: [
      { id: "hermes-3-llama-3.1-8b", label: "Hermes 3 (8B)" },
      { id: "hermes-3-llama-3.1-70b", label: "Hermes 3 (70B)" },
    ],
    capabilities: { tools: true, prompts: true, streaming: true },
  },
  {
    id: "opencode-acp",
    name: "OpenCode",
    description: "High-performance coding agent engine with free model failover ladders and git workspace analysis.",
    version: "1.4.2",
    author: "OpenCode Project",
    homepage: "https://opencode.ai",
    tags: ["Coding", "Git", "Free Models"],
    runtime: "binary",
    entrypoint: "opencode acp",
    installCommand: {
      binaryUrl: {
        darwin: "https://releases.opencode.ai/darwin-arm64.tar.gz",
        linux: "https://releases.opencode.ai/linux-x64.tar.gz",
        win32: "https://releases.opencode.ai/win-x64.zip",
      },
    },
    supportedModels: [
      { id: "opencode-zen", label: "OpenCode Zen (Free)" },
      { id: "opencode-deepseek-v3", label: "DeepSeek V3 (Coding)" },
    ],
    capabilities: { tools: true, prompts: true, streaming: true },
  },
  {
    id: "devin-cli-acp",
    name: "Devin CLI",
    description: "Cognition Devin autonomous software engineering client over standard Agent Client Protocol.",
    version: "0.8.1",
    author: "Cognition AI",
    homepage: "https://devin.ai",
    tags: ["Coding", "Engineering", "Enterprise"],
    runtime: "node",
    entrypoint: "npx -y @cognition/devin-cli acp",
    installCommand: { npm: "npm install -g @cognition/devin-cli" },
    supportedModels: [
      { id: "devin-default", label: "Devin 2.0 Engine" },
    ],
    capabilities: { tools: true, prompts: true, streaming: true },
  },
  {
    id: "qwen-code-acp",
    name: "Qwen Code Agent",
    description: "Alibaba Qwen specialized coding agent with autonomous command approvals and large context handling.",
    version: "1.2.0",
    author: "Qwen Team",
    homepage: "https://github.com/QwenLM/qwen-agent",
    tags: ["Coding", "Multilingual", "Local"],
    runtime: "python",
    entrypoint: "qwen-code --acp",
    installCommand: { pip: "pip install qwen-agent" },
    supportedModels: [
      { id: "qwen-2.5-coder-32b", label: "Qwen 2.5 Coder 32B" },
      { id: "qwen-2.5-coder-7b", label: "Qwen 2.5 Coder 7B" },
    ],
    capabilities: { tools: true, prompts: true, streaming: true },
  },
];

export class AcpRegistryClient {
  private cache = new Map<string, AcpAgentManifest>();

  constructor(initialAgents: AcpAgentManifest[] = VERIFIED_ACP_REGISTRY) {
    for (const a of initialAgents) {
      this.cache.set(a.id, a);
    }
  }

  listAgents(filterTag?: string): AcpAgentManifest[] {
    const all = Array.from(this.cache.values());
    if (!filterTag || filterTag === "All") return all;
    return all.filter((a) => a.tags.some((t) => t.toLowerCase() === filterTag.toLowerCase()));
  }

  getAgent(id: string): AcpAgentManifest | undefined {
    return this.cache.get(id);
  }

  registerCustomManifest(manifest: AcpAgentManifest): void {
    if (!manifest.id || !manifest.name || !manifest.entrypoint) {
      throw new Error("Invalid ACP agent manifest: id, name, and entrypoint are required.");
    }
    this.cache.set(manifest.id, manifest);
  }

  searchAgents(query: string): AcpAgentManifest[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.listAgents();
    return Array.from(this.cache.values()).filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        a.author.toLowerCase().includes(q) ||
        a.tags.some((t) => t.toLowerCase().includes(q))
    );
  }
}
