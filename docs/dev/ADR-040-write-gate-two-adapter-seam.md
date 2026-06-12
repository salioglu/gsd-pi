# ADR-040: Write-gate two-process seam — host/child adapters, epoch-stamped snapshot

## Status

Accepted (2026-06-12)

## Context

Write-gate state has two writers — the host process and the MCP child (which dynamically imports the host's compiled `write-gate.js` via `GSD_WORKFLOW_WRITE_GATE_MODULE`) — coordinating through a whole-file snapshot (`.gsd/runtime/write-gate-state.json`) with last-writer-wins and no epoch. Races were patched ad hoc: the host re-arm clobbering child verification was guarded at exactly one call site (`tool_execution_start`), while the same window on the `tool_call` defer path was unguarded; a single global `deferredApprovalGate` variable was shared across basePaths, so concurrent projects in one process could lose a deferred gate.

## Decision

The seam is named: `WriteGateStateAdapter` with two adapters.

- **Host adapter** — in-memory + reconcile-on-read. Merge rules (documented on `mergeSnapshotIntoState`): verifications are a grow-only union across processes; `pendingGateId`/`activeQueuePhase` disk wins (preserves refresh semantics and the delete-the-file escape hatch); **verified wins over pending** — a pending gate whose id/milestone is in the merged verified set is dropped (the old one-window guard, generalized into adapter policy). Host `setPending` returns suppressed when the gate is verified on disk.
- **Child adapter** — write-through, always-fresh read (load → mutate → persist), no cross-turn memory. Child `setPending` stays unconditional: a fresh question intentionally revokes verification.
- **Epoch**: monotonic `epoch` plus `writer: host|child` tag in the snapshot, bumped on every persist; mutations are read-disk → merge → mutate → atomic temp+rename. Missing epoch reads as 0 (old files load; old readers ignore the new fields). `resetWriteGateState` skips content merge (a reset must not resurrect disk verifications) but advances past the disk epoch.
- Adapter selection rides the existing child-spawn env (`GSD_WORKFLOW_WRITE_GATE_MODULE`/`GSD_WORKFLOW_PROJECT_ROOT` present → child adapter); all exported function signatures are unchanged, so `packages/mcp-server` needed zero edits.
- `deferredApprovalGate` is per-basePath (`Map<basePath, gateId>`); the `tool_call` defer path now consults the reconciled snapshot, closing the second clobber window.

No file locking was introduced (Windows/sync-client risk); file-level atomicity (temp+rename, EXDEV fallback) and the `GSD_PERSIST_WRITE_GATE_STATE` opt-out are preserved.

## Consequences

- Host/child interleavings are deterministic adapter tests (`write-gate-seam.test.ts`): clobber windows, epoch conflict re-merge, two-basePath deferral, legacy snapshot load.
- Every future two-process race is reasoned about inside the adapter pair, not at each hook site.
