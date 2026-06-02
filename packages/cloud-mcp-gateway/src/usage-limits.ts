import type { UserPlan, UserQuotaOverrides, UserRecord } from "./auth-store.js";
import type { InMemoryUsageStore } from "./usage-store.js";

export interface UsageLimits {
  callsPerMinute?: number;
  callsPerDay?: number;
  callsPerMonth?: number;
}

export interface UsageLimitConfig {
  free: UsageLimits;
  paid: UsageLimits;
  unlimited: UsageLimits;
}

export interface UsageQuotaStatus {
  userId: string;
  plan: UserPlan;
  limits: UsageLimits;
  usage: {
    minute: number;
    day: number;
    month: number;
  };
  remaining: {
    minute?: number;
    day?: number;
    month?: number;
  };
  resetAt: {
    minute?: number;
    day: number;
    month: number;
  };
  allowed: boolean;
  reason?: string;
  retryAfterSeconds?: number;
}

const WINDOW_MS = 60 * 1000;

export class UsageLimiter {
  private readonly minuteCalls = new Map<string, number[]>();

  constructor(private readonly config: UsageLimitConfig) {}

  check(user: UserRecord, usage: InMemoryUsageStore, now = Date.now()): UsageQuotaStatus {
    const limits = resolveLimits(user, this.config);
    const calls = this.prune(user.userId, now);
    const minute = calls.length;
    const billable = usage.getUserBillableUsage(user.userId, now);
    const status = buildStatus(user, limits, {
      minute,
      day: billable.day,
      month: billable.month,
    }, now, calls[0] ? calls[0] + WINDOW_MS : undefined);
    if (!status.allowed) return status;
    this.noteAccepted(user.userId, now);
    return {
      ...status,
      usage: {
        ...status.usage,
        minute: minute + 1,
      },
      remaining: {
        ...status.remaining,
        ...(status.remaining.minute !== undefined ? { minute: Math.max(0, status.remaining.minute - 1) } : {}),
      },
    };
  }

  inspect(user: UserRecord, usage: InMemoryUsageStore, now = Date.now()): UsageQuotaStatus {
    const limits = resolveLimits(user, this.config);
    const billable = usage.getUserBillableUsage(user.userId, now);
    const calls = this.prune(user.userId, now);
    return buildStatus(user, limits, {
      minute: calls.length,
      day: billable.day,
      month: billable.month,
    }, now, calls[0] ? calls[0] + WINDOW_MS : undefined);
  }

  private noteAccepted(userId: string, now: number): void {
    const calls = this.prune(userId, now);
    calls.push(now);
    this.minuteCalls.set(userId, calls);
  }

  private prune(userId: string, now: number): number[] {
    const cutoff = now - WINDOW_MS;
    const calls = (this.minuteCalls.get(userId) ?? []).filter((timestamp) => timestamp > cutoff);
    if (calls.length) this.minuteCalls.set(userId, calls);
    else this.minuteCalls.delete(userId);
    return calls;
  }
}

export function parseUsageLimitConfig(env: Record<string, string | undefined> = process.env): UsageLimitConfig {
  return {
    free: {
      callsPerMinute: readLimit(env.GSD_CLOUD_FREE_CALLS_PER_MINUTE, 12),
      callsPerDay: readLimit(env.GSD_CLOUD_FREE_CALLS_PER_DAY, 100),
      callsPerMonth: readLimit(env.GSD_CLOUD_FREE_CALLS_PER_MONTH, 1000),
    },
    paid: {
      callsPerMinute: readLimit(env.GSD_CLOUD_PAID_CALLS_PER_MINUTE, 60),
      callsPerDay: readLimit(env.GSD_CLOUD_PAID_CALLS_PER_DAY, 2000),
      callsPerMonth: readLimit(env.GSD_CLOUD_PAID_CALLS_PER_MONTH, 50000),
    },
    unlimited: {},
  };
}

export function formatQuotaExceeded(status: UsageQuotaStatus): string {
  if (status.reason === "minute") {
    return `Usage limit exceeded: ${status.limits.callsPerMinute} tool calls per minute. Try again in ${status.retryAfterSeconds ?? 60}s.`;
  }
  if (status.reason === "day") {
    return `Usage limit exceeded: ${status.limits.callsPerDay} billable tool calls per day.`;
  }
  if (status.reason === "month") {
    return `Usage limit exceeded: ${status.limits.callsPerMonth} billable tool calls per month.`;
  }
  return "Usage limit exceeded.";
}

function resolveLimits(user: UserRecord, config: UsageLimitConfig): UsageLimits {
  return {
    ...config[user.plan],
    ...normalizeOverrides(user.quotaOverrides),
  };
}

function buildStatus(
  user: UserRecord,
  limits: UsageLimits,
  usage: UsageQuotaStatus["usage"],
  now: number,
  minuteResetAt: number | undefined,
): UsageQuotaStatus {
  const resetAt = {
    minute: minuteResetAt,
    day: nextUtcDay(now),
    month: nextUtcMonth(now),
  };
  const remaining = {
    ...(isLimited(limits.callsPerMinute) ? { minute: Math.max(0, limits.callsPerMinute - usage.minute) } : {}),
    ...(isLimited(limits.callsPerDay) ? { day: Math.max(0, limits.callsPerDay - usage.day) } : {}),
    ...(isLimited(limits.callsPerMonth) ? { month: Math.max(0, limits.callsPerMonth - usage.month) } : {}),
  };
  if (isLimited(limits.callsPerMinute) && usage.minute >= limits.callsPerMinute) {
    return {
      userId: user.userId,
      plan: user.plan,
      limits,
      usage,
      remaining,
      resetAt,
      allowed: false,
      reason: "minute",
      retryAfterSeconds: Math.max(1, Math.ceil(((resetAt.minute ?? now + WINDOW_MS) - now) / 1000)),
    };
  }
  if (isLimited(limits.callsPerDay) && usage.day >= limits.callsPerDay) {
    return {
      userId: user.userId,
      plan: user.plan,
      limits,
      usage,
      remaining,
      resetAt,
      allowed: false,
      reason: "day",
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt.day - now) / 1000)),
    };
  }
  if (isLimited(limits.callsPerMonth) && usage.month >= limits.callsPerMonth) {
    return {
      userId: user.userId,
      plan: user.plan,
      limits,
      usage,
      remaining,
      resetAt,
      allowed: false,
      reason: "month",
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt.month - now) / 1000)),
    };
  }
  return {
    userId: user.userId,
    plan: user.plan,
    limits,
    usage,
    remaining,
    resetAt,
    allowed: true,
  };
}

function normalizeOverrides(value: UserQuotaOverrides | undefined): UsageLimits {
  if (!value) return {};
  return {
    ...(value.callsPerMinute !== undefined ? { callsPerMinute: value.callsPerMinute } : {}),
    ...(value.callsPerDay !== undefined ? { callsPerDay: value.callsPerDay } : {}),
    ...(value.callsPerMonth !== undefined ? { callsPerMonth: value.callsPerMonth } : {}),
  };
}

function readLimit(value: string | undefined, fallback: number): number | undefined {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  if (parsed === 0) return undefined;
  return Math.max(1, Math.floor(parsed));
}

function isLimited(limit: number | undefined): limit is number {
  return typeof limit === "number" && limit > 0;
}

function nextUtcDay(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

function nextUtcMonth(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}
