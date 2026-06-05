import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DISPATCH_RULES } from "../auto-dispatch.ts";
import {
  closeDatabase,
  getArtifact,
  getAssessment,
  getLatestAssessmentByScope,
  insertAssessment,
  insertMilestone,
  insertSlice,
  openDatabase,
} from "../gsd-db.ts";

test("skipped validation dispatch persists the validation file and DB assessment together", async () => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-skip-validation-"));
  const milestoneDir = join(basePath, ".gsd", "milestones", "M001");
  const sliceDir = join(milestoneDir, "slices", "S01");
  const rule = DISPATCH_RULES.find((r) => r.name === "validating-milestone → validate-milestone");
  assert.ok(rule, "validate-milestone rule is registered");

  try {
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# S01 Summary\n", "utf-8");
    openDatabase(join(basePath, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Validation", status: "active", depends_on: [] });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      title: "Done slice",
      status: "complete",
      risk: "low",
      depends: [],
      demo: "",
      sequence: 1,
    });

    const action = await rule.match({
      state: { phase: "validating-milestone" },
      mid: "M001",
      midTitle: "Validation",
      basePath,
      prefs: { phases: { skip_milestone_validation: true } },
    } as any);

    assert.deepEqual(action, { action: "skip" });
    assert.equal(existsSync(join(milestoneDir, "M001-VALIDATION.md")), true);
    assert.equal(existsSync(join(sliceDir, "S01-ASSESSMENT.md")), true);
    const artifactPath = "milestones/M001/slices/S01/S01-ASSESSMENT.md";
    const assessmentPath = `.gsd/${artifactPath}`;
    assert.equal(getArtifact(artifactPath)?.artifact_type, "ASSESSMENT");
    assert.equal(getAssessment(assessmentPath)?.scope, "run-uat");
    assert.equal(getAssessment(assessmentPath)?.status, "pass");
    assert.equal(
      getLatestAssessmentByScope("M001", "milestone-validation")?.status,
      "pass",
    );
  } finally {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("backfill preserves a pre-existing DB FAIL verdict when no assessment file exists on disk", async () => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-backfill-preserve-fail-"));
  const milestoneDir = join(basePath, ".gsd", "milestones", "M001");
  const sliceDir = join(milestoneDir, "slices", "S01");
  const rule = DISPATCH_RULES.find((r) => r.name === "validating-milestone → validate-milestone");
  assert.ok(rule, "validate-milestone rule is registered");

  try {
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# S01 Summary\n", "utf-8");
    openDatabase(join(basePath, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Validation", status: "active", depends_on: [] });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      title: "Done slice",
      status: "complete",
      risk: "low",
      depends: [],
      demo: "",
      sequence: 1,
    });

    // Pre-populate the DB with a FAIL assessment (no file on disk).
    const assessmentPath = ".gsd/milestones/M001/slices/S01/S01-ASSESSMENT.md";
    const failContent = [
      "---",
      "sliceId: S01",
      "verdict: FAIL",
      "date: 2024-01-01T00:00:00.000Z",
      "---",
      "",
      "# Assessment — S01",
      "",
      "UAT failed: acceptance criterion not met.",
    ].join("\n");
    insertAssessment({
      path: assessmentPath,
      milestoneId: "M001",
      sliceId: "S01",
      taskId: null,
      status: "fail",
      scope: "run-uat",
      fullContent: failContent,
    });

    await rule.match({
      state: { phase: "validating-milestone" },
      mid: "M001",
      midTitle: "Validation",
      basePath,
      prefs: { phases: { skip_milestone_validation: true } },
    } as any);

    // The DB FAIL verdict must survive — must not be overwritten with PASS.
    const row = getAssessment(assessmentPath);
    assert.equal(row?.status, "fail", "existing FAIL status must not be overwritten with PASS");
    assert.ok(
      String(row?.full_content ?? "").includes("UAT failed"),
      "existing FAIL full_content must not be replaced with synthesized PASS template",
    );

    // The restored file on disk should contain the original FAIL content, not a PASS template.
    const artifactPath = "milestones/M001/slices/S01/S01-ASSESSMENT.md";
    const diskContent = readFileSync(join(basePath, ".gsd", "milestones", "M001", "slices", "S01", "S01-ASSESSMENT.md"), "utf-8");
    assert.ok(diskContent.includes("FAIL"), "file restored from DB must contain FAIL verdict");
    assert.equal(
      getArtifact(artifactPath)?.artifact_type,
      "ASSESSMENT",
      "artifact row must exist",
    );
  } finally {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("backfill updates existing assessment row to match artifact row when file is present", async () => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-backfill-update-assessment-"));
  const milestoneDir = join(basePath, ".gsd", "milestones", "M001");
  const sliceDir = join(milestoneDir, "slices", "S01");
  const rule = DISPATCH_RULES.find((r) => r.name === "validating-milestone → validate-milestone");
  assert.ok(rule, "validate-milestone rule is registered");

  try {
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# S01 Summary\n", "utf-8");
    openDatabase(join(basePath, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Validation", status: "active", depends_on: [] });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      title: "Done slice",
      status: "complete",
      risk: "low",
      depends: [],
      demo: "",
      sequence: 1,
    });

    // Write a PASS assessment file on disk.
    const updatedContent = [
      "---",
      "sliceId: S01",
      "verdict: PASS",
      "date: 2024-06-01T00:00:00.000Z",
      "---",
      "",
      "# Assessment — S01",
      "",
      "Updated assessment content.",
    ].join("\n");
    writeFileSync(join(sliceDir, "S01-ASSESSMENT.md"), updatedContent, "utf-8");

    // Pre-populate the DB with stale content (different full_content).
    const assessmentPath = ".gsd/milestones/M001/slices/S01/S01-ASSESSMENT.md";
    insertAssessment({
      path: assessmentPath,
      milestoneId: "M001",
      sliceId: "S01",
      taskId: null,
      status: "pass",
      scope: "run-uat",
      fullContent: "stale content that should be overwritten",
    });

    await rule.match({
      state: { phase: "validating-milestone" },
      mid: "M001",
      midTitle: "Validation",
      basePath,
      prefs: { phases: { skip_milestone_validation: true } },
    } as any);

    // Both artifact and assessment rows should reflect the on-disk content.
    const artifactPath = "milestones/M001/slices/S01/S01-ASSESSMENT.md";
    assert.ok(
      String(getArtifact(artifactPath)?.full_content ?? "").includes("Updated assessment content"),
      "artifact row full_content must be updated from disk",
    );
    assert.ok(
      String(getAssessment(assessmentPath)?.full_content ?? "").includes("Updated assessment content"),
      "assessment row full_content must be updated to match artifact row",
    );
  } finally {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  }
});
