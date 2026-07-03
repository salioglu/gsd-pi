// gsd-pi — Narrow auto-worktree merge seam.
//
// Tests and lifecycle callers that exercise milestone merge behavior should
// depend on this focused seam instead of the full auto-worktree barrel.

export {
  mergeMilestoneToMain,
  _setRestoreEntryFnForTests,
} from "./auto-worktree.js";
