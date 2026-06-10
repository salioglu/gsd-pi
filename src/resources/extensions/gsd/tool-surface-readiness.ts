// Project/App: gsd-pi
// File Purpose: Tool Contract module's runtime face — verify the live SDK tool surface covers a Unit's required workflow tools.

import { mcpToolMatchesBaseName } from "./mcp-tool-name.js";
import { getRequiredWorkflowToolsForUnit } from "./unit-tool-contracts.js";
import { isWorkflowToolSurfaceName } from "./workflow-tool-surface.js";

/**
 * Stable phrase recognized as transient by auto-tool-tracking's
 * isToolUnavailableError and error-classifier's transient buckets,
 * which build their matchers from this constant.
 */
export const TOOL_SURFACE_NOT_READY = "workflow tool surface not ready";

/** MCP server statuses that will not self-heal within the session. */
const TERMINAL_MCP_SERVER_STATUSES = new Set(["failed", "needs_auth"]);

export interface LiveToolSurfaceObservation {
  /** Tool names the session reported at init (MCP tools appear as mcp__<server>__<tool>). */
  tools: readonly string[];
  /** MCP server connection statuses the session reported at init. */
  mcpServers: readonly { name: string; status: string }[];
}

/**
 * Verify the live tool surface observed at SDK session init covers the Unit's
 * required workflow tools. Complements the static pre-dispatch gate
 * (getWorkflowTransportSupportError), which only proves the MCP launch config
 * is discoverable — the workflow server connects asynchronously after session
 * start, so the static gate cannot see whether the tools actually registered.
 *
 * Returns a transient, recovery-classifiable error (kind tool-unavailable →
 * retry) when the workflow server failed or has not yet registered a required
 * tool, so dispatch aborts before the first model turn instead of letting the
 * Unit improvise around "No such tool available". Returns null when no
 * workflow server is part of this session (native tool path), when the Unit
 * requires no workflow tools, or when the surface is ready.
 */
export function getToolSurfaceReadinessError(input: {
  unitType: string | undefined;
  workflowServerName: string | undefined;
  observation: LiveToolSurfaceObservation;
}): string | null {
  const { unitType, workflowServerName, observation } = input;
  if (!unitType || !workflowServerName) return null;

  const required = getRequiredWorkflowToolsForUnit(unitType).filter(isWorkflowToolSurfaceName);
  if (required.length === 0) return null;

  const server = observation.mcpServers.find((entry) => entry.name === workflowServerName);
  if (!server) {
    return `${TOOL_SURFACE_NOT_READY} for ${unitType}: MCP server "${workflowServerName}" is absent from the init surface (not yet connected): ${required.join(", ")}`;
  }

  // The SDK does not wait for MCP servers before init — a still-connecting
  // server reports "pending" there routinely, then registers within seconds,
  // usually well before the Unit's first workflow tool call. Aborting on
  // "pending" would fail the common healthy session, so it passes through;
  // a genuine miss after pass-through still surfaces in-session as
  // "No such tool available" and classifies tool-unavailable → bounded retry.
  // Only statuses that cannot self-heal abort here.
  if (server.status !== "connected" && !TERMINAL_MCP_SERVER_STATUSES.has(server.status)) {
    return null;
  }

  const missing = required.filter(
    (tool) => !observation.tools.some((name) => name === tool || mcpToolMatchesBaseName(name, tool)),
  );
  if (missing.length === 0) return null;

  const serverDetail =
    server.status === "connected"
      ? `MCP server "${workflowServerName}" is connected but has not registered`
      : `MCP server "${workflowServerName}" status is "${server.status}" and it has not registered`;
  return `${TOOL_SURFACE_NOT_READY} for ${unitType}: ${serverDetail}: ${missing.join(", ")}`;
}
