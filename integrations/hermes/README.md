# open-gsd-hermes

Hermes Agent plugin integrating [GSD Pi](https://github.com/open-gsd/gsd-pi) as the structured delivery engine.

## Install

```bash
pip install -e integrations/hermes
hermes plugins enable open-gsd-hermes
```

## Configuration

`~/.hermes/gsd.yaml` — see `docs/setup.md`.

## Slash commands

- `/gsd bind <path>` — bind session to project
- `/gsd status` — show progress
- `/gsd auto` — start auto mode via MCP
- `/gsd cancel` — cancel running session
- `/gsd reply <text>` — resolve blocker

## Requirements

- `gsd >=2.51,<3`
- `gsd-mcp-server` on PATH or configured in `gsd.yaml`
