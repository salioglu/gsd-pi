import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  prepareBrowserDaemonForUat,
  shouldWarmBrowserDaemonForUat,
} from "../browser-daemon-auto-prep.ts";
import { resolveGsdBrowserCliAvailability } from "../../shared/gsd-browser-cli.ts";

test("shouldWarmBrowserDaemonForUat skips artifact-driven UAT", () => {
  assert.equal(
    shouldWarmBrowserDaemonForUat({
      uatType: "artifact-driven",
      sessionProvider: "claude-code",
      projectRoot: "/tmp/project",
    }),
    false,
  );
});

test("shouldWarmBrowserDaemonForUat enables Claude Code browser UAT when gsd-browser is available", () => {
  const availability = resolveGsdBrowserCliAvailability();
  test.skip(!availability.available, "bundled gsd-browser CLI unavailable");

  assert.equal(
    shouldWarmBrowserDaemonForUat({
      uatType: "browser-executable",
      sessionProvider: "claude-code",
      sessionAuthMode: "externalCli",
      projectRoot: "/tmp/project",
    }),
    true,
  );
});

test("shouldWarmBrowserDaemonForUat skips when browser MCP is disabled", () => {
  assert.equal(
    shouldWarmBrowserDaemonForUat({
      uatType: "browser-executable",
      sessionProvider: "claude-code",
      projectRoot: "/tmp/project",
      env: { GSD_BROWSER_MCP_ENABLED: "0" },
    }),
    false,
  );
});

test("shouldWarmBrowserDaemonForUat skips when warm-up is disabled", () => {
  assert.equal(
    shouldWarmBrowserDaemonForUat({
      uatType: "browser-executable",
      sessionProvider: "claude-code",
      projectRoot: "/tmp/project",
      env: { GSD_BROWSER_WARMUP: "0" },
    }),
    false,
  );
});

test("prepareBrowserDaemonForUat starts daemon for browser-facing web apps", (t) => {
  const availability = resolveGsdBrowserCliAvailability();
  test.skip(!availability.available, "bundled gsd-browser CLI unavailable");

  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-browser-daemon-prep-"));
  writeFileSync(
    join(projectRoot, "package.json"),
    JSON.stringify({
      dependencies: { react: "18.0.0" },
      scripts: { dev: "vite" },
    }),
  );

  t.after(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const error = prepareBrowserDaemonForUat({
    uatType: "browser-executable",
    sessionProvider: "claude-code",
    sessionAuthMode: "externalCli",
    projectRoot,
  });
  assert.equal(error, null);
});

test("prepareBrowserDaemonForUat returns actionable error when daemon start fails", () => {
  const error = prepareBrowserDaemonForUat({
    uatType: "browser-executable",
    sessionProvider: "claude-code",
    sessionAuthMode: "externalCli",
    projectRoot: "/tmp/example-project",
    env: { GSD_BROWSER_MCP_COMMAND: "/definitely/missing/gsd-browser" },
  });

  assert.match(error ?? "", /gsd-browser daemon failed to start/i);
});
