/**
 * GSD dashboard overlay dialog chrome tests.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { GSDDashboardOverlay } from "../dashboard-overlay.ts";
import type { UnitMetrics } from "../metrics.ts";
import { assertFullOuterBorder } from "./tui-border-assertions.ts";

const fakeTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

test("GSDDashboardOverlay renders inside the shared full border", (t) => {
  const overlay = new GSDDashboardOverlay({ requestRender() {} }, fakeTheme as any, () => {});
  t.after(() => overlay.dispose());

  const lines = overlay.render(100);
  assertFullOuterBorder(lines, 100);
  assert.match(lines[0] ?? "", /^╭─ GSD Dashboard /);
  assert.ok(lines.some((line) => line.startsWith("│")), "body rows should have side borders");
  assert.match(lines.at(-1) ?? "", /^╰─+╯$/);
});

test("GSDDashboardOverlay reuses metrics aggregations only when ledger content is unchanged", (t) => {
  const overlay = new GSDDashboardOverlay({ requestRender() {} }, fakeTheme as any, () => {});
  t.after(() => overlay.dispose());

  const firstUnits = [makeUnit("M001/S001/T001", 0.25, 2000)];
  const firstMetrics = (overlay as any).ensureMetricsCache(firstUnits);

  // Same array reference: cache must be reused
  assert.equal(
    (overlay as any).ensureMetricsCache(firstUnits),
    firstMetrics,
    "identical units array should reuse cached metrics",
  );

  // Same unit count but finishedAt changed (simulates in-place ledger re-snapshot)
  const updatedUnits = [makeUnit("M001/S001/T001", 0.50, 3000)];
  const updatedMetrics = (overlay as any).ensureMetricsCache(updatedUnits);
  assert.notEqual(updatedMetrics, firstMetrics, "updated finishedAt should invalidate cache");
  assert.equal(updatedMetrics.totals.cost, 0.50);

  // Adding a new unit also invalidates
  const expandedMetrics = (overlay as any).ensureMetricsCache([
    ...updatedUnits,
    makeUnit("M001/S001/T002", 0.75, 4000),
  ]);
  assert.notEqual(expandedMetrics, updatedMetrics, "added unit should invalidate cache");
  assert.equal(expandedMetrics.totals.units, 2);
  assert.equal(expandedMetrics.totals.cost, 1.25);
});

function makeUnit(id: string, cost: number, finishedAt = 2000): UnitMetrics {
  return {
    type: "execute-task",
    id,
    model: "claude-sonnet-4.5",
    startedAt: 1000,
    finishedAt,
    tokens: {
      input: 100,
      output: 50,
      cacheRead: 25,
      cacheWrite: 10,
      total: 185,
    },
    cost,
    toolCalls: 1,
    assistantMessages: 1,
    userMessages: 1,
  };
}
