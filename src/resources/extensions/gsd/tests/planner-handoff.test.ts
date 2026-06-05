import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { GSD_COMMAND_DESCRIPTION, getGsdArgumentCompletions, TOP_LEVEL_SUBCOMMANDS } from "../commands/catalog.ts";
import { handleCoreCommand } from "../commands/handlers/core.ts";
import { DISPATCH_RULES } from "../auto-dispatch.ts";
import {
  buildGsdPlannerLaunchPlan,
  formatGsdPlannerLaunchTarget,
  formatPlannerLaunchUnavailable,
  LEGACY_GSD_PLANNER_COMMAND,
  launchGsdPlanner,
  hasPlannerHandoffBeenOffered,
  markPlannerHandoffOffered,
  PLANNER_HANDOFF_RULE_NAME,
} from "../planner-handoff.ts";

function createMockCommandCtx() {
  const notifications: Array<{ message: string; level?: string }> = [];
  return {
    notifications,
    ui: {
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
    },
  };
}

describe("planner handoff command catalog", () => {
  test("/gsd planner is registered in the command description and completions", () => {
    assert.match(GSD_COMMAND_DESCRIPTION, /\|planner(?:\||$)/);
    assert.equal(
      TOP_LEVEL_SUBCOMMANDS.some((command) => command.cmd === "planner"),
      true,
      "planner should appear in top-level commands",
    );

    const completions = getGsdArgumentCompletions("pla");

    assert.equal(
      completions.some((completion) => completion.value === "planner"),
      true,
      "planner should appear in top-level completions",
    );

    const nestedCompletions = getGsdArgumentCompletions("planner --");

    assert.ok(nestedCompletions.length > 0, "planner should expose nested completions");
    assert.ok(
      nestedCompletions.some((c) => c.value === "planner --dry-run"),
      "planner should expose --dry-run completion",
    );
  });
});

describe("planner handoff command handler", () => {
  test("/gsd planner dry-run prints the built-in Planner route", async () => {
    const ctx = createMockCommandCtx();

    const handled = await handleCoreCommand("planner M001 --dry-run --inspect", ctx as any);

    assert.equal(handled, true);
    assert.equal(ctx.notifications.length, 1);
    assert.equal(ctx.notifications[0]?.level, "info");
    assert.equal(ctx.notifications[0]?.message, "GSD Planner route: /?view=planner&milestone=M001");
  });

  test("/gsd planner ignores pasted launcher context flags", async () => {
    const ctx = createMockCommandCtx();

    const handled = await handleCoreCommand(
      `planner ${LEGACY_GSD_PLANNER_COMMAND} --project /tmp/ignored --milestone M002 --dry-run --inspect --project /tmp/also-ignored --milestone`,
      ctx as any,
    );

    assert.equal(handled, true);
    assert.equal(ctx.notifications.length, 1);
    const message = ctx.notifications[0]?.message ?? "";
    assert.equal((message.match(/--project/g) ?? []).length, 0);
    assert.equal((message.match(/--milestone/g) ?? []).length, 0);
    assert.match(message, /milestone=M002/);
    assert.doesNotMatch(message, /\/tmp\/ignored/);
    assert.doesNotMatch(message, /\/tmp\/also-ignored/);
  });
});

describe("planner handoff launcher", () => {
  test("builds built-in Planner route with milestone context", () => {
    const plan = buildGsdPlannerLaunchPlan(
      {
        basePath: "/tmp/project with spaces",
        milestoneId: "M001",
      },
      {
        command: "/usr/local/bin/node",
        baseArgs: ["/tmp/gsd.js"],
      },
    );

    assert.deepEqual(plan, {
      command: "/usr/local/bin/node",
      args: [
        "/tmp/gsd.js",
        "--web",
        "/tmp/project with spaces",
        "--web-initial-path",
        "/?view=planner&milestone=M001",
      ],
      cwd: "/tmp/project with spaces",
      initialPath: "/?view=planner&milestone=M001",
      milestoneId: "M001",
    });
    assert.equal(
      formatGsdPlannerLaunchTarget(plan),
      "GSD Planner route: /?view=planner&milestone=M001",
    );
  });

  test("launches Planner through built-in web mode", async () => {
    let unrefCalled = false;
    let spawnInvocation:
      | { command: string; args: readonly string[]; options: Record<string, unknown> }
      | undefined;

    const result = await launchGsdPlanner(
      {
        basePath: "/tmp/project",
        milestoneId: "M002",
      },
      {
        launcher: {
          command: "/usr/local/bin/node",
          baseArgs: ["/tmp/gsd.js"],
        },
        spawn: (command, args, options) => {
          spawnInvocation = { command, args, options: options as Record<string, unknown> };
          const child = {
            once(event: string, cb: () => void) {
              if (event === "spawn") setImmediate(cb);
              return child;
            },
            unref() {
              unrefCalled = true;
            },
          };
          return child as any;
        },
      },
    );

    assert.equal(result.status, "launched");
    assert.deepEqual(spawnInvocation, {
      command: "/usr/local/bin/node",
      args: [
        "/tmp/gsd.js",
        "--web",
        "/tmp/project",
        "--web-initial-path",
        "/?view=planner&milestone=M002",
      ],
      options: {
        cwd: "/tmp/project",
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    });
    assert.equal(unrefCalled, true);
  });

  test("launch failure guidance points to built-in web mode", () => {
    const plan = buildGsdPlannerLaunchPlan({
      basePath: "/tmp/project",
      milestoneId: "M002",
    });

    const message = formatPlannerLaunchUnavailable(plan, new Error("boot-ready: timed out"));

    assert.match(message, /Could not launch GSD Planner: boot-ready: timed out/);
    assert.match(message, /Open the built-in web app manually: gsd --web \/tmp\/project/);
    assert.match(message, /--web-initial-path "\/\?view=planner&milestone=M002"/);
    assert.match(message, /Continue without planner edits: \/gsd auto/);
    assert.doesNotMatch(message, /gsd-planner/);
  });

  test("records one-shot handoff markers per milestone", () => {
    const basePath = mkdtempSync(join(tmpdir(), "gsd-planner-marker-"));
    try {
      assert.equal(hasPlannerHandoffBeenOffered(basePath, "M001"), false);
      markPlannerHandoffOffered(basePath, "M001");
      assert.equal(hasPlannerHandoffBeenOffered(basePath, "M001"), true);
      assert.equal(hasPlannerHandoffBeenOffered(basePath, "M002"), false);
    } finally {
      rmSync(basePath, { recursive: true, force: true });
    }
  });
});

describe("planner handoff dispatch rule", () => {
  test("auto-dispatch planner handoff rule is not registered", () => {
    assert.equal(
      DISPATCH_RULES.some((rule) => rule.name === PLANNER_HANDOFF_RULE_NAME),
      false,
    );
  });
});
