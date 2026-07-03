// gsd-pi — Narrow auto-worktree conflict auto-resolve seam.
//
// Keeps conflict auto-resolve policy callers off the legacy auto-worktree
// compatibility barrel while extraction continues.

export {
  isSafeToAutoResolve,
  SAFE_AUTO_RESOLVE_PATTERNS,
} from "./auto-worktree.js";
