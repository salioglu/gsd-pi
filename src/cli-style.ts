/**
 * Terminal presentation module for CLI-side notices — the single vocabulary
 * for how the gsd CLI styles warnings, hints, and names on stderr.
 * Pairs with the extension-side glyph set in resources/extensions/shared/ui.ts;
 * this module covers the pre-session CLI surfaces (banners, update checks,
 * worktree commands) that render with chalk directly.
 */

import chalk from 'chalk'

/** Dim "[gsd] " line tag that prefixes CLI banner lines. */
export function gsdTag(): string {
  return chalk.dim('[gsd] ')
}

/** A yellow warning fragment. */
export function warn(text: string): string {
  return chalk.yellow(text)
}

/** A dim "what to do next" hint fragment. */
export function hint(text: string): string {
  return chalk.dim(text)
}

/** A cyan user-supplied name (worktree, branch, file). */
export function name(text: string): string {
  return chalk.cyan(text)
}

/** One banner line: tagged warning followed by a tagged hint line. */
export function bannerLines(warning: string, hintText: string): string {
  return gsdTag() + warning + '\n' + gsdTag() + hint(hintText) + '\n\n'
}
