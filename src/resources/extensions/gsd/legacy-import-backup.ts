// Project/App: gsd-pi
// File Purpose: Immutable v1 contract for a verified legacy-import database backup.

import {
  LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION,
  LEGACY_IMPORT_PREVIEW_SCHEMA_VERSION,
  type LegacyImportSha256,
  type LegacyImportValue,
} from "./legacy-import-contract.js";
import type { LegacyImportBaseSnapshot } from "./legacy-import-preview-base.js";
import {
  hashLegacyImportValue,
  isValidLegacyImportPreviewArtifact,
  sealLegacyImportPreview,
  type LegacyImportPreviewArtifact,
} from "./legacy-import-preview.js";

const VERIFIED_BACKUP_SCHEMA_VERSION = 1 as const;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

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
  | "LEGACY_IMPORT_BACKUP_IDENTITY_MISMATCH";

export class LegacyImportBackupError extends Error {
  readonly stage = "contract";
  readonly code: LegacyImportBackupErrorCode;
  readonly retryable = false;
  readonly context: Readonly<Record<string, LegacyImportValue>>;

  constructor(
    code: LegacyImportBackupErrorCode,
    message: string,
    context: Readonly<Record<string, LegacyImportValue>> = {},
  ) {
    super(message);
    this.name = "LegacyImportBackupError";
    this.code = code;
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

function isCanonicalHash(value: unknown): value is LegacyImportSha256 {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim();
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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
