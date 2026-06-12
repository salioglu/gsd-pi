import test from "node:test";
import assert from "node:assert/strict";

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

test("shouldWarmBrowserDaemonForUat enables Claude Code browser UAT when gsd-browser is available", (t) => {
  const availability = resolveGsdBrowserCliAvailability();
  if (!availability.available) {
    t.skip("bundled gsd-browser CLI unavailable");
  }

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

test("prepareBrowserDaemonForUat returns null when warm-up is not required", () => {
  assert.equal(
    prepareBrowserDaemonForUat({
      uatType: "artifact-driven",
      sessionProvider: "claude-code",
      sessionAuthMode: "externalCli",
      projectRoot: "/tmp/example-project",
    }),
    null,
  );
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
