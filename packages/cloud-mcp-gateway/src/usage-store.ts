import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface UsageToolCallInput {
  userId: string;
  toolName: string;
  runtimeId?: string;
  projectAlias?: string;
  startedAt?: number;
  durationMs: number;
  ok: boolean;
  billable?: boolean;
  throttled?: boolean;
  error?: string;
}

export interface UsageEventRecord {
  eventId: string;
  userId: string;
  toolName: string;
  runtimeId?: string;
  projectAlias?: string;
  startedAt: number;
  durationMs: number;
  ok: boolean;
  billable: boolean;
  throttled?: boolean;
  error?: string;
}

export interface UsageBucketRecord {
  userId: string;
  toolName: string;
  day: string;
  calls: number;
  billableCalls: number;
  failures: number;
  throttled: number;
  totalDurationMs: number;
  lastCallAt: number;
}

export interface UsageSummaryRow {
  userId?: string;
  toolName?: string;
  calls: number;
  billableCalls: number;
  failures: number;
  throttled: number;
  totalDurationMs: number;
  averageDurationMs: number;
  lastCallAt?: number;
}

export interface UsageSummary {
  generatedAt: number;
  totalCalls: number;
  billableCalls: number;
  failedCalls: number;
  throttledCalls: number;
  totalDurationMs: number;
  averageDurationMs: number;
  byUser: UsageSummaryRow[];
  byTool: UsageSummaryRow[];
  byDay: UsageBucketRecord[];
  recentEvents: UsageEventRecord[];
}

export interface UsageStoreSnapshot {
  version: 1;
  buckets: UsageBucketRecord[];
  recentEvents: UsageEventRecord[];
}

const RECENT_EVENT_LIMIT = 200;

export class InMemoryUsageStore {
  protected readonly buckets = new Map<string, UsageBucketRecord>();
  protected readonly recentEvents: UsageEventRecord[] = [];

  constructor(snapshot?: UsageStoreSnapshot) {
    if (snapshot) this.loadSnapshot(snapshot);
  }

  recordToolCall(input: UsageToolCallInput): UsageEventRecord {
    const startedAt = input.startedAt ?? Date.now();
    const durationMs = Math.max(0, Math.round(input.durationMs));
    const billable = input.billable !== false;
    const event: UsageEventRecord = {
      eventId: `evt_${startedAt}_${Math.random().toString(16).slice(2)}`,
      userId: input.userId,
      toolName: input.toolName,
      ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
      ...(input.projectAlias ? { projectAlias: input.projectAlias } : {}),
      startedAt,
      durationMs,
      ok: input.ok,
      billable,
      ...(input.throttled ? { throttled: true } : {}),
      ...(input.error ? { error: input.error } : {}),
    };
    const day = new Date(startedAt).toISOString().slice(0, 10);
    const bucketKey = `${input.userId}\u0000${input.toolName}\u0000${day}`;
    const bucket = this.buckets.get(bucketKey) ?? {
      userId: input.userId,
      toolName: input.toolName,
      day,
      calls: 0,
      billableCalls: 0,
      failures: 0,
      throttled: 0,
      totalDurationMs: 0,
      lastCallAt: startedAt,
    };
    bucket.calls += 1;
    bucket.billableCalls += billable ? 1 : 0;
    bucket.failures += input.ok ? 0 : 1;
    bucket.throttled += input.throttled ? 1 : 0;
    bucket.totalDurationMs += durationMs;
    bucket.lastCallAt = Math.max(bucket.lastCallAt, startedAt);
    this.buckets.set(bucketKey, bucket);

    this.recentEvents.unshift(event);
    if (this.recentEvents.length > RECENT_EVENT_LIMIT) {
      this.recentEvents.length = RECENT_EVENT_LIMIT;
    }
    this.afterMutation();
    return event;
  }

  getSummary(): UsageSummary {
    const buckets = Array.from(this.buckets.values());
    const totalCalls = sum(buckets, "calls");
    const billableCalls = sum(buckets, "billableCalls");
    const failedCalls = sum(buckets, "failures");
    const throttledCalls = sum(buckets, "throttled");
    const totalDurationMs = sum(buckets, "totalDurationMs");
    return {
      generatedAt: Date.now(),
      totalCalls,
      billableCalls,
      failedCalls,
      throttledCalls,
      totalDurationMs,
      averageDurationMs: totalCalls ? Math.round(totalDurationMs / totalCalls) : 0,
      byUser: summarize(buckets, "userId"),
      byTool: summarize(buckets, "toolName"),
      byDay: buckets
        .map((bucket) => ({ ...bucket }))
        .sort((a, b) => b.day.localeCompare(a.day) || b.lastCallAt - a.lastCallAt),
      recentEvents: this.recentEvents.map((event) => ({ ...event })),
    };
  }

  getUserBillableUsage(userId: string, now = Date.now()): { day: number; month: number } {
    const day = new Date(now).toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    let dayTotal = 0;
    let monthTotal = 0;
    for (const bucket of this.buckets.values()) {
      if (bucket.userId !== userId) continue;
      if (bucket.day === day) dayTotal += bucket.billableCalls;
      if (bucket.day.startsWith(month)) monthTotal += bucket.billableCalls;
    }
    return { day: dayTotal, month: monthTotal };
  }

  snapshot(): UsageStoreSnapshot {
    return {
      version: 1,
      buckets: Array.from(this.buckets.values()),
      recentEvents: this.recentEvents,
    };
  }

  protected afterMutation(): void {
    // Extension point for persistent stores.
  }

  private loadSnapshot(snapshot: UsageStoreSnapshot): void {
    for (const bucket of snapshot.buckets ?? []) {
      if (!bucket.userId || !bucket.toolName || !bucket.day) continue;
      this.buckets.set(`${bucket.userId}\u0000${bucket.toolName}\u0000${bucket.day}`, {
        userId: bucket.userId,
        toolName: bucket.toolName,
        day: bucket.day,
        calls: Math.max(0, Number(bucket.calls) || 0),
        billableCalls: Math.max(0, Number(bucket.billableCalls ?? bucket.calls) || 0),
        failures: Math.max(0, Number(bucket.failures) || 0),
        throttled: Math.max(0, Number(bucket.throttled) || 0),
        totalDurationMs: Math.max(0, Number(bucket.totalDurationMs) || 0),
        lastCallAt: Math.max(0, Number(bucket.lastCallAt) || 0),
      });
    }
    for (const event of snapshot.recentEvents ?? []) {
      if (!event.userId || !event.toolName || typeof event.startedAt !== "number") continue;
      this.recentEvents.push({ ...event, billable: event.billable !== false });
      if (this.recentEvents.length >= RECENT_EVENT_LIMIT) break;
    }
  }
}

export class FileUsageStore extends InMemoryUsageStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    super(readUsageSnapshot(filePath));
    this.filePath = filePath;
    this.persist();
  }

  protected override afterMutation(): void {
    this.persist();
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.snapshot(), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.filePath);
  }
}

function summarize(buckets: UsageBucketRecord[], key: "userId" | "toolName"): UsageSummaryRow[] {
  const rows = new Map<string, UsageSummaryRow>();
  for (const bucket of buckets) {
    const rowKey = bucket[key];
    const row = rows.get(rowKey) ?? {
      [key]: rowKey,
      calls: 0,
      billableCalls: 0,
      failures: 0,
      throttled: 0,
      totalDurationMs: 0,
      averageDurationMs: 0,
      lastCallAt: undefined,
    };
    row.calls += bucket.calls;
    row.billableCalls += bucket.billableCalls;
    row.failures += bucket.failures;
    row.throttled += bucket.throttled;
    row.totalDurationMs += bucket.totalDurationMs;
    row.averageDurationMs = row.calls ? Math.round(row.totalDurationMs / row.calls) : 0;
    row.lastCallAt = Math.max(row.lastCallAt ?? 0, bucket.lastCallAt);
    rows.set(rowKey, row);
  }
  return Array.from(rows.values()).sort((a, b) => b.calls - a.calls);
}

function sum(
  buckets: UsageBucketRecord[],
  key: "calls" | "billableCalls" | "failures" | "throttled" | "totalDurationMs",
): number {
  return buckets.reduce((total, bucket) => total + bucket[key], 0);
}

function readUsageSnapshot(filePath: string): UsageStoreSnapshot | undefined {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<UsageStoreSnapshot>;
    if (parsed.version !== 1) return undefined;
    return {
      version: 1,
      buckets: Array.isArray(parsed.buckets) ? parsed.buckets as UsageBucketRecord[] : [],
      recentEvents: Array.isArray(parsed.recentEvents) ? parsed.recentEvents as UsageEventRecord[] : [],
    };
  } catch {
    return undefined;
  }
}
