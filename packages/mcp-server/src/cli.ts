/**
 * @opengsd/mcp-server CLI — stdio transport entry point.
 *
 * Connects the MCP server to stdin/stdout for use by Claude Code,
 * Cursor, and other MCP-compatible clients.
 */

import { SessionManager } from './session-manager.js';
import { createMcpServer } from './server.js';
import { installGlobalErrorHandlers } from './cli-errors.js';
import { loadStoredCredentialEnvKeys } from './tool-credentials.js';
import { warmWorkflowToolBridges } from './workflow-tools.js';

const MCP_PKG = '@modelcontextprotocol/sdk';

installGlobalErrorHandlers();

async function main(): Promise<void> {
  loadStoredCredentialEnvKeys();

  const sessionManager = new SessionManager();

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

  // Connect and start serving. The workflow bridges are warmed eagerly so a
  // broken executor/write-gate module fails the spawn with an actionable
  // error instead of advertising tools that error on their first call.
  try {
    await Promise.all([server.connect(transport), warmWorkflowToolBridges()]);
    process.stderr.write('[gsd-mcp-server] MCP server started on stdio; workflow bridges ready\n');
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
