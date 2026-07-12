# Project-local runtime contract

GSD discovers an optional project-local contract that tells agents how to start, inspect, seed, and stop a business project's local runtime. This avoids guessed ports, working directories, environment files, and direct package or container commands in repositories with custom startup choreography.

## Default convention

Create `script/local-runtime/` at the project root. GSD recognizes these files:

- `AGENT.md` — rules agents must follow before changing runtime state.
- `README.md` — human-readable startup, health, seed, and teardown instructions.
- `runtime.mjs`, `runtime.js`, `runtime.ts`, or `runtime.sh` — the canonical entry point, discovered in that order.

When any recognized file exists, GSD adds its resolved path and a read-before-runtime instruction to agent and subagent system context. GSD does not automatically execute the entry point or infer its actions.

```text
script/
└── local-runtime/
    ├── AGENT.md
    ├── README.md
    └── runtime.mjs
```

Document the actions supported by the entry point in `README.md`, for example:

```text
node script/local-runtime/runtime.mjs start
node script/local-runtime/runtime.mjs status
node script/local-runtime/runtime.mjs seed
node script/local-runtime/runtime.mjs stop
```

## Custom location

Set `runtime.contract` in project-local `.gsd/PREFERENCES.md` to nominate a different directory or entry point:

```yaml
---
runtime:
  contract:
    path: ops/dev
    entry: run.mjs
---
```

Both values must be relative paths that remain inside the project. Symlinked contract files that resolve outside the active project or worktree are ignored.

In a parent workspace, place the shared contract at the parent project root. Child-repository startup can then be coordinated through one documented entry point.
