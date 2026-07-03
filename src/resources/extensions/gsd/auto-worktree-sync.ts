// gsd-pi — Narrow auto-worktree state sync seam.
//
// Keeps worktree projection/state sync callers off the legacy auto-worktree
// compatibility barrel while extraction continues.

export {
  syncGsdStateToWorktree,
  syncGsdStateToWorktreeByScope,
  syncProjectRootToWorktree,
  syncStateToProjectRoot,
  syncWorktreeStateBack,
  _shouldReconcileWorktreeDb,
} from "./auto-worktree.js";
