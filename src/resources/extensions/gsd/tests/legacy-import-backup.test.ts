// Project/App: gsd-pi
// File Purpose: Verified legacy-import backup v1 contract and fail-closed validation tests.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { LegacyImportPreviewSource, LegacyImportSha256 } from "../legacy-import-contract.ts";
import type { LegacyImportBaseSnapshot } from "../legacy-import-preview-base.ts";
import {
  hashLegacyImportValue,
  sealLegacyImportPreview,
  type LegacyImportPreviewArtifact,
} from "../legacy-import-preview.ts";
import {
  LegacyImportBackupError,
  sealLegacyImportVerifiedBackup,
  validateLegacyImportVerifiedBackup,
  type LegacyImportVerifiedBackup,
  type LegacyImportVerifiedBackupExpected,
  type LegacyImportVerifiedBackupSealInput,
} from "../legacy-import-backup.ts";

const EMPTY_HASH = hashLegacyImportValue([]);
const BACKUP_HASH = `sha256:${"b".repeat(64)}` as LegacyImportSha256;
const TOP_LEVEL_KEYS = [
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

function source(sourceId: string, path: string, shaDigit: string): LegacyImportPreviewSource {
  return {
    source_id: hashLegacyImportValue(sourceId),
    path,
    kind: "markdown",
    byte_size: 4,
    sha256: `sha256:${shaDigit.repeat(64)}`,
    parser_id: "planning",
    parser_version: "1",
    encoding: "utf-8",
    outcome: "preserved",
  };
}

function baseSnapshot(): LegacyImportBaseSnapshot {
  return {
    snapshot_schema_version: 1,
    database_schema_version: 44,
    authority: {
      singleton: 1,
      project_id: "project-1",
      project_root_realpath: "/workspace/project-1",
      revision: 7,
      authority_epoch: 2,
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-15T00:00:00.000Z",
    },
    rows: [],
    relevant_rows_hash: EMPTY_HASH,
  };
}

function previewArtifact(
  base = baseSnapshot(),
  sources: readonly LegacyImportPreviewSource[] = [
    source("source-a", ".gsd/PROJECT.md", "1"),
    source("source-b", ".gsd/STATE.md", "2"),
  ],
): LegacyImportPreviewArtifact {
  return sealLegacyImportPreview({
    import_kind: "legacy-markdown",
    importer_version: "1",
    base,
    source_set_hash: hashLegacyImportValue(sources),
    change_set_hash: EMPTY_HASH,
    counts: { create: 0, update: 0, delete: 0, preserve: 0, unparsed: 0, unresolved: 0 },
    sources,
    changes: [],
    diagnoses: [],
    resolutions: [],
  });
}

function sealInput(): LegacyImportVerifiedBackupSealInput {
  const base = baseSnapshot();
  return {
    preview: previewArtifact(base),
    base,
    backup_ref: "/backups/project-1/legacy-import-backup.sqlite",
    backup_sha256: BACKUP_HASH,
    backup_byte_size: 4096,
    quick_check: "ok",
    integrity_check: "ok",
    foreign_key_violations: 0,
    verified_at: "2026-07-16T12:34:56.789Z",
  };
}

function sealedFixture(): {
  backup: LegacyImportVerifiedBackup;
  base: LegacyImportBaseSnapshot;
  preview: LegacyImportPreviewArtifact;
} {
  const input = sealInput();
  return {
    backup: sealLegacyImportVerifiedBackup(input),
    base: input.base,
    preview: input.preview,
  };
}

function recomputeBackupId(value: LegacyImportVerifiedBackup): LegacyImportSha256 {
  const {
    backup_id: _backupId,
    backup_ref: _backupRef,
    verified_at: _verifiedAt,
    ...identity
  } = value;
  return hashLegacyImportValue(identity);
}

function expectInvalid(
  value: unknown,
  preview: LegacyImportPreviewArtifact,
  base: LegacyImportBaseSnapshot,
  code: "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID" | "LEGACY_IMPORT_BACKUP_IDENTITY_MISMATCH",
): void {
  assert.throws(
    () => validateLegacyImportVerifiedBackup(value, { preview, base }),
    (error: unknown) => error instanceof LegacyImportBackupError
      && error.stage === "contract"
      && error.code === code
      && !error.retryable
      && Object.isFrozen(error.context),
  );
}

describe("legacy import backup contract", () => {
  test("seals the exact v1 fields and every required Preview/base/integrity binding", () => {
    const { backup, base, preview } = sealedFixture();

    assert.deepEqual(Object.keys(backup), TOP_LEVEL_KEYS);
    assert.deepEqual(Object.keys(backup.source_fingerprints[0] ?? {}), SOURCE_FINGERPRINT_KEYS);
    assert.equal(backup.verified_backup_schema_version, 1);
    assert.equal(backup.preview_id, preview.preview.preview_id);
    assert.equal(backup.preview_hash, preview.preview_hash);
    assert.equal(backup.preview_schema_version, preview.preview.preview_schema_version);
    assert.equal(backup.import_kind, preview.preview.import_kind);
    assert.equal(backup.importer_version, preview.preview.importer_version);
    assert.equal(backup.source_set_hash, preview.preview.source_set_hash);
    assert.equal(backup.source_count, preview.preview.sources.length);
    assert.deepEqual(
      backup.source_fingerprints,
      preview.preview.sources.map(({ source_id, path, kind, byte_size, sha256 }) => ({
        source_id,
        path,
        kind,
        byte_size,
        sha256,
      })),
    );
    assert.equal(backup.project_id, base.authority.project_id);
    assert.equal(backup.project_root_realpath, base.authority.project_root_realpath);
    assert.equal(backup.backup_database_schema_version, base.database_schema_version);
    assert.equal(backup.base_project_revision, base.authority.revision);
    assert.equal(backup.base_authority_epoch, base.authority.authority_epoch);
    assert.equal(backup.relevant_rows_hash, base.relevant_rows_hash);
    assert.equal(backup.backup_ref, "/backups/project-1/legacy-import-backup.sqlite");
    assert.equal(backup.backup_sha256, BACKUP_HASH);
    assert.equal(backup.backup_byte_size, 4096);
    assert.equal(backup.quick_check, "ok");
    assert.equal(backup.integrity_check, "ok");
    assert.equal(backup.foreign_key_violations, 0);
    assert.equal(backup.verified_at, "2026-07-16T12:34:56.789Z");
    assert.match(backup.backup_id, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(backup.backup_id, recomputeBackupId(backup));
    assert.deepEqual(validateLegacyImportVerifiedBackup(backup, { preview, base }), backup);
  });

  test("derives stable content and approval-lineage identity without time or backup location", () => {
    const input = sealInput();
    const original = sealLegacyImportVerifiedBackup(input);
    const later = sealLegacyImportVerifiedBackup({
      ...input,
      backup_ref: "/backups/project-1/moved-after-restart.sqlite",
      verified_at: "2026-07-17T00:00:00.000Z",
    });
    assert.equal(later.backup_id, original.backup_id);

    const changedBytes = sealLegacyImportVerifiedBackup({
      ...input,
      backup_sha256: `sha256:${"c".repeat(64)}`,
    });
    const changedSize = sealLegacyImportVerifiedBackup({ ...input, backup_byte_size: 8192 });
    const changedBase = {
      ...input.base,
      authority: { ...input.base.authority, project_id: "project-2" },
    };
    const changedProject = sealLegacyImportVerifiedBackup({
      ...input,
      base: changedBase,
      preview: previewArtifact(changedBase),
    });
    const changedSources = [
      source("source-a", ".gsd/PROJECT.md", "1"),
      source("source-b", ".gsd/STATE.md", "9"),
    ];
    const changedSourceSet = sealLegacyImportVerifiedBackup({
      ...input,
      preview: previewArtifact(input.base, changedSources),
    });

    assert.notEqual(changedBytes.backup_id, original.backup_id);
    assert.notEqual(changedSize.backup_id, original.backup_id);
    assert.notEqual(changedProject.backup_id, original.backup_id);
    assert.notEqual(changedSourceSet.backup_id, original.backup_id);
  });

  test("returns a detached, recursively frozen artifact and leaves caller input mutable", () => {
    const input = sealInput();
    const backup = sealLegacyImportVerifiedBackup(input);

    assert.equal(Object.isFrozen(backup), true);
    assert.equal(Object.isFrozen(backup.source_fingerprints), true);
    assert.equal(Object.isFrozen(backup.source_fingerprints[0]), true);
    input.backup_ref = "changed-after-seal.sqlite";
    input.preview = previewArtifact(input.base);
    assert.equal(backup.backup_ref, "/backups/project-1/legacy-import-backup.sqlite");

    const serialized = structuredClone(backup);
    const validated = validateLegacyImportVerifiedBackup(serialized, {
      preview: previewArtifact(input.base),
      base: input.base,
    });
    assert.notEqual(validated, serialized);
    assert.equal(Object.isFrozen(validated), true);
    assert.equal(Object.isFrozen(validated.source_fingerprints), true);
    serialized.backup_ref = "mutated-after-validation.sqlite";
    assert.equal(validated.backup_ref, backup.backup_ref);
  });

  test("snapshots expected Preview lineage once before validation", () => {
    const { backup, base, preview } = sealedFixture();
    const forged = structuredClone(preview);
    Object.assign(forged, { unexpected: true });
    let previewReads = 0;
    const expected = {
      base,
      get preview() {
        return ++previewReads === 1 ? preview : forged;
      },
    } as LegacyImportVerifiedBackupExpected;

    assert.deepEqual(validateLegacyImportVerifiedBackup(backup, expected), backup);
    assert.equal(previewReads, 1);
  });
});

describe("legacy import backup failure", () => {
  test("rejects missing, extra, non-plain, sparse, and malformed nested contract values", () => {
    const { backup, base, preview } = sealedFixture();
    const missing = structuredClone(backup) as unknown as Record<string, unknown>;
    delete missing["backup_sha256"];
    const extra = { ...structuredClone(backup), unexpected: true };
    const extraSource = structuredClone(backup);
    Object.assign(extraSource.source_fingerprints[0]!, { unexpected: true });
    const symbolKey = structuredClone(backup);
    Object.assign(symbolKey, { [Symbol("unexpected")]: true });
    const changingRef = structuredClone(backup);
    let refReads = 0;
    Object.defineProperty(changingRef, "backup_ref", {
      enumerable: true,
      get: () => (++refReads === 1 ? backup.backup_ref : " "),
    });
    const sparseSources = structuredClone(backup);
    delete sparseSources.source_fingerprints[0];

    for (const malformed of [
      null,
      [],
      new Date(),
      missing,
      extra,
      extraSource,
      symbolKey,
      changingRef,
      sparseSources,
    ]) {
      expectInvalid(malformed, preview, base, "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID");
    }
  });

  test("rejects malformed hashes, counts, refs, integrity results, and non-canonical time", () => {
    const { backup, base, preview } = sealedFixture();
    const mutations: readonly ((value: LegacyImportVerifiedBackup) => void)[] = [
      (value) => { value.backup_id = "sha256:ABC" as LegacyImportSha256; },
      (value) => { value.preview_hash = "sha256:not-hex" as LegacyImportSha256; },
      (value) => { value.source_set_hash = `sha256:${"A".repeat(64)}` as LegacyImportSha256; },
      (value) => { value.relevant_rows_hash = "" as LegacyImportSha256; },
      (value) => { value.backup_sha256 = `sha256:${"1".repeat(63)}` as LegacyImportSha256; },
      (value) => { value.source_count += 1; },
      (value) => { value.backup_byte_size = 0; },
      (value) => { value.backup_ref = " "; },
      (value) => { (value as { quick_check: string }).quick_check = "OK"; },
      (value) => { (value as { integrity_check: string }).integrity_check = "database is corrupt"; },
      (value) => { (value as { foreign_key_violations: number }).foreign_key_violations = 1; },
      (value) => { value.verified_at = "2026-07-16 12:34:56"; },
      (value) => { value.verified_at = "2026-07-16T07:34:56.789-05:00"; },
      (value) => { value.verified_at = "2026-02-30T00:00:00.000Z"; },
    ];

    for (const mutate of mutations) {
      const malformed = structuredClone(backup);
      mutate(malformed);
      expectInvalid(malformed, preview, base, "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID");
    }
  });

  test("rejects reordered or forged source fingerprints even with a recomputed backup_id", () => {
    const { backup, base, preview } = sealedFixture();
    const reordered = structuredClone(backup);
    reordered.source_fingerprints.reverse();
    reordered.backup_id = recomputeBackupId(reordered);
    expectInvalid(reordered, preview, base, "LEGACY_IMPORT_BACKUP_IDENTITY_MISMATCH");

    const forged = structuredClone(backup);
    forged.source_fingerprints[0]!.sha256 = `sha256:${"9".repeat(64)}`;
    forged.backup_id = recomputeBackupId(forged);
    expectInvalid(forged, preview, base, "LEGACY_IMPORT_BACKUP_IDENTITY_MISMATCH");
  });

  test("rejects forged Preview and base lineage even after backup_id is recomputed", () => {
    const { backup, base, preview } = sealedFixture();
    const forgeries = [
      (value: LegacyImportVerifiedBackup) => { value.preview_id = `sha256:${"9".repeat(64)}`; },
      (value: LegacyImportVerifiedBackup) => { value.preview_hash = `sha256:${"8".repeat(64)}`; },
      (value: LegacyImportVerifiedBackup) => { value.base_project_revision += 1; },
      (value: LegacyImportVerifiedBackup) => { value.base_authority_epoch += 1; },
      (value: LegacyImportVerifiedBackup) => { value.project_id = "project-forged"; },
      (value: LegacyImportVerifiedBackup) => { value.relevant_rows_hash = `sha256:${"7".repeat(64)}`; },
    ];

    for (const forge of forgeries) {
      const forged = structuredClone(backup);
      forge(forged);
      forged.backup_id = recomputeBackupId(forged);
      expectInvalid(forged, preview, base, "LEGACY_IMPORT_BACKUP_IDENTITY_MISMATCH");
    }
  });

  test("rejects a forged backup_id while accepting a later canonical verified_at", () => {
    const { backup, base, preview } = sealedFixture();
    const forged = structuredClone(backup);
    forged.backup_id = `sha256:${"0".repeat(64)}`;
    expectInvalid(forged, preview, base, "LEGACY_IMPORT_BACKUP_IDENTITY_MISMATCH");

    const later = structuredClone(backup);
    later.verified_at = "2026-07-17T00:00:00.000Z";
    assert.equal(
      validateLegacyImportVerifiedBackup(later, { preview, base }).backup_id,
      backup.backup_id,
    );
  });
});
