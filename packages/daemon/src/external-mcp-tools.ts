import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";

export interface ExternalMcpToolConfig {
  id: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface ExternalMcpToolExecution {
  handled: boolean;
  result?: unknown;
}

interface ExternalMcpConnection {
  client: Client;
  transport: StdioClientTransport;
}

const DEFAULT_BROWSER_MCP_ID = "gsd-browser";

export class ExternalMcpToolBridge {
  private readonly connections = new Map<string, ExternalMcpConnection>();
  private readonly toolRoutes = new Map<string, string>();

  constructor(private readonly configs: ExternalMcpToolConfig[]) {}

  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): ExternalMcpToolBridge {
    return new ExternalMcpToolBridge(readExternalMcpToolConfigs(env));
  }

  async advertisedTools(): Promise<Tool[]> {
    const tools: Tool[] = [];
    const seen = new Set<string>();
    this.toolRoutes.clear();
    for (const config of this.configs) {
      try {
        const connection = await this.connectionFor(config);
        const result = await connection.client.listTools(undefined, { timeout: 10_000 });
        for (const tool of result.tools) {
          if (seen.has(tool.name)) continue;
          seen.add(tool.name);
          this.toolRoutes.set(tool.name, config.id);
          tools.push(tool);
        }
      } catch {
        await this.closeConnection(config.id);
      }
    }
    return tools.sort((a, b) => a.name.localeCompare(b.name));
  }

  async executeIfAvailable(toolName: string, args: Record<string, unknown>): Promise<ExternalMcpToolExecution> {
    const configId = this.toolRoutes.get(toolName);
    if (!configId) return { handled: false };

    const config = this.configs.find((candidate) => candidate.id === configId);
    if (!config) return { handled: false };

    try {
      const connection = await this.connectionFor(config);
      const result = await connection.client.callTool(
        { name: toolName, arguments: args },
        CallToolResultSchema,
        { timeout: 10 * 60 * 1000, resetTimeoutOnProgress: true },
      );
      return { handled: true, result };
    } catch (err) {
      await this.closeConnection(config.id);
      throw err;
    }
  }

  async close(): Promise<void> {
    await Promise.all(Array.from(this.connections.keys()).map((id) => this.closeConnection(id)));
  }

  private async connectionFor(config: ExternalMcpToolConfig): Promise<ExternalMcpConnection> {
    const existing = this.connections.get(config.id);
    if (existing) return existing;

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      ...(config.cwd ? { cwd: config.cwd } : {}),
      ...(config.env ? { env: config.env } : {}),
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => {
      // Drain child stderr so a noisy MCP server cannot block on a full pipe.
    });
    const client = new Client({ name: `gsd-cloud-runtime-${config.id}`, version: "1.0.0" });
    try {
      await client.connect(transport, { timeout: 10_000 });
    } catch (err) {
      await transport.close().catch(() => undefined);
      throw err;
    }
    const connection = { client, transport };
    this.connections.set(config.id, connection);
    return connection;
  }

  private async closeConnection(id: string): Promise<void> {
    const connection = this.connections.get(id);
    this.connections.delete(id);
    if (!connection) return;
    try {
      await connection.client.close();
    } catch {
      try {
        await connection.transport.close();
      } catch {
        // Best-effort cleanup only; the caller is already handling the real failure.
      }
    }
  }
}

function readExternalMcpToolConfigs(env: NodeJS.ProcessEnv): ExternalMcpToolConfig[] {
  const explicit = parseExplicitConfigs(env.GSD_CLOUD_MCP_SERVERS);
  if (explicit) return explicit;

  const browserFlag = env.GSD_CLOUD_BROWSER_MCP?.trim().toLowerCase();
  if (browserFlag === "0" || browserFlag === "false" || browserFlag === "off") return [];

  return [{
    id: DEFAULT_BROWSER_MCP_ID,
    command: env.GSD_CLOUD_BROWSER_MCP_COMMAND || env.GSD_BROWSER_MCP_COMMAND || "gsd-browser",
    args: parseArgsValue(env.GSD_CLOUD_BROWSER_MCP_ARGS || env.GSD_BROWSER_MCP_ARGS, ["mcp"]),
  }];
}

function parseExplicitConfigs(value: string | undefined): ExternalMcpToolConfig[] | undefined {
  if (!value?.trim()) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("GSD_CLOUD_MCP_SERVERS must be a JSON array");
  return parsed.map((item, index) => {
    if (!isRecord(item) || typeof item.command !== "string" || !item.command.trim()) {
      throw new Error(`GSD_CLOUD_MCP_SERVERS[${index}] must include command`);
    }
    return {
      id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `external-${index + 1}`,
      command: item.command,
      args: parseArgsValue(item.args, []),
      ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}),
      ...(isStringRecord(item.env) ? { env: item.env } : {}),
    };
  });
}

function parseArgsValue(value: unknown, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string");
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
