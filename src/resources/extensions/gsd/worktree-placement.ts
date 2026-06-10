/**
 * Worktree Placement module — owns WHERE GSD worktrees physically live.
 *
 * Canonical placement: `<projectRoot>/.gsd-worktrees/<name>` — a real
 * directory that never crosses the `.gsd` symlink managed by repo-identity.
 * Under the external-state layout (`.gsd → ~/.gsd/projects/<hash>/`), the
 * legacy `.gsd/worktrees/` location materialised worktrees inside the user's
 * home directory behind an opaque hash path; the canonical sibling keeps the
 * working copy at the project root regardless of where `.gsd` state lives.
 *
 * Legacy placement (`<projectRoot>/.gsd/worktrees/<name>`, possibly resolving
 * through the symlink to `~/.gsd/projects/<hash>/worktrees/<name>`) stays
 * recognized so in-flight milestones keep working across upgrades:
 *   - creation always uses the canonical location;
 *   - resolution prefers an existing legacy worktree for the same name;
 *   - containment checks accept membership in either location.
 *
 * Path → project identification lives in worktree-root.ts; this module owns
 * only the forward direction (project + name → physical path).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/** Directory name of the canonical worktrees container at the project root. */
export const CANONICAL_WORKTREES_DIRNAME = ".gsd-worktrees";

/** Canonical container for newly created worktrees. Never crosses the `.gsd` symlink. */
export function canonicalWorktreesDir(projectRoot: string): string {
  return join(projectRoot, CANONICAL_WORKTREES_DIRNAME);
}

/** Legacy container (`.gsd/worktrees/`) — may resolve through the external-state symlink. */
export function legacyWorktreesDir(projectRoot: string): string {
  return join(projectRoot, ".gsd", "worktrees");
}

/**
 * All containers a GSD worktree may live in, canonical first.
 * Use for listing, scanning, and containment checks.
 */
export function worktreesDirs(projectRoot: string): string[] {
  return [canonicalWorktreesDir(projectRoot), legacyWorktreesDir(projectRoot)];
}

/**
 * Physical path for the worktree `name` under `projectRoot`.
 *
 * An existing worktree directory keeps its location (canonical or legacy);
 * otherwise the canonical location is returned for creation. The legacy
 * check is a plain existsSync so a stale legacy directory still resolves —
 * callers that need a *registered* worktree validate the `.git` marker
 * themselves (resolveCanonicalMilestoneRoot, Worktree Safety).
 */
export function worktreePathFor(projectRoot: string, name: string): string {
  const canonical = join(canonicalWorktreesDir(projectRoot), name);
  if (existsSync(canonical)) return canonical;
  const legacy = join(legacyWorktreesDir(projectRoot), name);
  if (existsSync(legacy)) return legacy;
  return canonical;
}
