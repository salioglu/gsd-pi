// Project/App: gsd-pi
// File Purpose: Immutable v1 contract for a verified legacy-import database backup.

import { lstatSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION,
  LEGACY_IMPORT_PREVIEW_SCHEMA_VERSION,
  type LegacyImportSha256,
  type LegacyImportValue,
} from "./legacy-import-contract.js";
import type { DbAdapter } from "./db-adapter.js";
import { getDbOrNull, getDbPath } from "./db/engine.js";
import {
  captureCurrentLegacyImportBaseSnapshot,
  LegacyImportBaseSnapshotError,
  type LegacyImportBaseSnapshot,
} from "./legacy-import-preview-base.js";
import {
  hashLegacyImportValue,
  isValidLegacyImportPreviewArtifact,
  revalidateLegacyImportPreview,
  sealLegacyImportPreview,
  type LegacyImportPreviewArtifact,
  type LegacyImportPreviewCreateInput,
} from "./legacy-import-preview.js";
import {
  validateLegacyImportSourceRoots,
  type LegacyImportSourceRoot,
} from "./legacy-import-preview-source.js";

const VERIFIED_BACKUP_SCHEMA_VERSION = 1 as const;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const BACKUP_LABEL_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const CHECKPOINT_ATTEMPT_LIMIT = 3;
const BACKUP_PREFLIGHT_INPUT_KEYS = [
  "preview",
  "base",
  "roots",
  "destination_directory",
  "label",
] as const;

const VERIFIED_BACKUP_KEYS = [
  "verified_backup_schema_version",
  "backup_id",
  "preview_id",
  "preview_hash",
  "preview_schema_version",
  "import_kind",
  "importer_version",
  "source_set_hash",
  "source_count",
  "source_fingerprints",
  "project_id",
  "project_root_realpath",
  "backup_database_schema_version",
  "base_project_revision",
  "base_authority_epoch",
  "relevant_rows_hash",
  "backup_ref",
  "backup_sha256",
  "backup_byte_size",
  "quick_check",
  "integrity_check",
  "foreign_key_violations",
  "verified_at",
] as const;

const SOURCE_FINGERPRINT_KEYS = ["source_id", "path", "kind", "byte_size", "sha256"] as const;

export interface LegacyImportBackupSourceFingerprint {
  source_id: string;
  path: string;
  kind: string;
  byte_size: number;
  sha256: LegacyImportSha256;
}

export interface LegacyImportVerifiedBackup {
  verified_backup_schema_version: typeof VERIFIED_BACKUP_SCHEMA_VERSION;
  backup_id: LegacyImportSha256;
  preview_id: string;
  preview_hash: LegacyImportSha256;
  preview_schema_version: typeof LEGACY_IMPORT_PREVIEW_SCHEMA_VERSION;
  import_kind: string;
  importer_version: string;
  source_set_hash: LegacyImportSha256;
  source_count: number;
  source_fingerprints: LegacyImportBackupSourceFingerprint[];
  project_id: string;
  project_root_realpath: string;
  backup_database_schema_version: typeof LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION;
  base_project_revision: number;
  base_authority_epoch: number;
  relevant_rows_hash: LegacyImportSha256;
  backup_ref: string;
  backup_sha256: LegacyImportSha256;
  backup_byte_size: number;
  quick_check: "ok";
  integrity_check: "ok";
  foreign_key_violations: 0;
  verified_at: string;
}

export interface LegacyImportVerifiedBackupSealInput {
  preview: LegacyImportPreviewArtifact;
  base: LegacyImportBaseSnapshot;
  backup_ref: string;
  backup_sha256: LegacyImportSha256;
  backup_byte_size: number;
  quick_check: "ok";
  integrity_check: "ok";
  foreign_key_violations: 0;
  verified_at: string;
}

export interface LegacyImportVerifiedBackupExpected {
  preview: LegacyImportPreviewArtifact;
  base: LegacyImportBaseSnapshot;
}

export type LegacyImportBackupErrorCode =
  | "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID"
  | "LEGACY_IMPORT_BACKUP_IDENTITY_MISMATCH"
  | "LEGACY_IMPORT_BACKUP_DESTINATION_INVALID"
  | "LEGACY_IMPORT_BACKUP_DESTINATION_EXISTS"
  | "LEGACY_IMPORT_BACKUP_DESTINATION_ALIASES_DATABASE"
  | "LEGACY_IMPORT_BACKUP_SOURCE_OVERLAP"
  | "LEGACY_IMPORT_BACKUP_DATABASE_UNAVAILABLE"
  | "LEGACY_IMPORT_BACKUP_DATABASE_INVALID"
  | "LEGACY_IMPORT_BACKUP_DATABASE_IDENTITY_CHANGED"
  | "LEGACY_IMPORT_BACKUP_CHECKPOINT_BUSY"
  | "LEGACY_IMPORT_BACKUP_CHECKPOINT_INVALID"
  | "LEGACY_IMPORT_BACKUP_DATA_VERSION_INVALID"
  | "LEGACY_IMPORT_BACKUP_BASE_CAPTURE_FAILED"
  | "LEGACY_IMPORT_BACKUP_BASE_CHANGED";

export type LegacyImportBackupErrorStage =
  | "contract"
  | "destination"
  | "database"
  | "checkpoint"
  | "base";

export class LegacyImportBackupError extends Error {
  readonly stage: LegacyImportBackupErrorStage;
  readonly code: LegacyImportBackupErrorCode;
  readonly retryable: boolean;
  readonly context: Readonly<Record<string, LegacyImportValue>>;

  constructor(
    code: LegacyImportBackupErrorCode,
    message: string,
    context: Readonly<Record<string, LegacyImportValue>> = {},
    stage: LegacyImportBackupErrorStage = "contract",
    retryable = false,
  ) {
    super(message);
    this.name = "LegacyImportBackupError";
    this.stage = stage;
    this.code = code;
    this.retryable = retryable;
    this.context = Object.freeze({ ...context });
  }
}

function fail(
  code: LegacyImportBackupErrorCode,
  message: string,
  context: Readonly<Record<string, LegacyImportValue>> = {},
): never {
  throw new LegacyImportBackupError(code, message, context);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  const observed = Object.keys(value);
  return Object.getOwnPropertySymbols(value).length === 0
    && observed.length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function hasExactDataProperties(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  try {
    if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length > 0) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const observed = Object.keys(descriptors);
    return observed.length === keys.length
      && keys.every((key) => (
        Object.hasOwn(descriptors, key)
        && Object.hasOwn(descriptors[key]!, "value")
      ));
  } catch {
    return false;
  }
}

function isCanonicalHash(value: unknown): value is LegacyImportSha256 {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim();
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isDenseArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
    && Object.keys(value).length === value.length
    && Object.getOwnPropertySymbols(value).length === 0;
}

function validSourceFingerprint(value: unknown): value is LegacyImportBackupSourceFingerprint {
  return hasExactKeys(value, SOURCE_FINGERPRINT_KEYS)
    && isCanonicalHash(value["source_id"])
    && isNonBlank(value["path"])
    && isNonBlank(value["kind"])
    && isNonNegativeSafeInteger(value["byte_size"])
    && isCanonicalHash(value["sha256"]);
}

function isStructurallyValidBackup(value: unknown): value is LegacyImportVerifiedBackup {
  if (!hasExactKeys(value, VERIFIED_BACKUP_KEYS)) return false;
  const sources = value["source_fingerprints"];
  return value["verified_backup_schema_version"] === VERIFIED_BACKUP_SCHEMA_VERSION
    && isCanonicalHash(value["backup_id"])
    && isCanonicalHash(value["preview_id"])
    && isCanonicalHash(value["preview_hash"])
    && value["preview_schema_version"] === LEGACY_IMPORT_PREVIEW_SCHEMA_VERSION
    && isNonBlank(value["import_kind"])
    && isNonBlank(value["importer_version"])
    && isCanonicalHash(value["source_set_hash"])
    && isNonNegativeSafeInteger(value["source_count"])
    && isDenseArray(sources)
    && sources.every(validSourceFingerprint)
    && value["source_count"] === sources.length
    && isNonBlank(value["project_id"])
    && typeof value["project_root_realpath"] === "string"
    && value["project_root_realpath"] === value["project_root_realpath"].trim()
    && value["backup_database_schema_version"] === LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION
    && isNonNegativeSafeInteger(value["base_project_revision"])
    && isNonNegativeSafeInteger(value["base_authority_epoch"])
    && isCanonicalHash(value["relevant_rows_hash"])
    && isNonBlank(value["backup_ref"])
    && isCanonicalHash(value["backup_sha256"])
    && isNonNegativeSafeInteger(value["backup_byte_size"])
    && value["backup_byte_size"] > 0
    && value["quick_check"] === "ok"
    && value["integrity_check"] === "ok"
    && value["foreign_key_violations"] === 0
    && isCanonicalTimestamp(value["verified_at"]);
}

function hasValidBackupStructure(value: unknown): value is LegacyImportVerifiedBackup {
  try {
    return isStructurallyValidBackup(value);
  } catch {
    return false;
  }
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function validatePreviewAndBase(
  preview: unknown,
  base: LegacyImportBaseSnapshot,
): asserts preview is LegacyImportPreviewArtifact {
  if (!isValidLegacyImportPreviewArtifact(preview)) {
    fail(
      "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID",
      "verified backup requires a valid legacy import Preview artifact",
    );
  }
  let resealed: LegacyImportPreviewArtifact;
  try {
    resealed = sealLegacyImportPreview({
      import_kind: preview.preview.import_kind,
      importer_version: preview.preview.importer_version,
      base,
      source_set_hash: preview.preview.source_set_hash,
      change_set_hash: preview.preview.change_set_hash,
      counts: preview.preview.counts,
      sources: preview.preview.sources,
      changes: preview.preview.changes,
      diagnoses: preview.preview.diagnoses,
      resolutions: preview.preview.resolutions,
    });
  } catch {
    fail(
      "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID",
      "verified backup requires a valid canonical base snapshot",
    );
  }
  if (resealed.preview_hash !== preview.preview_hash) {
    fail(
      "LEGACY_IMPORT_BACKUP_IDENTITY_MISMATCH",
      "legacy import Preview does not match the supplied canonical base",
    );
  }
}

function sourceFingerprints(preview: LegacyImportPreviewArtifact): LegacyImportBackupSourceFingerprint[] {
  return preview.preview.sources.map(({ source_id, path, kind, byte_size, sha256 }) => ({
    source_id,
    path,
    kind,
    byte_size,
    sha256,
  }));
}

function backupIdentity(value: Omit<LegacyImportVerifiedBackup, "backup_id">): LegacyImportSha256 {
  const {
    backup_ref: _backupRef,
    verified_at: _verifiedAt,
    ...identity
  } = value;
  return hashLegacyImportValue(identity);
}

function attachBackupIdentity(
  value: Omit<LegacyImportVerifiedBackup, "backup_id">,
): LegacyImportVerifiedBackup {
  const { verified_backup_schema_version, ...evidence } = value;
  return {
    verified_backup_schema_version,
    backup_id: backupIdentity(value),
    ...evidence,
  };
}

function unsealedBackup(input: LegacyImportVerifiedBackupSealInput): Omit<LegacyImportVerifiedBackup, "backup_id"> {
  const { preview, base } = input;
  return {
    verified_backup_schema_version: VERIFIED_BACKUP_SCHEMA_VERSION,
    preview_id: preview.preview.preview_id,
    preview_hash: preview.preview_hash,
    preview_schema_version: preview.preview.preview_schema_version,
    import_kind: preview.preview.import_kind,
    importer_version: preview.preview.importer_version,
    source_set_hash: preview.preview.source_set_hash,
    source_count: preview.preview.sources.length,
    source_fingerprints: sourceFingerprints(preview),
    project_id: base.authority.project_id,
    project_root_realpath: base.authority.project_root_realpath,
    backup_database_schema_version: base.database_schema_version,
    base_project_revision: base.authority.revision,
    base_authority_epoch: base.authority.authority_epoch,
    relevant_rows_hash: base.relevant_rows_hash,
    backup_ref: input.backup_ref,
    backup_sha256: input.backup_sha256,
    backup_byte_size: input.backup_byte_size,
    quick_check: input.quick_check,
    integrity_check: input.integrity_check,
    foreign_key_violations: input.foreign_key_violations,
    verified_at: input.verified_at,
  };
}

export function sealLegacyImportVerifiedBackup(
  input: LegacyImportVerifiedBackupSealInput,
): LegacyImportVerifiedBackup {
  let clonedInput: LegacyImportVerifiedBackupSealInput;
  try {
    clonedInput = structuredClone(input);
  } catch {
    fail(
      "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID",
      "verified backup seal input must be detached strict data",
    );
  }
  validatePreviewAndBase(clonedInput.preview, clonedInput.base);
  const unsealed = unsealedBackup(clonedInput);
  const candidate = attachBackupIdentity(unsealed);
  if (!hasValidBackupStructure(candidate)) {
    fail(
      "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID",
      "verified backup seal input does not satisfy the v1 contract",
    );
  }
  return deepFreeze(candidate);
}

export function validateLegacyImportVerifiedBackup(
  value: unknown,
  expected: LegacyImportVerifiedBackupExpected,
): LegacyImportVerifiedBackup {
  let expectedSnapshot: LegacyImportVerifiedBackupExpected;
  try {
    expectedSnapshot = structuredClone(expected);
  } catch {
    fail(
      "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID",
      "expected Preview and base must be detached strict data",
    );
  }
  validatePreviewAndBase(expectedSnapshot.preview, expectedSnapshot.base);
  if (!hasValidBackupStructure(value)) {
    fail(
      "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID",
      "verified backup does not satisfy the exact v1 contract",
    );
  }
  let candidate: LegacyImportVerifiedBackup;
  try {
    candidate = structuredClone(value);
  } catch {
    fail(
      "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID",
      "verified backup must be detached strict data",
    );
  }
  if (!hasValidBackupStructure(candidate)) {
    fail(
      "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID",
      "verified backup changed while being detached",
    );
  }
  const expectedWithoutId = unsealedBackup({
    preview: expectedSnapshot.preview,
    base: expectedSnapshot.base,
    backup_ref: candidate.backup_ref,
    backup_sha256: candidate.backup_sha256,
    backup_byte_size: candidate.backup_byte_size,
    quick_check: candidate.quick_check,
    integrity_check: candidate.integrity_check,
    foreign_key_violations: candidate.foreign_key_violations,
    verified_at: candidate.verified_at,
  });
  const expectedBackup = attachBackupIdentity(expectedWithoutId);
  if (hashLegacyImportValue(candidate) !== hashLegacyImportValue(expectedBackup)) {
    fail(
      "LEGACY_IMPORT_BACKUP_IDENTITY_MISMATCH",
      "verified backup identity does not match its approved Preview, base, or backup content",
    );
  }
  return deepFreeze(candidate);
}

export interface LegacyImportBackupPreflightInput {
  preview: LegacyImportPreviewArtifact;
  base: LegacyImportBaseSnapshot;
  roots: readonly LegacyImportSourceRoot[];
  destination_directory: string;
  label: string;
}

export interface LegacyImportBackupPreflightDependencies {
  db: DbAdapter | null;
  database_path: string | null;
  captureBase(): LegacyImportBaseSnapshot;
  revalidatePreview(
    input: LegacyImportPreviewCreateInput,
    expected: LegacyImportPreviewArtifact,
  ): LegacyImportPreviewArtifact;
}

export interface LegacyImportBackupFileIdentity {
  dev: string;
  ino: string;
}

export interface LegacyImportBackupCheckpoint {
  mode: "wal" | "rollback";
  busy: 0;
  log: number;
  checkpointed: number;
  attempts: number;
}

export interface LegacyImportBackupPreflight {
  database_path: string;
  database_identity: LegacyImportBackupFileIdentity;
  destination_directory: string;
  destination_directory_identity: LegacyImportBackupFileIdentity;
  destination_path: string;
  label: string;
  root_set_hash: LegacyImportSha256;
  checkpoint: LegacyImportBackupCheckpoint;
  data_version: number;
  current_base: LegacyImportBaseSnapshot;
}

function preflightFail(
  stage: Exclude<LegacyImportBackupErrorStage, "contract">,
  code: LegacyImportBackupErrorCode,
  message: string,
  retryable = false,
  context: Readonly<Record<string, LegacyImportValue>> = {},
): never {
  throw new LegacyImportBackupError(code, message, context, stage, retryable);
}

function systemErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function validBackupLabel(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 64
    && BACKUP_LABEL_PATTERN.test(value);
}

function rootCoversSource(root: LegacyImportSourceRoot, sourcePath: string): boolean {
  return sourcePath === root.logical_path || sourcePath.startsWith(`${root.logical_path}/`);
}

function requirePreflightRoots(
  value: unknown,
  preview: LegacyImportPreviewArtifact,
): readonly LegacyImportSourceRoot[] {
  let roots: LegacyImportSourceRoot[];
  try {
    roots = validateLegacyImportSourceRoots(value);
  } catch {
    fail(
      "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID",
      "verified backup preflight requires a nonempty exact canonical source-root set",
    );
  }
  if (preview.preview.sources.some((source) => (
    !roots.some((root) => rootCoversSource(root, source.path))
  ))) {
    fail(
      "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID",
      "verified backup source roots do not cover every approved Preview source",
    );
  }
  return roots;
}

function requireApprovedPreviewRoots(
  roots: readonly LegacyImportSourceRoot[],
  expected: LegacyImportPreviewArtifact,
  revalidatePreview: LegacyImportBackupPreflightDependencies["revalidatePreview"],
): void {
  try {
    const observed = revalidatePreview({ roots }, expected);
    if (hashLegacyImportValue(observed) !== hashLegacyImportValue(expected)) {
      throw new Error("Preview revalidation returned a different artifact");
    }
  } catch {
    fail(
      "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID",
      "verified backup source roots do not reproduce the approved Preview",
    );
  }
}

function canonicalPotentialPath(value: string): string {
  const suffix: string[] = [];
  let candidate = resolve(value);
  while (true) {
    try {
      return resolve(realpathSync(candidate), ...suffix);
    } catch (error) {
      if (systemErrorCode(error) !== "ENOENT") {
        preflightFail(
          "destination",
          "LEGACY_IMPORT_BACKUP_DESTINATION_INVALID",
          "legacy import source root could not be canonicalized",
        );
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        preflightFail(
          "destination",
          "LEGACY_IMPORT_BACKUP_DESTINATION_INVALID",
          "legacy import source root has no canonical existing ancestor",
        );
      }
      suffix.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

function pathContains(parent: string, child: string): boolean {
  const childFromParent = relative(parent, child);
  return childFromParent === ""
    || (childFromParent !== ".."
      && !childFromParent.startsWith(`..${sep}`)
      && !isAbsolute(childFromParent));
}

function requireNoSourceOverlap(
  destinationDirectory: string,
  roots: readonly LegacyImportSourceRoot[],
): void {
  for (const root of roots) {
    const canonicalRoot = canonicalPotentialPath(root.physical_path);
    if (
      pathContains(canonicalRoot, destinationDirectory)
      || pathContains(destinationDirectory, canonicalRoot)
    ) {
      preflightFail(
        "destination",
        "LEGACY_IMPORT_BACKUP_SOURCE_OVERLAP",
        "legacy import backup destination must not overlap a declared Preview source root",
      );
    }
  }
}

interface LegacyImportBackupDestinationPin {
  directory: string;
  identity: LegacyImportBackupFileIdentity;
  path: string;
  label: string;
}

function requireSafeDestination(
  destinationDirectory: unknown,
  label: unknown,
  roots: readonly LegacyImportSourceRoot[],
): LegacyImportBackupDestinationPin {
  if (!validBackupLabel(label)) {
    preflightFail(
      "destination",
      "LEGACY_IMPORT_BACKUP_DESTINATION_INVALID",
      "legacy import backup label must be a lowercase ASCII slug of at most 64 characters",
    );
  }
  if (typeof destinationDirectory !== "string" || !isAbsolute(destinationDirectory)) {
    preflightFail(
      "destination",
      "LEGACY_IMPORT_BACKUP_DESTINATION_INVALID",
      "legacy import backup destination must be an existing absolute directory",
    );
  }
  let canonicalDirectory: string;
  let directoryIdentity: LegacyImportBackupFileIdentity;
  try {
    canonicalDirectory = realpathSync(destinationDirectory);
    const directoryStat = statSync(canonicalDirectory, { bigint: true });
    if (!directoryStat.isDirectory()) throw new Error("not a directory");
    directoryIdentity = fileIdentity(directoryStat);
  } catch {
    preflightFail(
      "destination",
      "LEGACY_IMPORT_BACKUP_DESTINATION_INVALID",
      "legacy import backup destination must be an existing directory",
    );
  }
  requireNoSourceOverlap(canonicalDirectory, roots);
  return {
    directory: canonicalDirectory,
    identity: directoryIdentity,
    path: join(canonicalDirectory, `${label}.sqlite`),
    label,
  };
}

function fileIdentity(stat: BigIntStats): LegacyImportBackupFileIdentity {
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}

function sameIdentity(left: LegacyImportBackupFileIdentity, right: LegacyImportBackupFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function pinDatabasePath(databasePath: string | null): {
  path: string;
  identity: LegacyImportBackupFileIdentity;
} {
  if (
    typeof databasePath !== "string"
    || databasePath.length === 0
    || databasePath === ":memory:"
    || !isAbsolute(databasePath)
  ) {
    preflightFail(
      "database",
      "LEGACY_IMPORT_BACKUP_DATABASE_UNAVAILABLE",
      "verified backup requires an open file-backed database",
    );
  }
  try {
    const leaf = lstatSync(databasePath, { bigint: true });
    if (!leaf.isFile() && !leaf.isSymbolicLink()) throw new Error("database is not a file or link");
    const canonicalPath = realpathSync(databasePath);
    const canonicalStat = statSync(canonicalPath, { bigint: true });
    if (!canonicalStat.isFile()) throw new Error("database is not a regular file");
    return { path: canonicalPath, identity: fileIdentity(canonicalStat) };
  } catch {
    preflightFail(
      "database",
      "LEGACY_IMPORT_BACKUP_DATABASE_INVALID",
      "verified backup database path must resolve to a live regular file",
    );
  }
}

function detachExactRow(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (!hasExactDataProperties(value, keys)) return null;
  try {
    const snapshot = structuredClone(value);
    return hasExactDataProperties(snapshot, keys) ? snapshot : null;
  } catch {
    return null;
  }
}

function readExactPragmaRow(
  db: DbAdapter,
  sql: string,
  keys: readonly string[],
  stage: "database" | "checkpoint",
  code: LegacyImportBackupErrorCode,
  message: string,
): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = db.prepare(sql).get();
  } catch {
    preflightFail(stage, code, message);
  }
  const row = detachExactRow(raw, keys);
  if (row === null) preflightFail(stage, code, message);
  return row;
}

function requireDatabaseListMatch(db: DbAdapter, pinnedPath: string): void {
  const row = readExactPragmaRow(
    db,
    "PRAGMA database_list",
    ["seq", "name", "file"],
    "database",
    "LEGACY_IMPORT_BACKUP_DATABASE_INVALID",
    "verified backup could not inspect one exact live database path",
  );
  if (
    row["seq"] !== 0
    || row["name"] !== "main"
    || !isNonBlank(row["file"])
  ) {
    preflightFail(
      "database",
      "LEGACY_IMPORT_BACKUP_DATABASE_INVALID",
      "live SQLite database_list did not return one canonical main database",
    );
  }
  try {
    if (realpathSync(row["file"]) !== pinnedPath) throw new Error("main database path mismatch");
  } catch {
    preflightFail(
      "database",
      "LEGACY_IMPORT_BACKUP_DATABASE_INVALID",
      "live SQLite main database does not match the pinned engine path",
    );
  }
}

function lstatExisting(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return null;
    preflightFail(
      "destination",
      "LEGACY_IMPORT_BACKUP_DESTINATION_INVALID",
      "legacy import backup destination leaf could not be inspected",
    );
  }
}

function requireAbsentDestination(
  destinationPath: string,
  databaseIdentity: LegacyImportBackupFileIdentity,
): void {
  const leaf = lstatExisting(destinationPath);
  if (leaf === null) return;
  let targetIdentity = fileIdentity(leaf);
  if (leaf.isSymbolicLink()) {
    try {
      targetIdentity = fileIdentity(statSync(destinationPath, { bigint: true }));
    } catch {
      // A dangling link still reserves the final path and fails as existing.
    }
  }
  if (sameIdentity(targetIdentity, databaseIdentity)) {
    preflightFail(
      "destination",
      "LEGACY_IMPORT_BACKUP_DESTINATION_ALIASES_DATABASE",
      "legacy import backup destination aliases the live database",
    );
  }
  preflightFail(
    "destination",
    "LEGACY_IMPORT_BACKUP_DESTINATION_EXISTS",
    "legacy import backup destination already exists",
  );
}

function readCheckpoint(db: DbAdapter): Record<string, unknown> {
  return readExactPragmaRow(
    db,
    "PRAGMA wal_checkpoint(TRUNCATE)",
    ["busy", "log", "checkpointed"],
    "checkpoint",
    "LEGACY_IMPORT_BACKUP_CHECKPOINT_INVALID",
    "SQLite returned an invalid WAL checkpoint result",
  );
}

function checkpointDatabase(db: DbAdapter): LegacyImportBackupCheckpoint {
  for (let attempts = 1; attempts <= CHECKPOINT_ATTEMPT_LIMIT; attempts += 1) {
    const row = readCheckpoint(db);
    const busy = row["busy"];
    const log = row["log"];
    const checkpointed = row["checkpointed"];
    if (
      (busy !== 0 && busy !== 1)
      || !isSafeInteger(log)
      || !isSafeInteger(checkpointed)
    ) {
      preflightFail(
        "checkpoint",
        "LEGACY_IMPORT_BACKUP_CHECKPOINT_INVALID",
        "SQLite returned a malformed WAL checkpoint tuple",
      );
    }
    if (busy === 1) {
      if (log < 0 || checkpointed < 0 || checkpointed > log) {
        preflightFail(
          "checkpoint",
          "LEGACY_IMPORT_BACKUP_CHECKPOINT_INVALID",
          "SQLite returned an impossible busy WAL checkpoint tuple",
        );
      }
      if (attempts === CHECKPOINT_ATTEMPT_LIMIT) {
        preflightFail(
          "checkpoint",
          "LEGACY_IMPORT_BACKUP_CHECKPOINT_BUSY",
          "SQLite WAL checkpoint remained busy after three attempts",
          true,
          { attempts, busy, log, checkpointed },
        );
      }
      continue;
    }
    if (log === -1 && checkpointed === -1) {
      return { mode: "rollback", busy: 0, log, checkpointed, attempts };
    }
    if (log >= 0 && checkpointed === log) {
      return { mode: "wal", busy: 0, log, checkpointed, attempts };
    }
    preflightFail(
      "checkpoint",
      "LEGACY_IMPORT_BACKUP_CHECKPOINT_INVALID",
      "SQLite WAL checkpoint did not checkpoint every logged frame",
    );
  }
  preflightFail(
    "checkpoint",
    "LEGACY_IMPORT_BACKUP_CHECKPOINT_BUSY",
    "SQLite WAL checkpoint did not complete",
    true,
  );
}

function readDataVersion(db: DbAdapter): number {
  const row = readExactPragmaRow(
    db,
    "PRAGMA data_version",
    ["data_version"],
    "checkpoint",
    "LEGACY_IMPORT_BACKUP_DATA_VERSION_INVALID",
    "SQLite data_version could not be read exactly",
  );
  if (!isNonNegativeSafeInteger(row["data_version"])) {
    preflightFail(
      "checkpoint",
      "LEGACY_IMPORT_BACKUP_DATA_VERSION_INVALID",
      "SQLite returned an invalid data_version",
    );
  }
  return row["data_version"];
}

function captureMatchingBase(
  captureBase: () => LegacyImportBaseSnapshot,
  preview: LegacyImportPreviewArtifact,
  expectedBase: LegacyImportBaseSnapshot,
): LegacyImportBaseSnapshot {
  let currentBase: LegacyImportBaseSnapshot;
  try {
    currentBase = structuredClone(captureBase());
  } catch (error) {
    preflightFail(
      "base",
      "LEGACY_IMPORT_BACKUP_BASE_CAPTURE_FAILED",
      "canonical database base could not be captured exactly",
      false,
      error instanceof LegacyImportBaseSnapshotError
        ? { capture_error_code: error.code }
        : {},
    );
  }
  try {
    if (hashLegacyImportValue(currentBase) !== hashLegacyImportValue(expectedBase)) {
      throw new Error("base changed");
    }
    validatePreviewAndBase(preview, currentBase);
  } catch {
    preflightFail(
      "base",
      "LEGACY_IMPORT_BACKUP_BASE_CHANGED",
      "canonical database base changed after Preview approval",
      true,
    );
  }
  return currentBase;
}

function requireSameDatabasePin(
  databasePath: string,
  expected: { path: string; identity: LegacyImportBackupFileIdentity },
): void {
  let observed: { path: string; identity: LegacyImportBackupFileIdentity };
  try {
    observed = pinDatabasePath(databasePath);
  } catch {
    preflightFail(
      "database",
      "LEGACY_IMPORT_BACKUP_DATABASE_IDENTITY_CHANGED",
      "live database path changed during backup preflight",
      true,
    );
  }
  if (observed.path !== expected.path || !sameIdentity(observed.identity, expected.identity)) {
    preflightFail(
      "database",
      "LEGACY_IMPORT_BACKUP_DATABASE_IDENTITY_CHANGED",
      "live database identity changed during backup preflight",
      true,
    );
  }
}

function requireSameDestinationPin(
  inputDirectory: string,
  expected: LegacyImportBackupDestinationPin,
  roots: readonly LegacyImportSourceRoot[],
  databaseIdentity: LegacyImportBackupFileIdentity,
): void {
  let observedDirectory: string;
  let observedIdentity: LegacyImportBackupFileIdentity;
  try {
    observedDirectory = realpathSync(inputDirectory);
    const observedStat = statSync(observedDirectory, { bigint: true });
    if (!observedStat.isDirectory()) throw new Error("destination is not a directory");
    observedIdentity = fileIdentity(observedStat);
  } catch {
    preflightFail(
      "destination",
      "LEGACY_IMPORT_BACKUP_DESTINATION_INVALID",
      "legacy import backup destination changed during preflight",
      true,
    );
  }
  if (
    observedDirectory !== expected.directory
    || !sameIdentity(observedIdentity, expected.identity)
  ) {
    preflightFail(
      "destination",
      "LEGACY_IMPORT_BACKUP_DESTINATION_INVALID",
      "legacy import backup destination identity changed during preflight",
      true,
    );
  }
  requireNoSourceOverlap(observedDirectory, roots);
  requireAbsentDestination(expected.path, databaseIdentity);
}

export function _prepareLegacyImportBackupPreflightForTest(
  input: LegacyImportBackupPreflightInput,
  dependencies: LegacyImportBackupPreflightDependencies,
): LegacyImportBackupPreflight {
  if (!hasExactDataProperties(input, BACKUP_PREFLIGHT_INPUT_KEYS)) {
    fail(
      "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID",
      "verified backup preflight requires one exact plain input object",
    );
  }
  let snapshot: LegacyImportBackupPreflightInput;
  try {
    snapshot = structuredClone(input);
  } catch {
    fail(
      "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID",
      "verified backup preflight input must be detached strict data",
    );
  }
  if (!hasExactDataProperties(snapshot, BACKUP_PREFLIGHT_INPUT_KEYS)) {
    fail(
      "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID",
      "verified backup preflight input changed while being detached",
    );
  }
  validatePreviewAndBase(snapshot.preview, snapshot.base);
  const roots = requirePreflightRoots(snapshot.roots, snapshot.preview);
  const rootSetHash = hashLegacyImportValue(roots);
  requireApprovedPreviewRoots(roots, snapshot.preview, dependencies.revalidatePreview);
  const destination = requireSafeDestination(
    snapshot.destination_directory,
    snapshot.label,
    roots,
  );
  const { db, database_path: databasePath, captureBase } = dependencies;
  if (db === null || typeof captureBase !== "function") {
    preflightFail(
      "database",
      "LEGACY_IMPORT_BACKUP_DATABASE_UNAVAILABLE",
      "verified backup requires the active database and base capture boundary",
    );
  }
  const database = pinDatabasePath(databasePath);
  requireDatabaseListMatch(db, database.path);
  requireAbsentDestination(destination.path, database.identity);
  const checkpoint = checkpointDatabase(db);
  const dataVersion = readDataVersion(db);
  const currentBase = captureMatchingBase(captureBase, snapshot.preview, snapshot.base);
  requireSameDatabasePin(databasePath as string, database);
  requireSameDestinationPin(
    snapshot.destination_directory,
    destination,
    roots,
    database.identity,
  );
  return deepFreeze({
    database_path: database.path,
    database_identity: database.identity,
    destination_directory: destination.directory,
    destination_directory_identity: destination.identity,
    destination_path: destination.path,
    label: destination.label,
    root_set_hash: rootSetHash,
    checkpoint,
    data_version: dataVersion,
    current_base: currentBase,
  });
}

export function prepareLegacyImportBackupPreflight(
  input: LegacyImportBackupPreflightInput,
): LegacyImportBackupPreflight {
  return _prepareLegacyImportBackupPreflightForTest(input, {
    db: getDbOrNull(),
    database_path: getDbPath(),
    captureBase: captureCurrentLegacyImportBaseSnapshot,
    revalidatePreview: revalidateLegacyImportPreview,
  });
}
