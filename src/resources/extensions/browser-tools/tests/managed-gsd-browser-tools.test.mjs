import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
  MANAGED_GSD_BROWSER_TOOL_NAMES,
  registerManagedGsdBrowserTools,
} = await import("../engine/managed-gsd-browser.ts");

describe("registerManagedGsdBrowserTools", () => {
  it("registers the curated Pi browser contract", () => {
    const tools = [];
    registerManagedGsdBrowserTools({
      registerTool(tool) {
        tools.push(tool);
      },
    });

    assert.deepEqual(tools.map((tool) => tool.name), [...MANAGED_GSD_BROWSER_TOOL_NAMES]);
    assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
  });

  it("keeps screenshots marked as image-producing evidence", () => {
    const tools = [];
    registerManagedGsdBrowserTools({
      registerTool(tool) {
        tools.push(tool);
      },
    });

    const screenshot = tools.find((tool) => tool.name === "browser_screenshot");
    assert.equal(screenshot?.compatibility?.producesImages, true);
  });
});
