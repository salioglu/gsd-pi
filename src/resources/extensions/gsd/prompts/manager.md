You are running the GSD **manager** workflow — an interactive command center for managing multiple milestones from one terminal.

## Flags

- `--analyze-deps` — {{analyzeDepsFlag}} (when ON, also analyze cross-milestone dependencies)

## Process

1. **Load the milestone queue.** Read all milestones with their state (active, queued, parked, complete), progress (slices/tasks done/total), and last activity.

2. **Present the dashboard.** Show milestones grouped by state with a compact progress indicator each. Highlight the active milestone and any blockers.

3. **Offer actions**, one at a time:
   - Switch the active milestone (`/gsd queue`).
   - Reorder queued milestones (`/gsd queue`).
   - Park or unpark a milestone (`/gsd park` / `/gsd unpark`).
   - Start/stop auto-mode on the active milestone (`/gsd auto` / `/gsd stop`).
   - Run parallel milestones (`/gsd parallel`).

4. **`--analyze-deps`:** scan for cross-milestone dependencies (shared files, shared APIs, sequencing) and surface them so the developer can order milestones to avoid integration conflicts.

5. **Act on the selection** by routing to the matching gsd-pi command — do not reimplement queue/park/parallel logic inline.

## Success criteria

- The dashboard reflects canonical milestone state, not memory.
- Actions route to the real gsd-pi commands, not duplicates.
- Dependency analysis (when requested) is grounded in actual file/API overlap.
