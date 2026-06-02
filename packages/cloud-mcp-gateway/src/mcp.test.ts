import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildGatewayToolList, CLOUD_GATEWAY_TOOL_NAMES, createGatewayMcpServer } from "./mcp.js";
import { RuntimeRegistry } from "./runtime-registry.js";
import { UsageLimiter } from "./usage-limits.js";
import { InMemoryUsageStore } from "./usage-store.js";

test("gateway advertises the unified project graph MCP tool", () => {
  assert.ok(CLOUD_GATEWAY_TOOL_NAMES.includes("gsd_graph"));
  assert.equal(CLOUD_GATEWAY_TOOL_NAMES.some((name) => name.startsWith("gsd_graph_")), false);
});

test("gateway includes runtime-advertised tools with routing fields", () => {
  const tools = buildGatewayToolList([{
    name: "browser_navigate",
    description: "Navigate",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  }]);

  const browserTool = tools.find((tool) => tool.name === "browser_navigate");
  assert.ok(browserTool);
  assert.equal(browserTool.description, "Navigate");
  assert.deepEqual(browserTool.inputSchema.required, ["url"]);
  assert.deepEqual(Object.keys(browserTool.inputSchema.properties ?? {}).sort(), [
    "projectAlias",
    "runtimeId",
    "url",
  ]);
});

test("gateway does not let runtime tools shadow built-in GSD tools", () => {
  const tools = buildGatewayToolList([{
    name: "gsd_status",
    inputSchema: { type: "object", properties: { fake: { type: "boolean" } } },
  }]);

  const matches = tools.filter((tool) => tool.name === "gsd_status");
  assert.equal(matches.length, 1);
  assert.equal("fake" in (matches[0]!.inputSchema.properties ?? {}), false);
});

test("gateway throttles MCP calls when a user exceeds quota", async () => {
  const usage = new InMemoryUsageStore();
  const usageLimiter = new UsageLimiter({
    free: { callsPerMinute: 1 },
    paid: {},
    unlimited: {},
  });
  const server = createGatewayMcpServer({
    userId: "u1",
    registry: new RuntimeRegistry(),
    usage,
    usageLimiter,
    getUser: () => ({
      userId: "u1",
      role: "member",
      plan: "free",
      createdAt: Date.now(),
    }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "quota-test", version: "0.0.1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const first = await client.callTool({ name: "gsd_cloud_projects", arguments: {} });
  assert.equal(first.isError, undefined);

  const second = await client.callTool({ name: "gsd_cloud_projects", arguments: {} });
  assert.equal(second.isError, true);
  const text = (second.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
  assert.match(text, /Usage limit exceeded/);

  const summary = usage.getSummary();
  assert.equal(summary.billableCalls, 1);
  assert.equal(summary.throttledCalls, 1);
  await client.close();
  await server.close();
});
