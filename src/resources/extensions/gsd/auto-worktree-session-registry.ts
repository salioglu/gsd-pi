// gsd-pi — Narrow auto-worktree session registry seam.
//
// Provides registry state/reset helpers without exposing the whole legacy
// auto-worktree compatibility barrel to tests.

export {
  getActiveAutoWorktreeContext,
  getAutoWorktreeOriginalBase,
  _resetAutoWorktreeOriginalBaseForTests,
} from "./auto-worktree.js";
