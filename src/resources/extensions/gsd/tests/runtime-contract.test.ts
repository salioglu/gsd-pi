import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionContext } from "@gsd/pi-coding-agent";

import {
  _flushDeferredContextMaintenanceForTest,
  buildBeforeAgentStartResult,
} from "../bootstrap/system-context.ts";
import { closeDatabase, isDbAvailable } from "../gsd-db.ts";
import { _clearGsdRootCache } from "../paths.ts";
import { clearGSDPreferencesCache } from "../preferences.ts";
import { resolveRuntimeContract } from "../runtime-contract.ts";
import { invalidateStateCache } from "../state.ts";

function assertContainsPath(text: string, path: string): void {
  const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(text, new RegExp(escapedPath));
}

async function withRuntimeProject(
  run: (base: string, ctx: ExtensionContext) => Promise<void>,
): Promise<void> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-runtime-contract-")));
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;

  mkdirSync(join(base, ".gsd"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: base, stdio: "ignore" });
  process.chdir(base);
  process.env.GSD_HOME = join(base, ".gsd-home");
  _clearGsdRootCache();
  clearGSDPreferencesCache();

  const ctx = {
    projectRoot: base,
    ui: { notify: () => undefined },
  } as unknown as ExtensionContext;

  try {
    await run(base, ctx);
  } finally {
    await _flushDeferredContextMaintenanceForTest(base);
    if (isDbAvailable()) closeDatabase();
    invalidateStateCache();
    clearGSDPreferencesCache();
    _clearGsdRootCache();
    process.chdir(originalCwd);
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(base, { recursive: true, force: true });
  }
}

test("injects the default project-local runtime contract into agent context", async () => {
  await withRuntimeProject(async (base, ctx) => {
    const contractDir = join(base, "script", "local-runtime");
    mkdirSync(contractDir, { recursive: true });
    writeFileSync(join(contractDir, "AGENT.md"), "# Runtime rules\n", "utf-8");
    writeFileSync(join(contractDir, "README.md"), "# Local runtime\n\n## How to use\n", "utf-8");
    writeFileSync(join(contractDir, "runtime.mjs"), "export {};\n", "utf-8");

    const result = await buildBeforeAgentStartResult(
      { prompt: "Verify the application", systemPrompt: "base system prompt" },
      ctx,
    );
    const systemPrompt = result?.systemPrompt ?? "";

    assert.match(systemPrompt, /## Project-local runtime contract/);
    assertContainsPath(systemPrompt, join(contractDir, "AGENT.md"));
    assertContainsPath(systemPrompt, join(contractDir, "README.md"));
    assertContainsPath(systemPrompt, join(contractDir, "runtime.mjs"));
    assert.match(systemPrompt, /Before starting, restarting, seeding, or tearing down/);
    assert.match(systemPrompt, /Do not start business projects directly/);
  });
});

test("uses the configured runtime contract path and entry point", async () => {
  await withRuntimeProject(async (base, ctx) => {
    writeFileSync(
      join(base, ".gsd", "PREFERENCES.md"),
      [
        "---",
        "runtime:",
        "  contract:",
        "    path: ops/dev",
        "    entry: run.mjs",
        "---",
        "",
      ].join("\n"),
      "utf-8",
    );
    const contractDir = join(base, "ops", "dev");
    mkdirSync(contractDir, { recursive: true });
    writeFileSync(join(contractDir, "README.md"), "# Team runtime\n", "utf-8");
    writeFileSync(join(contractDir, "run.mjs"), "export {};\n", "utf-8");
    clearGSDPreferencesCache();

    const result = await buildBeforeAgentStartResult(
      { prompt: "Run the integration stack", systemPrompt: "base system prompt" },
      ctx,
    );
    const systemPrompt = result?.systemPrompt ?? "";

    assertContainsPath(systemPrompt, join(contractDir, "README.md"));
    assertContainsPath(systemPrompt, join(contractDir, "run.mjs"));
    assert.doesNotMatch(systemPrompt, /script[\\/]local-runtime/);
  });
});

test("injects one shared runtime contract for a parent workspace", async () => {
  await withRuntimeProject(async (base, ctx) => {
    writeFileSync(
      join(base, ".gsd", "PREFERENCES.md"),
      [
        "---",
        "workspace:",
        "  mode: parent",
        "  repositories:",
        "    frontend:",
        "      path: frontend",
        "---",
        "",
      ].join("\n"),
      "utf-8",
    );
    mkdirSync(join(base, "frontend"), { recursive: true });
    const contractDir = join(base, "script", "local-runtime");
    mkdirSync(contractDir, { recursive: true });
    writeFileSync(join(contractDir, "README.md"), "# Shared stack\n", "utf-8");
    writeFileSync(join(contractDir, "runtime.mjs"), "export {};\n", "utf-8");
    clearGSDPreferencesCache();

    const result = await buildBeforeAgentStartResult(
      { prompt: "Start the workspace", systemPrompt: "base system prompt" },
      ctx,
    );
    const systemPrompt = result?.systemPrompt ?? "";

    assertContainsPath(systemPrompt, join(contractDir, "README.md"));
    assertContainsPath(systemPrompt, join(contractDir, "runtime.mjs"));
  });
});

test("leaves agent context unchanged when no runtime contract exists", async () => {
  await withRuntimeProject(async (_base, ctx) => {
    const result = await buildBeforeAgentStartResult(
      { prompt: "Plan the next task", systemPrompt: "base system prompt" },
      ctx,
    );

    assert.doesNotMatch(result?.systemPrompt ?? "", /## Project-local runtime contract/);
  });
});

test("runtime contract discovery fails closed when the project root disappears", () => {
  const missingRoot = mkdtempSync(join(tmpdir(), "gsd-runtime-contract-missing-"));
  rmSync(missingRoot, { recursive: true, force: true });

  assert.equal(resolveRuntimeContract(missingRoot), null);
});
