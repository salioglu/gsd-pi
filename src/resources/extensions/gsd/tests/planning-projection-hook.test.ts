// Project/App: gsd-pi
// File Purpose: Verifies renderAllFromDb projects to .planning/ when active.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { renderAllFromDb } from "../markdown-renderer.ts";
import { openDatabase, closeDatabase, insertMilestone, insertSlice } from "../gsd-db.ts";
import { writeCompatMarker } from "../compat/compat-marker.ts";

const tmpDirs: string[] = [];
function makeTmp(): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-pph-${randomUUID()}`));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "T", status: "active" });
  insertSlice({
    milestoneId: "M001", id: "S01", title: "T", status: "pending",
    risk: "low", depends: [], demo: "", sequence: 1,
  });
  tmpDirs.push(base);
  return base;
}
afterEach(() => {
  closeDatabase();
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  tmpDirs.length = 0;
});

test("renderAllFromDb projects to .planning/ when marker.planning.active", async () => {
  const base = makeTmp();
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "",
    projections: {},
    planning: { active: true, layout: "flat-phases", projections: {}, passthrough: {} },
    piVersion: "1.4.0",
  });

  await renderAllFromDb(base);
  assert.ok(
    existsSync(join(base, ".planning", "ROADMAP.md")),
    ".planning/ROADMAP.md should be projected",
  );
});

test("renderAllFromDb does NOT project to .planning/ when marker.planning inactive", async () => {
  const base = makeTmp();
  // Default marker: planning inactive.
  await renderAllFromDb(base);
  assert.ok(
    !existsSync(join(base, ".planning")),
    ".planning/ should not be created when inactive",
  );
});
