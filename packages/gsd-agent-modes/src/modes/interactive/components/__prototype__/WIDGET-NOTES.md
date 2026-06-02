# PROTOTYPE - /gsd Auto Widget

Question: which compact `/gsd` auto-progress widget keeps the widget small while using horizontal terminal space well?

Run:

```bash
pnpm run prototype:tui-widget
pnpm run prototype:tui-widget -- horizontal-bar
PROTOTYPE_WIDTH=100 pnpm run prototype:tui-widget -- all
```

Verdict placeholder:

- Ship: D `dense-grid`
- Defer: A/B/C
- Delete prototype after: `/gsd` small widget ships and stays stable
