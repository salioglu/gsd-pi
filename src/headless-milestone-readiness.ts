// Project/App Name: gsd-pi + DB-authoritative milestone readiness for `--auto` chaining
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
//
// The `new-milestone --auto` chain decision historically hinged on regex-matching
// a specific notify string ("Milestone <id> ready."), which is only emitted on one
// of several planning success paths. Any run that finishes planning through a
// different branch — or takes an early-return handoff path — completes successfully
// yet never chains into execution (issue #1295).
//
// This module makes the decision authoritative by querying the workflow DB directly:
// a milestone is executable when there is an active (non-terminal) milestone that has
// at least one slice. The notify-text signal remains a fast path; this is the
// deciding fallback.

import {
  closeWorkflowDatabase,
  openExistingWorkflowDatabase,
} from './resources/extensions/gsd/db-workspace.js'
import {
  getActiveMilestoneFromDb,
  getMilestoneSlices,
} from './resources/extensions/gsd/gsd-db.js'

/**
 * Return true when the workflow DB for `basePath` holds an executable milestone —
 * an active (non-terminal) milestone with at least one slice — meaning auto-mode
 * has real work to pick up.
 *
 * Never throws: returns false when the DB is missing or cannot be opened/queried,
 * so the caller can fall back to the notify-text signal.
 */
export function isMilestoneExecutableInDb(basePath: string): boolean {
  const opened = openExistingWorkflowDatabase(basePath)
  if (!opened.ok) return false
  try {
    const active = getActiveMilestoneFromDb()
    return active != null && getMilestoneSlices(active.id).length > 0
  } catch {
    return false
  } finally {
    closeWorkflowDatabase()
  }
}
