import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const jiti = require("jiti")(__dirname, { interopDefault: true, debug: false });

const { resolveBrowserEngineMode } = jiti("../engine/selection.ts");

describe("resolveBrowserEngineMode", () => {
  it("defaults to gsd-browser", () => {
    assert.equal(resolveBrowserEngineMode({}), "gsd-browser");
  });

  it("accepts the explicit engine modes", () => {
    assert.equal(resolveBrowserEngineMode({ GSD_BROWSER_ENGINE: "gsd-browser" }), "gsd-browser");
    assert.equal(resolveBrowserEngineMode({ GSD_BROWSER_ENGINE: "legacy" }), "legacy");
    assert.equal(resolveBrowserEngineMode({ GSD_BROWSER_ENGINE: "off" }), "off");
  });

  it("accepts compatibility aliases", () => {
    assert.equal(resolveBrowserEngineMode({ GSD_BROWSER_ENGINE: "playwright" }), "legacy");
    assert.equal(resolveBrowserEngineMode({ GSD_BROWSER_ENGINE: "false" }), "off");
  });

  it("rejects unknown engine modes", () => {
    assert.throws(
      () => resolveBrowserEngineMode({ GSD_BROWSER_ENGINE: "surprise" }),
      /Expected "gsd-browser", "legacy", or "off"/,
    );
  });
});
