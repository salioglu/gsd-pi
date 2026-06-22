// Project/App: gsd-pi
// File Purpose: One-time migration from legacy nested .gsd/milestones/ to
// flat-phase .gsd/phases/. Runs on startup when the legacy structure is detected.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { renderAllFromDb } from "./markdown-renderer.js";
import { getAllMilestones } from "./gsd-db.js";
import { logWarning } from "./workflow-logger.js";

/**
 * Detect whether the project uses the legacy nested layout.
 * True when .gsd/milestones/ exists.
 */
export function needsFlatPhaseMigration(basePath: string): boolean {
  return existsSync(join(basePath, ".gsd", "milestones"));
}

/**
 * Migrate from legacy nested .gsd/milestones/ to flat-phase .gsd/phases/.
 *
 * Steps:
 * 1. Backup .gsd/milestones/ to .gsd-backups/migrate-<ts>/
 * 2. Render flat-phase from the DB (which already has the data)
 * 3. Verify counts match
 * 4. Remove .gsd/milestones/
 *
 * Idempotent: if .gsd/milestones/ doesn't exist, returns immediately.
 */
export async function migrateToFlatPhase(basePath: string): Promise<void> {
  if (!needsFlatPhaseMigration(basePath)) return;

  const ts = Date.now();
  const backupDir = join(basePath, ".gsd-backups", `migrate-${ts}`);
  const milestonesPath = join(basePath, ".gsd", "milestones");

  // 1. Backup
  try {
    mkdirSync(join(basePath, ".gsd-backups"), { recursive: true });
    cpSync(milestonesPath, backupDir, { recursive: true });
  } catch (err) {
    logWarning("migration", `flat-phase migration backup failed: ${(err as Error).message}`);
    throw err;
  }

  // 2. Render flat-phase from DB
  const milestonesBefore = getAllMilestones().length;
  try {
    await renderAllFromDb(basePath);
  } catch (err) {
    logWarning("migration", `flat-phase render failed: ${(err as Error).message}`);
    // Restore from backup on failure — remove partial phases/ dir
    rmSync(join(basePath, ".gsd", "phases"), { recursive: true, force: true });
    throw err;
  }

  // 3. Verify
  const milestonesAfter = getAllMilestones().length;
  if (milestonesAfter !== milestonesBefore) {
    logWarning("migration", `count mismatch after migration: ${milestonesBefore} → ${milestonesAfter}`);
    rmSync(join(basePath, ".gsd", "phases"), { recursive: true, force: true });
    throw new Error("flat-phase migration verification failed: milestone count mismatch");
  }

  // 4. Remove old tree
  try {
    rmSync(milestonesPath, { recursive: true, force: true });
  } catch (err) {
    logWarning("migration", `failed to remove legacy milestones/: ${(err as Error).message}`);
    // Non-fatal: the backup exists and phases/ is written; user can clean up manually.
  }
}
