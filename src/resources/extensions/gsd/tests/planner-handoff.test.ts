import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { GSD_COMMAND_DESCRIPTION, getGsdArgumentCompletions } from "../commands/catalog.ts";
import { handleCoreCommand } from "../commands/handlers/core.ts";
import { DISPATCH_RULES, type DispatchContext } from "../auto-dispatch.ts";
import {
  buildGsdPlannerSpawnPlan,
  formatGsdPlannerCommand,
  hasPlannerHandoffBeenOffered,
  markPlannerHandoffOffered,
  PLANNER_HANDOFF_RULE_NAME,
} from "../planner-handoff.ts";
import { closeDatabase, isDbAvailable } from "../gsd-db.ts";
import type { GSDState } from "../types.ts";

function writeRoadmap(basePath: string, milestoneId: string): void {
  const milestoneDir = join(basePath, ".gsd", "milestones", milestoneId);
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(
    join(milestoneDir, `${milestoneId}-ROADMAP.md`),
    [
      `# ${milestoneId}: Planner Handoff`,
      "",
      "**Vision:** Review the plan before implementation.",
      "",
      "## Slices",
      "",
      "- [ ] **S01: First Slice** `risk:low` `depends:[]`",
      "",
    ].join("\n"),
    "utf-8",
  );
}

function buildState(overrides: Partial<GSDState> = {}): GSDState {
  return {
    activeMilestone: { id: "M001", title: "Planner Handoff" },
    activeSlice: { id: "S01", title: "First Slice" },
    activeTask: null,
    phase: "planning",
    recentDecisions: [],
    blockers: [],
    nextAction: "Plan slice S01 (First Slice).",
    registry: [],
    ...overrides,
  };
}

function buildCtx(basePath: string, state: GSDState = buildState()): DispatchContext {
  return {
    basePath,
    mid: "M001",
    midTitle: "Planner Handoff",
    state,
    prefs: undefined,
  };
}

function findPlannerRule() {
  const rule = DISPATCH_RULES.find(candidate => candidate.name === PLANNER_HANDOFF_RULE_NAME);
  if (!rule) throw new Error(`missing dispatch rule: ${PLANNER_HANDOFF_RULE_NAME}`);
  return rule;
}

describe("planner handoff command catalog", () => {
  test("/gsd planner appears in description and completions", () => {
    assert.match(GSD_COMMAND_DESCRIPTION, /planner/);
    const completions = getGsdArgumentCompletions("pla");
    const entry = completions.find(completion => completion.value === "planner");

    assert.ok(entry, "planner should appear in top-level completions");
    assert.match(entry.description, /customize/i);
  });

  test("planner nested completions expose dry-run", () => {
    const completions = getGsdArgumentCompletions("planner --");

    assert.ok(
      completions.some(completion => completion.value === "planner --dry-run"),
      "planner should suggest --dry-run",
    );
  });
});

describe("planner handoff command handler", () => {
  test("/gsd planner dry-run prints the launch command", async () => {
    const notifications: Array<{ message: string; level?: string }> = [];
    const ctx = {
      ui: {
        notify(message: string, level?: string) {
          notifications.push({ message, level });
        },
      },
    };

    const handled = await handleCoreCommand("planner M001 --dry-run --inspect", ctx as any);

    assert.equal(handled, true);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.level, "info");
    assert.match(notifications[0]?.message ?? "", /^gsd-planner --project /);
    assert.match(notifications[0]?.message ?? "", / --milestone M001 /);
    assert.match(notifications[0]?.message ?? "", / --inspect$/);
  });
});

describe("planner handoff launcher", () => {
  test("builds gsd-planner command with project and milestone context", () => {
    const plan = buildGsdPlannerSpawnPlan({
      basePath: "/tmp/project with spaces",
      milestoneId: "M001",
      extraArgs: ["--inspect"],
    });

    assert.deepEqual(plan, {
      command: "gsd-planner",
      args: ["--project", "/tmp/project with spaces", "--milestone", "M001", "--inspect"],
      cwd: "/tmp/project with spaces",
    });
    assert.equal(
      formatGsdPlannerCommand(plan),
      'gsd-planner --project "/tmp/project with spaces" --milestone M001 --inspect',
    );
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
  test("pauses once after roadmap planning before plan-slice dispatch", async () => {
    if (isDbAvailable()) closeDatabase();
    const basePath = mkdtempSync(join(tmpdir(), "gsd-planner-dispatch-"));
    try {
      writeRoadmap(basePath, "M001");
      const rule = findPlannerRule();

      const first = await rule.match(buildCtx(basePath));
      assert.ok(first, "planner handoff should match the first time");
      assert.equal(first!.action, "stop");
      if (first!.action === "stop") {
        assert.equal(first!.level, "warning");
        assert.match(first!.reason, /\/gsd planner/);
        assert.match(first!.reason, /\/gsd auto/);
      }

      const second = await rule.match(buildCtx(basePath));
      assert.equal(second, null, "handoff marker should make the pause one-shot");
    } finally {
      rmSync(basePath, { recursive: true, force: true });
    }
  });

  test("rule is ordered before plan-slice and execute-task dispatch", () => {
    const plannerIdx = DISPATCH_RULES.findIndex(rule => rule.name === PLANNER_HANDOFF_RULE_NAME);
    const planSliceIdx = DISPATCH_RULES.findIndex(rule => rule.name.startsWith("planning → plan-slice"));
    const executeTaskIdx = DISPATCH_RULES.findIndex(rule => rule.name.startsWith("executing → execute-task"));

    assert.ok(plannerIdx >= 0, "planner handoff rule must be registered");
    assert.ok(planSliceIdx >= 0, "plan-slice rule must be registered");
    assert.ok(executeTaskIdx >= 0, "execute-task rule must be registered");
    assert.ok(plannerIdx < planSliceIdx, "planner handoff must preempt plan-slice");
    assert.ok(plannerIdx < executeTaskIdx, "planner handoff must preempt execute-task");
  });
});
