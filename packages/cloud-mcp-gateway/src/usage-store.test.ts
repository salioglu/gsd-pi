import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileUsageStore, InMemoryUsageStore } from "./usage-store.js";

test("usage store aggregates calls by user, tool, and day", () => {
  const usage = new InMemoryUsageStore();
  usage.recordToolCall({
    userId: "u1",
    toolName: "gsd_status",
    startedAt: Date.parse("2026-06-01T12:00:00.000Z"),
    durationMs: 10,
    ok: true,
  });
  usage.recordToolCall({
    userId: "u1",
    toolName: "browser_navigate",
    startedAt: Date.parse("2026-06-01T12:01:00.000Z"),
    durationMs: 30,
    ok: false,
    billable: false,
    throttled: true,
    error: "offline",
  });

  const summary = usage.getSummary();
  assert.equal(summary.totalCalls, 2);
  assert.equal(summary.billableCalls, 1);
  assert.equal(summary.failedCalls, 1);
  assert.equal(summary.throttledCalls, 1);
  assert.equal(summary.averageDurationMs, 20);
  assert.deepEqual(summary.byUser.map((row) => ({
    userId: row.userId,
    calls: row.calls,
    billableCalls: row.billableCalls,
    failures: row.failures,
    throttled: row.throttled,
  })), [{ userId: "u1", calls: 2, billableCalls: 1, failures: 1, throttled: 1 }]);
  assert.deepEqual(usage.getUserBillableUsage("u1", Date.parse("2026-06-01T12:05:00.000Z")), {
    day: 1,
    month: 1,
  });
  assert.deepEqual(summary.byTool.map((row) => row.toolName).sort(), ["browser_navigate", "gsd_status"]);
  assert.equal(summary.byDay[0]?.day, "2026-06-01");
  assert.equal(summary.recentEvents[0]?.toolName, "browser_navigate");
});

test("file usage store persists aggregate usage", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-cloud-usage-"));
  const storePath = join(dir, "usage.json");
  const first = new FileUsageStore(storePath);
  first.recordToolCall({
    userId: "u1",
    toolName: "gsd_status",
    startedAt: 1000,
    durationMs: 12,
    ok: true,
  });

  const second = new FileUsageStore(storePath);
  const summary = second.getSummary();
  assert.equal(summary.totalCalls, 1);
  assert.equal(summary.byTool[0]?.toolName, "gsd_status");
});
