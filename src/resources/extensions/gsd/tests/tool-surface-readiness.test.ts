// Project/App: gsd-pi
// File Purpose: Contract coverage for the Tool Surface Readiness gate and its recovery classification.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { getToolSurfaceReadinessError } from "../tool-surface-readiness.ts";
import { isToolUnavailableError } from "../auto-tool-tracking.ts";
import { classifyError, isTransient } from "../error-classifier.ts";
import { toMcpToolName } from "../mcp-tool-name.ts";
import { classifyFailure } from "../recovery-classification.ts";

const SERVER = "gsd-workflow";

function prefixed(tool: string): string {
  return toMcpToolName(SERVER, tool);
}

const RUN_UAT_TOOLS = [
  "gsd_uat_exec",
  "gsd_uat_result_save",
  "gsd_resume",
  "gsd_milestone_status",
  "gsd_journal_query",
];

describe("getToolSurfaceReadinessError", () => {
  test("returns null when no unit type or no workflow server is in play", () => {
    const observation = { tools: [], mcpServers: [] };
    assert.equal(
      getToolSurfaceReadinessError({ unitType: undefined, workflowServerName: SERVER, observation }),
      null,
    );
    assert.equal(
      getToolSurfaceReadinessError({ unitType: "run-uat", workflowServerName: undefined, observation }),
      null,
    );
  });

  test("returns null for units with no required workflow tools", () => {
    const error = getToolSurfaceReadinessError({
      unitType: "rewrite-docs",
      workflowServerName: SERVER,
      observation: { tools: [], mcpServers: [{ name: SERVER, status: "failed" }] },
    });
    assert.equal(error, null);
  });

  test("returns an error when the expected workflow server is absent from the init surface", () => {
    const error = getToolSurfaceReadinessError({
      unitType: "run-uat",
      workflowServerName: SERVER,
      observation: { tools: ["read", "bash"], mcpServers: [{ name: "other-server", status: "connected" }] },
    });
    assert.ok(error, "expected a readiness error when the workflow server is absent");
    assert.match(error, /workflow tool surface not ready for run-uat/);
    assert.match(error, /absent from the init surface/);
    assert.match(error, /gsd_uat_exec/);
  });

  test("passes a still-connecting (pending) server through instead of aborting", () => {
    // The SDK reports still-connecting servers as "pending" at init — the
    // common healthy session. A genuine miss after pass-through is caught
    // in-session ("No such tool available" → tool-unavailable → retry).
    const error = getToolSurfaceReadinessError({
      unitType: "plan-slice",
      workflowServerName: SERVER,
      observation: { tools: ["read", "bash"], mcpServers: [{ name: SERVER, status: "pending" }] },
    });
    assert.equal(error, null);
  });

  test("returns null when all required tools are registered under the MCP prefix", () => {
    const error = getToolSurfaceReadinessError({
      unitType: "run-uat",
      workflowServerName: SERVER,
      observation: {
        tools: ["read", ...RUN_UAT_TOOLS.map(prefixed)],
        mcpServers: [{ name: SERVER, status: "connected" }],
      },
    });
    assert.equal(error, null);
  });

  test("reports the failed server and the missing tools when the surface never registered", () => {
    const error = getToolSurfaceReadinessError({
      unitType: "run-uat",
      workflowServerName: SERVER,
      observation: { tools: ["read", "bash"], mcpServers: [{ name: SERVER, status: "failed" }] },
    });
    assert.ok(error, "expected a readiness error");
    assert.match(error, /workflow tool surface not ready for run-uat/);
    assert.match(error, /status is "failed"/);
    assert.match(error, /gsd_uat_exec/);
  });

  test("aborts on needs-auth (terminal — cannot self-heal)", () => {
    const error = getToolSurfaceReadinessError({
      unitType: "run-uat",
      workflowServerName: SERVER,
      observation: { tools: ["read", "bash"], mcpServers: [{ name: SERVER, status: "needs-auth" }] },
    });
    assert.ok(error, "expected a readiness error for needs-auth");
    assert.match(error, /status is "needs-auth"/);
  });

  test("aborts on disabled (terminal — cannot self-heal)", () => {
    const error = getToolSurfaceReadinessError({
      unitType: "run-uat",
      workflowServerName: SERVER,
      observation: { tools: ["read", "bash"], mcpServers: [{ name: SERVER, status: "disabled" }] },
    });
    assert.ok(error, "expected a readiness error for disabled");
    assert.match(error, /status is "disabled"/);
  });

  test("reports partially-registered surfaces even when the server says connected", () => {
    const error = getToolSurfaceReadinessError({
      unitType: "run-uat",
      workflowServerName: SERVER,
      observation: {
        tools: [prefixed("gsd_uat_exec")],
        mcpServers: [{ name: SERVER, status: "connected" }],
      },
    });
    assert.ok(error, "expected a readiness error");
    assert.match(error, /connected but has not registered/);
    assert.match(error, /gsd_uat_result_save/);
    assert.doesNotMatch(error, /gsd_uat_exec,/);
  });
});

describe("readiness error classification contract", () => {
  const readinessError = getToolSurfaceReadinessError({
    unitType: "run-uat",
    workflowServerName: SERVER,
    observation: { tools: [], mcpServers: [{ name: SERVER, status: "failed" }] },
  })!;

  test("auto-tool-tracking treats the readiness error as tool-unavailable", () => {
    assert.equal(isToolUnavailableError(readinessError), true);
  });

  test("error-classifier treats the readiness error as transient", () => {
    const cls = classifyError(`Claude Code error: ${readinessError}`);
    assert.equal(isTransient(cls), true);
  });

  test("Recovery Classification maps the readiness error to tool-unavailable → retry", () => {
    const recovery = classifyFailure({ error: new Error(readinessError), unitType: "run-uat", unitId: "M001" });
    assert.equal(recovery.failureKind, "tool-unavailable");
    assert.equal(recovery.action, "retry");
    assert.equal(recovery.exitReason, "tool-unavailable");
  });
});
