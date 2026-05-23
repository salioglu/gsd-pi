// Project/App: GSD-2
// File Purpose: Regression tests for native binary publish workflow resilience.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import YAML from "yaml";

const workflow = YAML.parse(
  readFileSync(".github/workflows/build-native.yml", "utf8"),
);
const publishJob = workflow.jobs.publish;

test("build-native exposes platform_packages_only bootstrap input", () => {
  const input = workflow.on.workflow_dispatch.inputs.platform_packages_only;

  assert.equal(input.default, "false");
  assert.deepEqual(input.options, ["false", "true"]);
});

test("build-native publish uses resilient engine package script", () => {
  const step = publishJob.steps.find(
    (entry) => entry.name === "Publish platform packages",
  );

  assert.ok(step, "publish job must publish platform packages");
  assert.match(step.run, /publish-engine-packages\.sh/);
  assert.equal(step.env.TAG_FLAG, "${{ steps.version-check.outputs.tag_flag }}");
});

test("build-native can skip main package when bootstrapping engine packages", () => {
  const gatedSteps = [
    "Install dependencies",
    "Build",
    "Verify dist exists",
    "Validate package is installable",
    "Publish main package",
    "Post-publish smoke test",
  ];

  for (const name of gatedSteps) {
    const step = publishJob.steps.find((entry) => entry.name === name);
    assert.ok(step, `expected publish job step ${name}`);
    assert.match(
      step.if,
      /platform_packages_only != 'true'/,
      `${name} must skip when platform_packages_only=true`,
    );
  }
});

test("build-native requires token auth when engine packages are missing from npm", () => {
  const step = publishJob.steps.find(
    (entry) => entry.name === "Require token auth for packages not on npm yet",
  );
  const tokenCheck = publishJob.steps.find(
    (entry) => entry.name === "Verify NPM_TOKEN is configured for token bootstrap",
  );

  assert.ok(step, "publish job must guard trusted auth when packages are new");
  assert.equal(step.if, "github.event.inputs.publish_auth != 'token'");
  assert.match(step.run, /do not exist on npm yet/);
  assert.match(step.run, /publish_auth=token/);

  assert.ok(tokenCheck, "publish job must verify NPM_TOKEN for token bootstrap");
  assert.equal(tokenCheck.if, "github.event.inputs.publish_auth == 'token'");
  assert.match(tokenCheck.run, /NPM_TOKEN/);
});

test("publish-engine-packages script continues through all platforms", () => {
  const script = readFileSync("scripts/publish-engine-packages.sh", "utf8");

  assert.match(script, /FAILED=\(\)/);
  assert.match(script, /for platform in "\$\{PLATFORMS\[@\]\}"/);
  assert.doesNotMatch(script, /exit 1\s*\n\s*fi\s*\n\s*cd "\$GITHUB_WORKSPACE"/);
  assert.match(script, /already on npm, skipping/);
});
