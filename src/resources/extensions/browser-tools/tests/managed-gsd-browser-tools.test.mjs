import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
  MANAGED_GSD_BROWSER_TOOL_NAMES,
  registerManagedGsdBrowserTools,
  _normalizeManagedArgsForTest,
  _resetManagedGsdBrowserForTest,
  _getCloseGenerationForTest,
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

describe("normalizeManagedArgs (browser_snapshot_refs interactiveOnly translation)", () => {
  it("translates interactiveOnly:true to mode:interactive when mode is absent", () => {
    const result = _normalizeManagedArgsForTest("browser_snapshot_refs", { interactiveOnly: true });
    assert.equal(result.mode, "interactive");
    assert.equal("interactiveOnly" in result, false);
  });

  it("does not override an explicit mode when interactiveOnly:true is also set", () => {
    const result = _normalizeManagedArgsForTest("browser_snapshot_refs", { interactiveOnly: true, mode: "form" });
    assert.equal(result.mode, "form");
    assert.equal("interactiveOnly" in result, false);
  });

  it("strips interactiveOnly:false without injecting mode", () => {
    const result = _normalizeManagedArgsForTest("browser_snapshot_refs", { interactiveOnly: false });
    assert.equal("mode" in result, false);
    assert.equal("interactiveOnly" in result, false);
  });

  it("passes unrelated tool args through unchanged", () => {
    const result = _normalizeManagedArgsForTest("browser_navigate", { url: "http://localhost", interactiveOnly: true });
    assert.equal(result.url, "http://localhost");
    assert.equal(result.interactiveOnly, true);
  });
});

describe("closeManagedGsdBrowser generation counter", () => {
  it("increments closeGeneration each time close is called", async () => {
    const before = _getCloseGenerationForTest();
    await _resetManagedGsdBrowserForTest();
    assert.equal(_getCloseGenerationForTest(), before + 1);
    await _resetManagedGsdBrowserForTest();
    assert.equal(_getCloseGenerationForTest(), before + 2);
  });
});
