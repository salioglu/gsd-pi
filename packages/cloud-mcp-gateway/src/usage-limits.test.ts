import assert from "node:assert/strict";
import { test } from "node:test";
import type { UserRecord } from "./auth-store.js";
import { UsageLimiter, parseUsageLimitConfig } from "./usage-limits.js";
import { InMemoryUsageStore } from "./usage-store.js";

test("usage limiter enforces per-minute free limits", () => {
  const user = makeUser("u1");
  const usage = new InMemoryUsageStore();
  const limiter = new UsageLimiter({
    free: { callsPerMinute: 2 },
    paid: {},
    unlimited: {},
  });
  const now = Date.parse("2026-06-01T12:00:00.000Z");

  assert.equal(limiter.check(user, usage, now).allowed, true);
  assert.equal(limiter.check(user, usage, now + 1).allowed, true);
  const denied = limiter.check(user, usage, now + 2);
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "minute");
});

test("usage limiter enforces billable day and month limits", () => {
  const user = makeUser("u1");
  const usage = new InMemoryUsageStore();
  usage.recordToolCall({
    userId: "u1",
    toolName: "gsd_status",
    startedAt: Date.parse("2026-06-01T12:00:00.000Z"),
    durationMs: 1,
    ok: true,
  });
  usage.recordToolCall({
    userId: "u1",
    toolName: "gsd_status",
    startedAt: Date.parse("2026-06-01T12:00:01.000Z"),
    durationMs: 1,
    ok: false,
    billable: false,
    throttled: true,
  });
  const limiter = new UsageLimiter({
    free: { callsPerDay: 1, callsPerMonth: 1 },
    paid: {},
    unlimited: {},
  });

  const denied = limiter.check(user, usage, Date.parse("2026-06-01T12:00:02.000Z"));
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "day");
  assert.equal(denied.usage.day, 1);
  assert.equal(denied.usage.month, 1);
});

test("unlimited plan bypasses configured free limits", () => {
  const user = makeUser("u1", "unlimited");
  const usage = new InMemoryUsageStore();
  const limiter = new UsageLimiter({
    free: { callsPerMinute: 0, callsPerDay: 1, callsPerMonth: 1 },
    paid: {},
    unlimited: {},
  });

  assert.equal(limiter.check(user, usage).allowed, true);
  assert.equal(limiter.check(user, usage).allowed, true);
});

test("usage limit config parses environment values", () => {
  const config = parseUsageLimitConfig({
    GSD_CLOUD_FREE_CALLS_PER_MINUTE: "3",
    GSD_CLOUD_FREE_CALLS_PER_DAY: "4",
    GSD_CLOUD_FREE_CALLS_PER_MONTH: "5",
    GSD_CLOUD_PAID_CALLS_PER_MINUTE: "0",
    GSD_CLOUD_PAID_CALLS_PER_DAY: "not-a-number",
    GSD_CLOUD_PAID_CALLS_PER_MONTH: "7",
  });

  assert.deepEqual(config.free, {
    callsPerMinute: 3,
    callsPerDay: 4,
    callsPerMonth: 5,
  });
  assert.deepEqual(config.paid, {
    callsPerMinute: undefined,
    callsPerDay: 2000,
    callsPerMonth: 7,
  });
});

function makeUser(userId: string, plan: UserRecord["plan"] = "free"): UserRecord {
  return {
    userId,
    role: "member",
    plan,
    createdAt: Date.now(),
  };
}
