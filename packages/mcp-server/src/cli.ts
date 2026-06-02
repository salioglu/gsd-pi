/**
 * @opengsd/mcp-server CLI — stdio transport entry point.
 *
 * Connects the MCP server to stdin/stdout for use by Claude Code,
 * Cursor, and other MCP-compatible clients.
 */

import { SessionManager } from './session-manager.js';
import { createMcpServer } from './server.js';
import { installGlobalErrorHandlers } from './cli-errors.js';
import { listenHttpMcpServer } from './http.js';
import { loadStoredCredentialEnvKeys } from './tool-credentials.js';
import { parseArgs } from 'node:util';

const MCP_PKG = '@modelcontextprotocol/sdk';

installGlobalErrorHandlers();

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      http: { type: 'boolean', default: false },
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '8787' },
      'auth-token': { type: 'string' },
      'no-auth': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(`Usage: gsd-mcp-server [--http] [--host <host>] [--port <port>] [--auth-token <token>] [--no-auth]

Transports:
  default stdio                 Local MCP clients that spawn the process
  --http                        Streamable HTTP endpoint at /mcp

Cloud HTTP auth:
  GSD_MCP_AUTH_TOKEN            Bearer token for HTTP clients
  --auth-token <token>          Equivalent CLI override
  --no-auth                     Explicitly allow unauthenticated HTTP

Examples:
  gsd-mcp-server
  GSD_MCP_AUTH_TOKEN="$(openssl rand -hex 32)" gsd-mcp-server --http --host 0.0.0.0 --port 8787
`);
    return;
  }

  loadStoredCredentialEnvKeys();

  const sessionManager = new SessionManager();

  if (values.http) {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`invalid --port: ${values.port}`);
    }
    const authToken = values['auth-token'] ?? process.env.GSD_MCP_AUTH_TOKEN;
    const listener = await listenHttpMcpServer(sessionManager, {
      host: values.host,
      port,
      authToken,
      allowNoAuth: values['no-auth'],
    });
    process.stderr.write(`[gsd-mcp-server] MCP server started on ${listener.url}\n`);

    let cleaningUp = false;
    async function cleanup(): Promise<void> {
      if (cleaningUp) return;
      cleaningUp = true;
      process.stderr.write('[gsd-mcp-server] Shutting down...\n');
      try {
        await listener.close();
      } catch {
        // swallow close errors
      }
      try {
        await sessionManager.cleanup();
      } catch {
        // swallow cleanup errors
      }
      process.exit(0);
    }

    process.on('SIGTERM', () => void cleanup());
    process.on('SIGINT', () => void cleanup());
    return;
  }

  // Create the configured MCP server with session, interactive, read-only,
  // and workflow tools.
  const { server } = await createMcpServer(sessionManager);

  // Dynamic import for StdioServerTransport (same TS subpath workaround)
  const { StdioServerTransport } = await import(`${MCP_PKG}/server/stdio.js`);
  const transport = new StdioServerTransport();

  // Cleanup handler — stop all sessions before exiting
  let cleaningUp = false;
  async function cleanup(): Promise<void> {
    if (cleaningUp) return;
    cleaningUp = true;
    process.stderr.write('[gsd-mcp-server] Shutting down...\n');
    try {
      await sessionManager.cleanup();
    } catch {
      // swallow cleanup errors
    }
    try {
      await server.close();
    } catch {
      // swallow close errors
    }
    process.exit(0);
  }

  process.on('SIGTERM', () => void cleanup());
  process.on('SIGINT', () => void cleanup());

  // Handle stdin end — MCP client disconnected
  process.stdin.on('end', () => void cleanup());

  // Connect and start serving
  try {
    await server.connect(transport);
    process.stderr.write('[gsd-mcp-server] MCP server started on stdio\n');
  } catch (err) {
    process.stderr.write(
      `[gsd-mcp-server] Fatal: failed to start — ${err instanceof Error ? err.message : String(err)}\n`
    );
    await sessionManager.cleanup();
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(
    `[gsd-mcp-server] Fatal: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exit(1);
});
