You are running the GSD **docs-update** workflow — generate, update, and verify project documentation against the live codebase.

## Mode

{{mode}}

## Process

1. **Detect the doc structure.** Find existing Markdown docs (README, docs/, ADRs, API docs, CONTRIBUTING, etc.) and any doc tooling (docusaurus, vitepress, mkdocs, storybook). Detect project type (monorepo, cli-tool, saas, open-source-library, generic) from manifests and routes.

2. **Assemble a work manifest.** List every doc item to touch: canonical doc types the project is missing, and existing hand-written docs to review for accuracy. Track each item so nothing is lost between steps.

3. **Write missing canonical docs.** For the detected project type, create the docs that should exist (e.g. README, CONTRIBUTING, ARCHITECTURE, API reference, CHANGELOG). Ground every claim in the live code.

4. **Verify existing docs.** For each existing doc, check factual claims against the codebase: function signatures, file paths, configuration keys, CLI flags, environment variables. Flag inaccuracies and gaps.

5. **Fix loop (bounded).** Correct verified inaccuracies directly. Do not rewrite docs wholesale — fix the specific wrong claims.

6. **Summarize.** Report: docs created, docs updated, inaccuracies fixed, gaps that need a human decision.

## Success criteria

- Every doc claim that references code (paths, signatures, flags, env vars) is verified against the live codebase.
- New docs match the project's detected type and existing style.
- Fixes are surgical, not rewrites.
- No work item from the manifest is silently dropped.
