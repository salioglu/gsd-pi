// Project/App: gsd-pi
// File Purpose: Regression coverage for native platform dependency version sync.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("sync-platform-versions keeps root native optional dependencies exact", () => {
  const script = readFileSync("native/scripts/sync-platform-versions.cjs", "utf8");

  assert.match(script, /optionalDependencies/);
  assert.match(script, /`@opengsd\/engine-\$\{platform\}`/);
  assert.doesNotMatch(script, /range specifiers/);
  assert.doesNotMatch(script, />=/);
});

test("prepublish verifies matching native platform packages before publishing main package", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));

  assert.match(pkg.scripts.prepublishOnly, /verify:native-platform-packages/);
  assert.ok(
    pkg.scripts.prepublishOnly.indexOf("verify:native-platform-packages") <
      pkg.scripts.prepublishOnly.indexOf("validate-pack"),
  );
});

test("root package pins native optional dependencies to its own version", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const nativeDeps = Object.entries(pkg.optionalDependencies).filter(([name]) =>
    name.startsWith("@opengsd/engine-"),
  );

  assert.equal(nativeDeps.length, 5);
  for (const [name, spec] of nativeDeps) {
    assert.equal(spec, pkg.version, `${name} must match root package version`);
  }
});
