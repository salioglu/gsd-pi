// Project/App: gsd-pi
// File Purpose: Ephemeral-copy SQLite inspection for retained legacy import database bytes.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createDbAdapter, type DbAdapter } from "./db-adapter.js";
import { BETTER_SQLITE3_PACKAGE } from "./db-provider.js";
import type { LegacyImportSha256, LegacyImportValue } from "./legacy-import-contract.js";
import type {
  LegacyImportDatabaseTargetHeaderEvidence,
  LegacyImportDatabaseTargetInspectionEvidence,
  LegacyImportDatabaseTargetInspectionRequest,
  LegacyImportDatabaseTargetSchemaEvidence,
} from "./legacy-import-preview-database-target.js";
import { hashLegacyImportBytes, hashLegacyImportValue } from "./legacy-import-preview.js";

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "binary");
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export type LegacyImportDatabaseTargetInspectionErrorStage =
  | "materialize"
  | "provider"
  | "close"
  | "cleanup";

export class LegacyImportDatabaseTargetInspectionError extends Error {
  readonly stage: LegacyImportDatabaseTargetInspectionErrorStage;
  readonly code: string;
  readonly retryable: boolean;
  readonly context: Readonly<Record<string, string>>;

  constructor(
    stage: LegacyImportDatabaseTargetInspectionErrorStage,
    code: string,
    message: string,
    retryable: boolean,
    context: Record<string, string> = {},
  ) {
    super(message);
    this.name = "LegacyImportDatabaseTargetInspectionError";
    this.stage = stage;
    this.code = code;
    this.retryable = retryable;
    this.context = Object.freeze({ ...context });
  }
}

export interface LegacyImportDatabaseTargetInspectionConnection {
  db: DbAdapter;
  enableDefensive?(): void;
}

export interface LegacyImportDatabaseTargetInspectorDeps {
  makeTemporaryDirectory(): string;
  writePrivateFile(path: string, bytes: Buffer): void;
  readFile(path: string): Buffer;
  removeTemporaryDirectory(path: string): void;
  openReadOnly(path: string): LegacyImportDatabaseTargetInspectionConnection;
}

interface SchemaRow {
  type: string;
  name: string;
  table: string;
  sqlHash: LegacyImportSha256;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function requestContext(request: LegacyImportDatabaseTargetInspectionRequest): Record<string, string> {
  return { source_id: request.source_id, logical_path: request.logical_path };
}

function validateRequest(request: LegacyImportDatabaseTargetInspectionRequest): void {
  if (
    request.root_kind !== "project" && request.root_kind !== "external"
    || request.logical_path.length === 0
    || !SHA256_PATTERN.test(request.capture_hash)
    || !SHA256_PATTERN.test(request.source_id)
    || !SHA256_PATTERN.test(request.source_sha256)
    || !Number.isSafeInteger(request.source_byte_size)
    || request.source_byte_size < 0
    || request.bytes.length !== request.source_byte_size
    || hashLegacyImportBytes(request.bytes) !== request.source_sha256
  ) {
    throw new LegacyImportDatabaseTargetInspectionError(
      "materialize",
      "LEGACY_IMPORT_DATABASE_INSPECTION_REQUEST_INVALID",
      "legacy import database inspection request is inconsistent",
      false,
      requestContext(request),
    );
  }
}

function headerEvidence(bytes: Buffer): LegacyImportDatabaseTargetHeaderEvidence | undefined {
  if (bytes.length < 100 || !bytes.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) return undefined;
  const storedPageSize = bytes.readUInt16BE(16);
  const pageSize = storedPageSize === 1 ? 65_536 : storedPageSize;
  const validPageSize = pageSize === 65_536
    || (pageSize >= 512 && pageSize <= 32_768 && (pageSize & (pageSize - 1)) === 0);
  if (
    !validPageSize
    || bytes.length < pageSize
    || bytes.length % pageSize !== 0
    || !([1, 2] as const).includes(bytes[18] as 1 | 2)
    || !([1, 2] as const).includes(bytes[19] as 1 | 2)
    || bytes[21] !== 64
    || bytes[22] !== 32
    || bytes[23] !== 32
  ) return undefined;
  return { page_size: pageSize, write_version: bytes[18]!, read_version: bytes[19]! };
}

function failureFingerprint(
  request: LegacyImportDatabaseTargetInspectionRequest,
  reason: string,
): LegacyImportSha256 {
  return hashLegacyImportValue({ reason, source_sha256: request.source_sha256 });
}

function sealEvidence(
  request: LegacyImportDatabaseTargetInspectionRequest,
  inspection: LegacyImportDatabaseTargetInspectionEvidence["inspection"],
): LegacyImportDatabaseTargetInspectionEvidence {
  const value = {
    evidence_version: 1 as const,
    inspection_version: 1 as const,
    capture_hash: request.capture_hash,
    source_id: request.source_id,
    root_kind: request.root_kind,
    logical_path: request.logical_path,
    source_sha256: request.source_sha256,
    source_byte_size: request.source_byte_size,
    sidecars: [] as const,
    inspection,
  };
  return deepFreeze({ ...value, evidence_hash: hashLegacyImportValue(value) });
}

function rejectedEvidence(
  request: LegacyImportDatabaseTargetInspectionRequest,
  reason: "invalid-header" | "open-failed" | "quick-check-failed" | "non-gsd",
): LegacyImportDatabaseTargetInspectionEvidence {
  return sealEvidence(request, {
    kind: "rejected",
    reason,
    failure_fingerprint: failureFingerprint(request, reason),
  });
}

function systemRequire(): ReturnType<typeof createRequire> {
  const packageRoot = process.env.GSD_WEB_PACKAGE_ROOT || process.env.GSD_PKG_ROOT || process.cwd();
  return createRequire(resolve(packageRoot, "package.json"));
}

function defaultOpenReadOnly(path: string): LegacyImportDatabaseTargetInspectionConnection {
  const require = systemRequire();
  let nodeSqlite: unknown;
  try {
    nodeSqlite = require("node:sqlite");
  } catch {
    nodeSqlite = undefined;
  }
  const NodeDatabase = (nodeSqlite as { DatabaseSync?: new (path: string, options: object) => unknown } | undefined)
    ?.DatabaseSync;
  if (NodeDatabase !== undefined) {
    const raw = new NodeDatabase(path, {
      readOnly: true,
      allowExtension: false,
      enableForeignKeyConstraints: false,
    }) as { enableDefensive?(active: boolean): void };
    return {
      db: createDbAdapter(raw),
      ...(typeof raw.enableDefensive === "function"
        ? { enableDefensive: () => raw.enableDefensive!(true) }
        : {}),
    };
  }
  let betterSqlite: unknown;
  try {
    betterSqlite = require(BETTER_SQLITE3_PACKAGE);
  } catch {
    betterSqlite = undefined;
  }
  const BetterDatabase = typeof betterSqlite === "function"
    ? betterSqlite
    : (betterSqlite as { default?: unknown } | undefined)?.default;
  if (typeof BetterDatabase !== "function") {
    throw new LegacyImportDatabaseTargetInspectionError(
      "provider",
      "LEGACY_IMPORT_DATABASE_INSPECTION_PROVIDER_UNAVAILABLE",
      "legacy import database inspection requires an available SQLite provider",
      false,
    );
  }
  const raw = new (BetterDatabase as new (path: string, options: object) => unknown)(path, {
    readonly: true,
    fileMustExist: true,
  });
  return { db: createDbAdapter(raw) };
}

const DEFAULT_DEPS: LegacyImportDatabaseTargetInspectorDeps = {
  makeTemporaryDirectory: () => mkdtempSync(join(tmpdir(), "gsd-legacy-db-inspect-")),
  writePrivateFile: (path, bytes) => writeFileSync(path, bytes, { flag: "wx", mode: 0o600 }),
  readFile: (path) => readFileSync(path),
  removeTemporaryDirectory: (path) => rmSync(path, { recursive: true, force: true }),
  openReadOnly: defaultOpenReadOnly,
};

function firstValue(row: Record<string, unknown> | undefined): unknown {
  return row === undefined ? undefined : Object.values(row)[0];
}

function configureReadOnlyConnection(connection: LegacyImportDatabaseTargetInspectionConnection): void {
  connection.enableDefensive?.();
  connection.db.exec("PRAGMA query_only=ON");
  connection.db.exec("PRAGMA trusted_schema=OFF");
  connection.db.exec("PRAGMA cell_size_check=ON");
  connection.db.exec("PRAGMA mmap_size=0");
}

function sqliteSchemaRows(db: DbAdapter): SchemaRow[] {
  return db.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    ORDER BY type, name, tbl_name
  `).all().map((row) => {
    if (
      typeof row["type"] !== "string"
      || typeof row["name"] !== "string"
      || typeof row["tbl_name"] !== "string"
      || (row["sql"] !== null && typeof row["sql"] !== "string")
    ) throw new Error("invalid sqlite schema row");
    return {
      type: row["type"],
      name: row["name"],
      table: row["tbl_name"],
      sqlHash: hashLegacyImportValue(row["sql"] as LegacyImportValue),
    };
  });
}

function objectExists(rows: readonly SchemaRow[], type: string, name: string): boolean {
  return rows.some((row) => row.type === type && row.name === name);
}

function safeRowCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("invalid sqlite row count");
  return value as number;
}

function coreRowCount(db: DbAdapter, rows: readonly SchemaRow[], table: string): number | null {
  if (!objectExists(rows, "table", table)) return null;
  return safeRowCount(firstValue(db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get()));
}

function schemaEvidence(db: DbAdapter): LegacyImportDatabaseTargetSchemaEvidence {
  const rows = sqliteSchemaRows(db);
  const versionObject = rows.find((row) => row.name === "schema_version");
  let versionRows: Record<string, unknown>[] = [];
  if (versionObject?.type === "table") {
    versionRows = db.prepare("SELECT version FROM schema_version ORDER BY rowid").all();
  }
  const versions: number[] = [];
  let invalidVersionCount = 0;
  for (const row of versionRows) {
    const version = row["version"];
    if (!Number.isSafeInteger(version) || (version as number) < 1) invalidVersionCount += 1;
    else versions.push(version as number);
  }
  versions.sort((left, right) => left - right);
  const uniqueVersions = [...new Set(versions)];
  const inspectCoreRows = uniqueVersions.length === 0;
  let versionTableKind: LegacyImportDatabaseTargetSchemaEvidence["version_table_kind"] = "other";
  if (versionObject === undefined) versionTableKind = "absent";
  else if (versionObject.type === "table") versionTableKind = "table";
  return {
    version_table_kind: versionTableKind,
    version_row_count: versionRows.length,
    versions: uniqueVersions,
    invalid_version_count: invalidVersionCount,
    schema_fingerprint: hashLegacyImportValue(rows.map((row) => ({
      type: row.type,
      name: row.name,
      table: row.table,
      sql_hash: row.sqlHash,
    }))),
    anchors: {
      project_authority: objectExists(rows, "table", "project_authority"),
      workflow_import_applications: objectExists(rows, "table", "workflow_import_applications"),
      milestone_reopen_trigger: objectExists(rows, "trigger", "trg_workflow_lifecycle_reopen_authorization"),
    },
    core_row_counts: {
      milestones: inspectCoreRows ? coreRowCount(db, rows, "milestones") : null,
      decisions: inspectCoreRows ? coreRowCount(db, rows, "decisions") : null,
      memories: inspectCoreRows ? coreRowCount(db, rows, "memories") : null,
    },
  };
}

function inspectCopy(
  request: LegacyImportDatabaseTargetInspectionRequest,
  path: string,
  deps: LegacyImportDatabaseTargetInspectorDeps,
): LegacyImportDatabaseTargetInspectionEvidence {
  let connection: LegacyImportDatabaseTargetInspectionConnection;
  try {
    connection = deps.openReadOnly(path);
  } catch (error) {
    if (error instanceof LegacyImportDatabaseTargetInspectionError) throw error;
    return rejectedEvidence(request, "open-failed");
  }
  try {
    try {
      configureReadOnlyConnection(connection);
    } catch {
      return rejectedEvidence(request, "open-failed");
    }
    let quickCheck: unknown;
    try {
      quickCheck = firstValue(connection.db.prepare("PRAGMA quick_check(1)").get());
    } catch {
      return rejectedEvidence(request, "quick-check-failed");
    }
    if (quickCheck !== "ok") return rejectedEvidence(request, "quick-check-failed");
    try {
      return sealEvidence(request, {
        kind: "sqlite",
        header: headerEvidence(request.bytes)!,
        quick_check: "ok",
        schema: schemaEvidence(connection.db),
      });
    } catch {
      return rejectedEvidence(request, "non-gsd");
    }
  } finally {
    try {
      connection.db.close();
    } catch {
      throw new LegacyImportDatabaseTargetInspectionError(
        "close",
        "LEGACY_IMPORT_DATABASE_INSPECTION_CLOSE_FAILED",
        "legacy import database inspection copy could not be closed safely",
        true,
        requestContext(request),
      );
    }
  }
}

export function inspectLegacyImportDatabaseTarget(
  request: LegacyImportDatabaseTargetInspectionRequest,
  deps: LegacyImportDatabaseTargetInspectorDeps = DEFAULT_DEPS,
): LegacyImportDatabaseTargetInspectionEvidence {
  validateRequest(request);
  if (headerEvidence(request.bytes) === undefined) return rejectedEvidence(request, "invalid-header");
  let directory: string;
  try {
    directory = deps.makeTemporaryDirectory();
  } catch {
    throw new LegacyImportDatabaseTargetInspectionError(
      "materialize",
      "LEGACY_IMPORT_DATABASE_INSPECTION_TEMP_FAILED",
      "legacy import database inspection copy could not be created",
      true,
      requestContext(request),
    );
  }
  const path = join(directory, "candidate.db");
  let copyCreated = false;
  try {
    try {
      deps.writePrivateFile(path, Buffer.from(request.bytes));
      const materialized = deps.readFile(path);
      if (materialized.length !== request.source_byte_size || hashLegacyImportBytes(materialized) !== request.source_sha256) {
        throw new Error("copy mismatch");
      }
      copyCreated = true;
    } catch {
      throw new LegacyImportDatabaseTargetInspectionError(
        "materialize",
        "LEGACY_IMPORT_DATABASE_INSPECTION_COPY_FAILED",
        "legacy import database inspection copy is inconsistent",
        true,
        requestContext(request),
      );
    }
    return inspectCopy(request, path, deps);
  } finally {
    let copyChanged = false;
    if (copyCreated) {
      try {
        const materialized = deps.readFile(path);
        copyChanged = materialized.length !== request.source_byte_size
          || hashLegacyImportBytes(materialized) !== request.source_sha256;
      } catch {
        copyChanged = true;
      }
    }
    try {
      deps.removeTemporaryDirectory(directory);
    } catch {
      throw new LegacyImportDatabaseTargetInspectionError(
        "cleanup",
        "LEGACY_IMPORT_DATABASE_INSPECTION_CLEANUP_FAILED",
        "legacy import database inspection copy could not be removed safely",
        true,
        requestContext(request),
      );
    }
    if (copyChanged) {
      throw new LegacyImportDatabaseTargetInspectionError(
        "cleanup",
        "LEGACY_IMPORT_DATABASE_INSPECTION_COPY_CHANGED",
        "legacy import database inspection copy changed during read-only inspection",
        false,
        requestContext(request),
      );
    }
  }
}
