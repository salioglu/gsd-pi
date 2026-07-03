// gsd-pi — Narrow auto-worktree creation seam.
//
// Keeps callers that only create worktrees off the legacy auto-worktree
// compatibility barrel while the implementation is extracted incrementally.

export { createAutoWorktree } from "./auto-worktree.js";
