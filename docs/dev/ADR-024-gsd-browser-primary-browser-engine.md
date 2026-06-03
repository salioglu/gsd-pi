# ADR-024: Make gsd-browser the Primary Browser Automation Engine

**Status:** Accepted
**Date:** 2026-06-03
**Related:** `CONTEXT.md`, `docs/dev/ADR-008-gsd-tools-over-mcp-for-provider-parity.md`, `docs/dev/ADR-020-cloud-mcp-gateway-local-runtime.md`

## Context

GSD has two browser automation paths today. Pi Providers can receive direct `browser_*` tools from the bundled `browser-tools` extension, while Claude Code and other External MCP Clients can receive `mcp__gsd-browser__browser_*` tools from `gsd-browser mcp`.

That split creates a confusing failure mode: GSD prompts tell agents to use `gsd-browser`, but non-Claude Pi Providers may silently execute through the legacy Playwright-backed browser tools instead. Debug and UAT failures then appear to come from Playwright even when the intended product contract is `gsd-browser`.

## Decision

`gsd-browser` is the primary Browser Automation Engine for GSD. The existing `browser-tools` extension remains the Pi-facing Browser Automation Contract adapter and continues to register canonical `browser_*` tools for Pi Providers.

Inside Pi, Providers should call canonical `browser_*` tools such as `browser_navigate`, `browser_snapshot_refs`, and `browser_assert`. Pi hides the transport detail and routes those tools through an internal MCP bridge to `gsd-browser mcp`. MCP-shaped names such as `mcp__gsd-browser__browser_navigate` remain an External MCP Client concern and a Claude Code host concern.

Pi owns a managed built-in `gsd-browser` engine configuration resolved from the bundled `@opengsd/gsd-browser` dependency. Project `.mcp.json` generation remains for External MCP Clients through `/gsd mcp init`; it is not required for Pi Providers to use browser automation.

`/gsd mcp init` writes both the GSD workflow MCP server and the `gsd-browser` MCP server for External MCP Clients by default. `GSD_BROWSER_MCP_ENABLED=0` disables only the browser entry in generated external MCP config; it does not control Pi's managed Browser Automation Engine.

The managed engine should have a browser-specific connection manager. It may share low-level MCP connection utilities with the generic `mcp-client` extension, but it must not expose generic `mcp_call` behavior to the model or inherit project-local trust prompts intended for arbitrary MCP servers. Its responsibility is the Browser Automation Contract: stable canonical tools, Unit/debug-scoped browser sessions, engine health, teardown, and fail-closed behavior for browser-required workflows.

The first Pi-facing surface is a curated stable subset of the Browser Automation Contract, matching the browser tools GSD already depends on for debug and run-uat flows. Broader `gsd-browser` capabilities such as live viewer, recordings, auth vault, visual diff, and advanced diagnostics can be added deliberately instead of exposing the entire MCP tool surface by default.

Browser evidence is artifact-first and image-optional. Tools such as `browser_screenshot` should save evidence to artifact paths and return text/structured metadata that every Provider can consume. Providers that support image tool results may also receive image blocks, but browser verification must not depend on image ingestion alone. Assertions, snapshots, console/network logs, and evidence refs remain the primary verification surface.

When `gsd-browser` cannot start, browser-required Units and commands fail closed with an actionable engine error. They must not silently fall back to the legacy Playwright implementation. Legacy browser-tools behavior remains available only as an explicit compatibility fallback, not the default for new installs.

The explicit engine selector is `GSD_BROWSER_ENGINE=gsd-browser|legacy|off`, defaulting to `gsd-browser`. `legacy` forces the Playwright-backed compatibility implementation, and `off` disables Pi's Browser Automation Contract tools except for browser tools supplied directly by an External MCP Client or host integration. `GSD_BROWSER_MCP_ENABLED` remains scoped to `.mcp.json` generation for External MCP Clients.

Browser identity is project-scoped, while runtime browser sessions are Unit/debug-session scoped. GSD should use project identity for durable auth and state, but use distinct named `gsd-browser` sessions so parallel Units, worktrees, and debug sessions do not share one active page.

## Consequences

- GSD has one product-level Browser Automation Contract for Pi Providers and External MCP Clients.
- `browser-tools` becomes a contract adapter rather than the name of the legacy Playwright implementation.
- `gsd-browser mcp` is the implementation boundary inside Pi because the package is distributed as a CLI/native binary and its MCP server is the primary agent path.
- `/gsd mcp init` remains useful, but only for MCP-capable hosts outside Pi or host integrations that expose MCP names directly; its user-facing copy should describe both workflow and browser MCP servers.
- Doctor/onboarding should verify that `gsd-browser mcp` can start and list tools, while runtime should lazily connect only when browser automation is needed.
- Browser evidence remains usable on Providers that cannot ingest image tool results directly.
- Engine selection is explicit and separate from External MCP Client config generation.

## Migration Order

1. Add the managed `gsd-browser mcp` engine manager under `browser-tools`.
2. Route the curated canonical `browser_*` tool subset through that engine, keeping legacy Playwright behavior behind an explicit compatibility fallback.
3. Make debug, run-uat, and other browser-required flows fail closed when the primary engine is unavailable.
4. Update `/gsd mcp init` copy, docs, doctor, and onboarding so users understand that `.mcp.json` is for External MCP Clients while Pi Providers use the managed engine.

## Alternatives Considered

### Expose MCP-shaped names to all Providers

Rejected. It would leak transport naming into Pi prompts and tool policy, undoing the Browser Automation Contract boundary.

### Wrap `gsd-browser` CLI commands directly

Rejected. CLI wrapping would duplicate schemas, response handling, batching, resources, and future MCP improvements that already exist in `gsd-browser mcp`.

### Add a second Pi browser extension

Rejected. A new extension would compete with `browser-tools` for the same canonical `browser_*` names and increase migration risk.

### Silent fallback to legacy Playwright tools

Rejected. Silent fallback hides install/runtime regressions and makes debug evidence harder to trust.
