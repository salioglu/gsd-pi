// Project/App: gsd-pi
// File Purpose: Verified legacy-import backup v1 contract and fail-closed validation tests.

import assert from "node:assert/strict";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test, type TestContext } from "node:test";

import type { LegacyImportPreviewSource, LegacyImportSha256 } from "../legacy-import-contract.ts";
import {
  LegacyImportBaseSnapshotError,
  type LegacyImportBaseSnapshot,
} from "../legacy-import-preview-base.ts";
import type { DbAdapter, DbStatement } from "../db-adapter.ts";
import {
  hashLegacyImportValue,
  sealLegacyImportPreview,
  type LegacyImportPreviewArtifact,
} from "../legacy-import-preview.ts";
import {
  _prepareLegacyImportBackupPreflightForTest,
  LegacyImportBackupError,
  prepareLegacyImportBackupPreflight,
  sealLegacyImportVerifiedBackup,
  validateLegacyImportVerifiedBackup,
  type LegacyImportVerifiedBackup,
  type LegacyImportVerifiedBackupExpected,
  type LegacyImportVerifiedBackupSealInput,
} from "../legacy-import-backup.ts";
import {
  validateLegacyImportSourceRoots,
  type LegacyImportSourceRoot,
} from "../legacy-import-preview-source.ts";

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

function baseSnapshot(projectRootRealpath = "/workspace/project-1"): LegacyImportBaseSnapshot {
  return {
    snapshot_schema_version: 1,
    database_schema_version: 44,
    authority: {
      singleton: 1,
      project_id: "project-1",
      project_root_realpath: projectRootRealpath,
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

interface FakeBackupDbOptions {
  checkpointResults?: readonly unknown[];
  dataVersion?: unknown;
  databaseListPath: string;
}

function fakeBackupDb(options: FakeBackupDbOptions): {
  db: DbAdapter;
  calls: { checkpoint: number; dataVersion: number; databaseList: number; exec: number };
} {
  const checkpointResults = [...(options.checkpointResults ?? [{ busy: 0, log: 4, checkpointed: 4 }])];
  const calls = { checkpoint: 0, dataVersion: 0, databaseList: 0, exec: 0 };

  function checkpointRows(): Record<string, unknown>[] {
    calls.checkpoint += 1;
    const result = checkpointResults.shift();
    if (result instanceof Error) throw result;
    if (Array.isArray(result)) return result as Record<string, unknown>[];
    return [result as Record<string, unknown>];
  }

  const db: DbAdapter = {
    exec() {
      calls.exec += 1;
      throw new Error("backup preflight must not execute write-capable SQL");
    },
    prepare(sql): DbStatement {
      const normalized = sql.toLowerCase();
      if (normalized.includes("wal_checkpoint")) {
        return {
          run: () => checkpointRows(),
          get: () => checkpointRows()[0],
          all: () => checkpointRows(),
        };
      }
      if (normalized.includes("database_list")) {
        return {
          run: () => undefined,
          get: () => {
            calls.databaseList += 1;
            return { seq: 0, name: "main", file: options.databaseListPath };
          },
          all: () => {
            calls.databaseList += 1;
            return [{ seq: 0, name: "main", file: options.databaseListPath }];
          },
        };
      }
      if (normalized.includes("data_version")) {
        return {
          run: () => undefined,
          get: () => {
            calls.dataVersion += 1;
            return options.dataVersion === undefined
              ? { data_version: 9 }
              : options.dataVersion as Record<string, unknown>;
          },
          all: () => {
            calls.dataVersion += 1;
            return [options.dataVersion === undefined
              ? { data_version: 9 }
              : options.dataVersion as Record<string, unknown>];
          },
        };
      }
      throw new Error(`unexpected preflight SQL: ${sql}`);
    },
    close() {},
  };
  return { db, calls };
}

function preflightFixture(
  t: TestContext,
  options: Partial<FakeBackupDbOptions> & {
    currentBase?: LegacyImportBaseSnapshot | ((base: LegacyImportBaseSnapshot) => LegacyImportBaseSnapshot);
  } = {},
) {
  const workspace = mkdtempSync(join(tmpdir(), "gsd-legacy-backup-preflight-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const projectRoot = join(workspace, "project");
  const databasePath = join(projectRoot, ".gsd", "gsd.db");
  const sourceRoot = join(projectRoot, ".planning");
  const destinationDirectory = join(projectRoot, ".gsd-backups");
  mkdirSync(dirname(databasePath), { recursive: true });
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(destinationDirectory, { recursive: true });
  writeFileSync(databasePath, "sqlite-placeholder");

  const canonicalProjectRoot = realpathSync(projectRoot);
  const base = baseSnapshot(canonicalProjectRoot);
  const roots: readonly LegacyImportSourceRoot[] = [{
    id: "planning-root",
    kind: "project",
    physical_path: sourceRoot,
    logical_path: ".gsd",
    presence: "required",
  }];
  const preview = previewArtifact(base);
  const approvedRootSetHash = hashLegacyImportValue(validateLegacyImportSourceRoots(roots));
  const fake = fakeBackupDb({
    checkpointResults: options.checkpointResults,
    dataVersion: options.dataVersion,
    databaseListPath: options.databaseListPath ?? databasePath,
  });
  let captureBaseCalls = 0;
  const currentBase = typeof options.currentBase === "function"
    ? options.currentBase(base)
    : options.currentBase ?? base;
  const input = {
    preview,
    base,
    roots,
    destination_directory: destinationDirectory,
    label: "before-legacy-import",
  };
  const dependencies = {
    db: fake.db,
    database_path: databasePath,
    revalidatePreview: (
      observedInput: { roots: readonly LegacyImportSourceRoot[] },
      expected: LegacyImportPreviewArtifact,
    ) => {
      const observedRootSetHash = hashLegacyImportValue(
        validateLegacyImportSourceRoots(observedInput.roots),
      );
      if (observedRootSetHash !== approvedRootSetHash) {
        throw new Error("source roots do not match the approved Preview roots");
      }
      return expected;
    },
    captureBase: () => {
      captureBaseCalls += 1;
      return structuredClone(currentBase);
    },
  };
  return {
    workspace,
    projectRoot,
    databasePath,
    sourceRoot,
    destinationDirectory,
    base,
    preview,
    input,
    dependencies,
    calls: fake.calls,
    captureBaseCalls: () => captureBaseCalls,
  };
}

function expectPreflightError(
  fn: () => unknown,
  expected: {
    stage: string;
    code: string;
    retryable: boolean;
    context?: Readonly<Record<string, unknown>>;
  },
): LegacyImportBackupError {
  let observed: LegacyImportBackupError | undefined;
  assert.throws(fn, (error: unknown) => {
    if (!(error instanceof LegacyImportBackupError)) return false;
    observed = error;
    assert.equal(error.stage, expected.stage);
    assert.equal(error.code, expected.code);
    assert.equal(error.retryable, expected.retryable);
    assert.equal(Object.isFrozen(error.context), true);
    if (expected.context !== undefined) assert.deepEqual(error.context, expected.context);
    return true;
  });
  assert.ok(observed);
  return observed;
}

describe("legacy import backup destination", () => {
  test("returns canonical database/destination identity and detached immutable preflight evidence", (t) => {
    const fixture = preflightFixture(t);
    assert.equal(typeof prepareLegacyImportBackupPreflight, "function");

    const result = _prepareLegacyImportBackupPreflightForTest(fixture.input, fixture.dependencies);
    const databaseStat = statSync(fixture.databasePath);
    const destinationStat = statSync(fixture.destinationDirectory);
    assert.equal(result.database_path, realpathSync(fixture.databasePath));
    assert.deepEqual(result.database_identity, {
      dev: String(databaseStat.dev),
      ino: String(databaseStat.ino),
    });
    assert.equal(result.destination_directory, realpathSync(fixture.destinationDirectory));
    assert.deepEqual(result.destination_directory_identity, {
      dev: String(destinationStat.dev),
      ino: String(destinationStat.ino),
    });
    assert.equal(
      result.destination_path,
      join(realpathSync(fixture.destinationDirectory), "before-legacy-import.sqlite"),
    );
    assert.equal(result.label, "before-legacy-import");
    assert.equal(result.root_set_hash, hashLegacyImportValue(fixture.input.roots));
    assert.deepEqual(result.checkpoint, {
      mode: "wal",
      busy: 0,
      log: 4,
      checkpointed: 4,
      attempts: 1,
    });
    assert.equal(result.data_version, 9);
    assert.deepEqual(result.current_base, fixture.base);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.database_identity), true);
    assert.equal(Object.isFrozen(result.destination_directory_identity), true);
    assert.equal(Object.isFrozen(result.checkpoint), true);
    assert.equal(Object.isFrozen(result.current_base), true);
    assert.equal(fixture.calls.exec, 0);
    fixture.input.label = "changed-after-preflight";
    assert.equal(result.label, "before-legacy-import");
  });

  test("rejects noncanonical, duplicate, empty, or Preview-incomplete root sets before checkpoint", (t) => {
    const fixture = preflightFixture(t);
    const root = fixture.input.roots[0]!;
    const invalidRootSets: readonly (readonly LegacyImportSourceRoot[])[] = [
      [],
      [{ ...root, id: "Not-Canonical" }],
      [{ ...root, physical_path: `${fixture.sourceRoot}/../.planning` }],
      [{ ...root, logical_path: ".gsd/../.gsd" }],
      [root, { ...root }],
      [root, { ...root, id: "other-root", logical_path: ".gsd/nested" }],
      [{ ...root, logical_path: ".planning" }],
    ];

    for (const roots of invalidRootSets) {
      expectPreflightError(
        () => _prepareLegacyImportBackupPreflightForTest({ ...fixture.input, roots }, fixture.dependencies),
        {
          stage: "contract",
          code: "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID",
          retryable: false,
        },
      );
    }
    assert.equal(fixture.calls.checkpoint, 0);
    assert.equal(fixture.captureBaseCalls(), 0);
  });

  test("rejects non-exact or accessor-backed top-level input before checkpoint", (t) => {
    const fixture = preflightFixture(t);
    const missing = { ...fixture.input } as Record<string, unknown>;
    delete missing["label"];
    const extra = { ...fixture.input, extra: true };
    const symbol = { ...fixture.input, [Symbol("extra")]: true };
    let labelReads = 0;
    const changing = { ...fixture.input } as Record<string, unknown>;
    Object.defineProperty(changing, "label", {
      enumerable: true,
      get: () => (++labelReads === 1 ? fixture.input.label : "changed-label"),
    });

    for (const input of [missing, extra, symbol, changing]) {
      expectPreflightError(
        () => _prepareLegacyImportBackupPreflightForTest(input as never, fixture.dependencies),
        {
          stage: "contract",
          code: "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID",
          retryable: false,
        },
      );
    }
    assert.equal(fixture.calls.checkpoint, 0);
    assert.equal(fixture.captureBaseCalls(), 0);
  });

  test("rejects unsafe labels before checkpoint or base capture", (t) => {
    const fixture = preflightFixture(t);
    const invalidLabels = [
      "",
      " ",
      ".",
      "..",
      ".hidden",
      "backup.v1",
      "backup/child",
      "backup\\child",
      "back up",
      "UPPERCASE",
      "bäckup",
      "a".repeat(65),
      "backup\0name",
    ];

    for (const label of invalidLabels) {
      expectPreflightError(
        () => _prepareLegacyImportBackupPreflightForTest(
          { ...fixture.input, label },
          fixture.dependencies,
        ),
        {
          stage: "destination",
          code: "LEGACY_IMPORT_BACKUP_DESTINATION_INVALID",
          retryable: false,
        },
      );
    }
    assert.equal(fixture.calls.checkpoint, 0);
    assert.equal(fixture.captureBaseCalls(), 0);
  });

  test("rejects an existing final file, directory, symlink, dangling symlink, or database hardlink", (t) => {
    const fixture = preflightFixture(t);
    const cases = ["file", "directory", "symlink", "dangling", "hardlink"] as const;

    for (const label of cases) {
      const finalPath = join(fixture.destinationDirectory, `${label}.sqlite`);
      if (label === "file") writeFileSync(finalPath, "existing");
      if (label === "directory") mkdirSync(finalPath);
      if (label === "symlink") symlinkSync(fixture.databasePath, finalPath, "file");
      if (label === "dangling") symlinkSync(join(fixture.workspace, "missing.db"), finalPath, "file");
      if (label === "hardlink") linkSync(fixture.databasePath, finalPath);

      assert.equal(lstatSync(finalPath).isFile(), label === "file" || label === "hardlink");
      const expectedCode = label === "symlink" || label === "hardlink"
        ? "LEGACY_IMPORT_BACKUP_DESTINATION_ALIASES_DATABASE"
        : "LEGACY_IMPORT_BACKUP_DESTINATION_EXISTS";
      expectPreflightError(
        () => _prepareLegacyImportBackupPreflightForTest(
          { ...fixture.input, label },
          fixture.dependencies,
        ),
        { stage: "destination", code: expectedCode, retryable: false },
      );
    }
  });

  test("rejects source overlap in either direction and through a symlinked parent", (t) => {
    const fixture = preflightFixture(t);
    const insideSource = join(fixture.sourceRoot, "backups");
    mkdirSync(insideSource);
    const containingSource = fixture.projectRoot;
    const sourceChild = join(fixture.sourceRoot, "through-link");
    mkdirSync(sourceChild);
    const linkedParent = join(fixture.workspace, "source-alias");
    symlinkSync(fixture.sourceRoot, linkedParent, process.platform === "win32" ? "junction" : "dir");

    for (const destination_directory of [insideSource, containingSource, join(linkedParent, "through-link")]) {
      expectPreflightError(
        () => _prepareLegacyImportBackupPreflightForTest(
          { ...fixture.input, destination_directory },
          fixture.dependencies,
        ),
        {
          stage: "destination",
          code: "LEGACY_IMPORT_BACKUP_SOURCE_OVERLAP",
          retryable: false,
        },
      );
    }
  });

  test("rejects an unrelated physical root even when its logical path could hide source overlap", (t) => {
    const fixture = preflightFixture(t);
    const approvedDestination = join(fixture.sourceRoot, "backups");
    const unrelatedRoot = join(fixture.workspace, "unrelated", ".planning");
    mkdirSync(approvedDestination);
    mkdirSync(unrelatedRoot, { recursive: true });

    const roots: readonly LegacyImportSourceRoot[] = [{
      ...fixture.input.roots[0]!,
      physical_path: unrelatedRoot,
    }];
    expectPreflightError(
      () => _prepareLegacyImportBackupPreflightForTest({
        ...fixture.input,
        roots,
        destination_directory: approvedDestination,
      }, fixture.dependencies),
      {
        stage: "contract",
        code: "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID",
        retryable: false,
      },
    );
    assert.equal(fixture.calls.checkpoint, 0);
    assert.equal(fixture.captureBaseCalls(), 0);
  });

  test("allows a prefix-only source sibling", (t) => {
    const fixture = preflightFixture(t);
    const prefixSibling = `${fixture.sourceRoot}-backups`;
    mkdirSync(prefixSibling);
    const result = _prepareLegacyImportBackupPreflightForTest(
      { ...fixture.input, destination_directory: prefixSibling },
      fixture.dependencies,
    );

    assert.equal(result.destination_directory, realpathSync(prefixSibling));
    assert.equal(result.destination_path, join(realpathSync(prefixSibling), "before-legacy-import.sqlite"));
  });

  test("rejects absent, memory, missing, non-file, and database_list-mismatched databases", (t) => {
    const fixture = preflightFixture(t);
    const missingPath = join(fixture.workspace, "missing.db");
    const directoryPath = join(fixture.workspace, "not-a-database-file");
    mkdirSync(directoryPath);
    const cases = [
      {
        db: null,
        database_path: fixture.databasePath,
        code: "LEGACY_IMPORT_BACKUP_DATABASE_UNAVAILABLE",
      },
      {
        db: fixture.dependencies.db,
        database_path: null,
        code: "LEGACY_IMPORT_BACKUP_DATABASE_UNAVAILABLE",
      },
      {
        db: fixture.dependencies.db,
        database_path: ":memory:",
        code: "LEGACY_IMPORT_BACKUP_DATABASE_UNAVAILABLE",
      },
      {
        db: fixture.dependencies.db,
        database_path: "",
        code: "LEGACY_IMPORT_BACKUP_DATABASE_UNAVAILABLE",
      },
      {
        db: fixture.dependencies.db,
        database_path: missingPath,
        code: "LEGACY_IMPORT_BACKUP_DATABASE_INVALID",
      },
      {
        db: fixture.dependencies.db,
        database_path: directoryPath,
        code: "LEGACY_IMPORT_BACKUP_DATABASE_INVALID",
      },
    ];
    for (const { code, ...dependencies } of cases) {
      expectPreflightError(
        () => _prepareLegacyImportBackupPreflightForTest(fixture.input, {
          ...fixture.dependencies,
          ...dependencies,
        }),
        { stage: "database", code, retryable: false },
      );
    }

    const mismatch = fakeBackupDb({
      databaseListPath: join(fixture.workspace, "different.db"),
    });
    expectPreflightError(
      () => _prepareLegacyImportBackupPreflightForTest(fixture.input, {
        ...fixture.dependencies,
        db: mismatch.db,
      }),
      {
        stage: "database",
        code: "LEGACY_IMPORT_BACKUP_DATABASE_INVALID",
        retryable: false,
      },
    );
  });

  test("accepts a live database leaf symlink when database_list resolves the same target", (t) => {
    const fixture = preflightFixture(t);
    const target = join(dirname(fixture.databasePath), "live-target.db");
    renameSync(fixture.databasePath, target);
    symlinkSync(target, fixture.databasePath, "file");
    const fake = fakeBackupDb({ databaseListPath: target });

    const result = _prepareLegacyImportBackupPreflightForTest(fixture.input, {
      ...fixture.dependencies,
      db: fake.db,
    });
    const targetStat = statSync(target);
    assert.equal(result.database_path, realpathSync(target));
    assert.deepEqual(result.database_identity, {
      dev: String(targetStat.dev),
      ino: String(targetStat.ino),
    });
  });

  test("rejects destination directory swaps and final-leaf creation during base capture", (t) => {
    const mutations: ReadonlyArray<{
      mutate(fixture: ReturnType<typeof preflightFixture>): void;
      expected: { stage: string; code: string; retryable: boolean };
    }> = [
      {
        mutate(fixture) {
          renameSync(fixture.destinationDirectory, `${fixture.destinationDirectory}.moved`);
          mkdirSync(fixture.destinationDirectory);
        },
        expected: {
          stage: "destination",
          code: "LEGACY_IMPORT_BACKUP_DESTINATION_INVALID",
          retryable: true,
        },
      },
      {
        mutate(fixture) {
          renameSync(fixture.destinationDirectory, `${fixture.destinationDirectory}.moved`);
          symlinkSync(
            fixture.sourceRoot,
            fixture.destinationDirectory,
            process.platform === "win32" ? "junction" : "dir",
          );
        },
        expected: {
          stage: "destination",
          code: "LEGACY_IMPORT_BACKUP_DESTINATION_INVALID",
          retryable: true,
        },
      },
      {
        mutate(fixture) {
          writeFileSync(join(fixture.destinationDirectory, `${fixture.input.label}.sqlite`), "raced");
        },
        expected: {
          stage: "destination",
          code: "LEGACY_IMPORT_BACKUP_DESTINATION_EXISTS",
          retryable: false,
        },
      },
    ];

    for (const { mutate, expected } of mutations) {
      const fixture = preflightFixture(t);
      expectPreflightError(
        () => _prepareLegacyImportBackupPreflightForTest(fixture.input, {
          ...fixture.dependencies,
          captureBase: () => {
            mutate(fixture);
            return structuredClone(fixture.base);
          },
        }),
        expected,
      );
    }
  });
});

describe("legacy import backup checkpoint", () => {
  test("normalizes accessor-backed database_list, checkpoint, and data_version rows to typed errors", (t) => {
    let checkpointReads = 0;
    const changingCheckpoint = {
      get busy() { return ++checkpointReads === 1 ? 0 : 2; },
      log: 4,
      checkpointed: 4,
    };
    const cases = [
      {
        pragma: "database_list",
        row: { get seq() { throw new Error("database_list getter changed"); }, name: "main", file: "/tmp/db" },
        expected: { stage: "database", code: "LEGACY_IMPORT_BACKUP_DATABASE_INVALID", retryable: false },
      },
      {
        pragma: "wal_checkpoint",
        row: { get busy() { throw new Error("checkpoint getter changed"); }, log: 4, checkpointed: 4 },
        expected: { stage: "checkpoint", code: "LEGACY_IMPORT_BACKUP_CHECKPOINT_INVALID", retryable: false },
      },
      {
        pragma: "wal_checkpoint",
        row: changingCheckpoint,
        expected: { stage: "checkpoint", code: "LEGACY_IMPORT_BACKUP_CHECKPOINT_INVALID", retryable: false },
      },
      {
        pragma: "data_version",
        row: { get data_version() { throw new Error("data_version getter changed"); } },
        expected: { stage: "checkpoint", code: "LEGACY_IMPORT_BACKUP_DATA_VERSION_INVALID", retryable: false },
      },
    ] as const;

    for (const { pragma, row, expected } of cases) {
      const fixture = preflightFixture(t);
      const original = fixture.dependencies.db;
      assert.ok(original);
      const db: DbAdapter = {
        exec: original.exec.bind(original),
        prepare(sql): DbStatement {
          if (!sql.toLowerCase().includes(pragma)) return original.prepare(sql);
          return { run: () => undefined, get: () => row, all: () => [row] } as DbStatement;
        },
        close: original.close.bind(original),
      };
      expectPreflightError(
        () => _prepareLegacyImportBackupPreflightForTest(fixture.input, { ...fixture.dependencies, db }),
        expected,
      );
    }
  });

  test("accepts exact WAL and rollback-journal success tuples", (t) => {
    const wal = preflightFixture(t, { checkpointResults: [{ busy: 0, log: 7, checkpointed: 7 }] });
    assert.deepEqual(
      _prepareLegacyImportBackupPreflightForTest(wal.input, wal.dependencies).checkpoint,
      { mode: "wal", busy: 0, log: 7, checkpointed: 7, attempts: 1 },
    );

    const rollback = preflightFixture(t, { checkpointResults: [{ busy: 0, log: -1, checkpointed: -1 }] });
    assert.deepEqual(
      _prepareLegacyImportBackupPreflightForTest(rollback.input, rollback.dependencies).checkpoint,
      { mode: "rollback", busy: 0, log: -1, checkpointed: -1, attempts: 1 },
    );
  });

  test("retries only checkpoint busy and never exceeds three attempts", (t) => {
    const succeeds = preflightFixture(t, {
      checkpointResults: [
        { busy: 1, log: 5, checkpointed: 2 },
        { busy: 1, log: 5, checkpointed: 4 },
        { busy: 0, log: 5, checkpointed: 5 },
      ],
    });
    assert.deepEqual(
      _prepareLegacyImportBackupPreflightForTest(succeeds.input, succeeds.dependencies).checkpoint,
      { mode: "wal", busy: 0, log: 5, checkpointed: 5, attempts: 3 },
    );
    assert.equal(succeeds.calls.checkpoint, 3);

    const exhausted = preflightFixture(t, {
      checkpointResults: [
        { busy: 1, log: 5, checkpointed: 2 },
        { busy: 1, log: 5, checkpointed: 3 },
        { busy: 1, log: 5, checkpointed: 4 },
        { busy: 0, log: 5, checkpointed: 5 },
      ],
    });
    expectPreflightError(
      () => _prepareLegacyImportBackupPreflightForTest(exhausted.input, exhausted.dependencies),
      {
        stage: "checkpoint",
        code: "LEGACY_IMPORT_BACKUP_CHECKPOINT_BUSY",
        retryable: true,
        context: { attempts: 3, busy: 1, log: 5, checkpointed: 4 },
      },
    );
    assert.equal(exhausted.calls.checkpoint, 3);
    assert.equal(exhausted.captureBaseCalls(), 0);
  });

  test("fails malformed, coercible, incomplete, and thrown checkpoint results without retry or base capture", (t) => {
    const invalidResults: readonly unknown[] = [
      {},
      { busy: "0", log: "4", checkpointed: "4" },
      { busy: 0.5, log: 4, checkpointed: 4 },
      { busy: 0, log: -2, checkpointed: -2 },
      { busy: 2, log: 4, checkpointed: 4 },
      { busy: 0, log: 4, checkpointed: 3 },
      new Error("checkpoint failed"),
    ];

    for (const checkpointResult of invalidResults) {
      const fixture = preflightFixture(t, { checkpointResults: [checkpointResult] });
      expectPreflightError(
        () => _prepareLegacyImportBackupPreflightForTest(fixture.input, fixture.dependencies),
        {
          stage: "checkpoint",
          code: "LEGACY_IMPORT_BACKUP_CHECKPOINT_INVALID",
          retryable: false,
        },
      );
      assert.equal(fixture.calls.checkpoint, 1);
      assert.equal(fixture.captureBaseCalls(), 0);
    }
  });

  test("requires a strict non-negative integer data_version", (t) => {
    for (const dataVersion of [
      {},
      { data_version: "9" },
      { data_version: 9.5 },
      { data_version: -1 },
    ]) {
      const fixture = preflightFixture(t, { dataVersion });
      expectPreflightError(
        () => _prepareLegacyImportBackupPreflightForTest(fixture.input, fixture.dependencies),
        {
          stage: "checkpoint",
          code: "LEGACY_IMPORT_BACKUP_DATA_VERSION_INVALID",
          retryable: false,
        },
      );
      assert.equal(fixture.calls.checkpoint, 1);
      assert.equal(fixture.calls.dataVersion, 1);
      assert.equal(fixture.captureBaseCalls(), 0);
    }
  });

  test("rejects database replacement during checkpoint preflight", (t) => {
    const fixture = preflightFixture(t);
    const originalDb = fixture.dependencies.db;
    assert.ok(originalDb);
    const replacingDb: DbAdapter = {
      exec: originalDb.exec.bind(originalDb),
      prepare(sql): DbStatement {
        const statement = originalDb.prepare(sql);
        if (!sql.toLowerCase().includes("wal_checkpoint")) return statement;
        return {
          run: statement.run.bind(statement),
          all: statement.all.bind(statement),
          get(...params): Record<string, unknown> | undefined {
            const row = statement.get(...params);
            renameSync(fixture.databasePath, `${fixture.databasePath}.moved`);
            writeFileSync(fixture.databasePath, "replacement");
            return row;
          },
        };
      },
      close: originalDb.close.bind(originalDb),
    };

    expectPreflightError(
      () => _prepareLegacyImportBackupPreflightForTest(fixture.input, {
        ...fixture.dependencies,
        db: replacingDb,
      }),
      {
        stage: "database",
        code: "LEGACY_IMPORT_BACKUP_DATABASE_IDENTITY_CHANGED",
        retryable: true,
      },
    );
    assert.equal(fixture.calls.checkpoint, 1);
    assert.equal(fixture.captureBaseCalls(), 1);
  });

  test("treats permanent and unknown base capture failures as non-retryable", (t) => {
    const captures: ReadonlyArray<{
      captureBase(): LegacyImportBaseSnapshot;
      context: Readonly<Record<string, unknown>>;
    }> = [
      {
        captureBase() {
          throw new LegacyImportBaseSnapshotError(
            "LEGACY_IMPORT_BASE_UNSUPPORTED_SCHEMA",
            "unsupported schema",
            { observed_schema_version: 99 },
          );
        },
        context: { capture_error_code: "LEGACY_IMPORT_BASE_UNSUPPORTED_SCHEMA" },
      },
      {
        captureBase() { throw new Error("base capture failed"); },
        context: {},
      },
      {
        captureBase: () => (
          { ...baseSnapshot(), unclonable: () => undefined }
        ) as unknown as LegacyImportBaseSnapshot,
        context: {},
      },
    ];

    for (const { captureBase, context } of captures) {
      const fixture = preflightFixture(t);
      expectPreflightError(
        () => _prepareLegacyImportBackupPreflightForTest(fixture.input, {
          ...fixture.dependencies,
          captureBase,
        }),
        {
          stage: "base",
          code: "LEGACY_IMPORT_BACKUP_BASE_CAPTURE_FAILED",
          retryable: false,
          context,
        },
      );
    }
  });

  test("rejects every current-base approval drift, including row changes without revision movement", (t) => {
    const changedRows = [{
      row_set: "decisions" as const,
      identity: "D001",
      value: { id: "D001", decision: "drift without authority advance" },
    }];
    const drifts: readonly ((base: LegacyImportBaseSnapshot) => LegacyImportBaseSnapshot)[] = [
      (base) => ({ ...base, snapshot_schema_version: 2 as 1 }),
      (base) => ({ ...base, database_schema_version: 43 as 44 }),
      (base) => ({ ...base, authority: { ...base.authority, project_id: "other-project" } }),
      (base) => ({ ...base, authority: { ...base.authority, project_root_realpath: `${base.authority.project_root_realpath}-moved` } }),
      (base) => ({ ...base, authority: { ...base.authority, revision: base.authority.revision + 1 } }),
      (base) => ({ ...base, authority: { ...base.authority, authority_epoch: base.authority.authority_epoch + 1 } }),
      (base) => ({
        ...base,
        rows: changedRows,
        relevant_rows_hash: hashLegacyImportValue(changedRows),
      }),
    ];

    for (const currentBase of drifts) {
      const fixture = preflightFixture(t, { currentBase });
      expectPreflightError(
        () => _prepareLegacyImportBackupPreflightForTest(fixture.input, fixture.dependencies),
        {
          stage: "base",
          code: "LEGACY_IMPORT_BACKUP_BASE_CHANGED",
          retryable: true,
        },
      );
      assert.equal(fixture.captureBaseCalls(), 1);
    }

    const rowDrift = drifts.at(-1)!(baseSnapshot());
    assert.equal(rowDrift.authority.revision, baseSnapshot().authority.revision);
    assert.equal(rowDrift.authority.authority_epoch, baseSnapshot().authority.authority_epoch);
    assert.notEqual(rowDrift.relevant_rows_hash, baseSnapshot().relevant_rows_hash);
  });
});
