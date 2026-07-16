// Project/App: gsd-pi
// File Purpose: Contract tests for the versioned legacy-import surface registry and Preview envelope.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION,
  LEGACY_IMPORT_CHANGE_ACTIONS,
  LEGACY_IMPORT_CHANGE_ENTRY_KEYS,
  LEGACY_IMPORT_DIAGNOSIS_ENTRY_KEYS,
  LEGACY_IMPORT_PREVIEW_COUNT_KEYS,
  LEGACY_IMPORT_PREVIEW_SCHEMA_VERSION,
  LEGACY_IMPORT_PREVIEW_TOP_LEVEL_KEYS,
  LEGACY_IMPORT_RESOLUTION_DISPOSITIONS,
  LEGACY_IMPORT_RESOLUTION_ENTRY_KEYS,
  LEGACY_IMPORT_SOURCE_ENTRY_KEYS,
  LEGACY_IMPORT_SOURCE_OUTCOMES,
  type LegacyImportPreviewChange,
  type LegacyImportPreviewCounts,
  type LegacyImportPreviewDiagnosis,
  type LegacyImportPreviewEnvelope,
  type LegacyImportPreviewResolution,
  type LegacyImportPreviewSource,
  type LegacyImportSha256,
} from "../legacy-import-contract.ts";
import {
  SUPPORTED_LEGACY_SURFACES,
  type LegacyImportSurface,
} from "../legacy-import-surfaces.ts";
import { SCHEMA_VERSION } from "../gsd-db.ts";
import {
  legacyImportCorpusHash,
  loadLegacyImportCorpusCase,
  validateLegacyImportCorpusCase,
} from "./helpers/legacy-import-corpus.ts";

const EXPECTED_SURFACE_IDS = [
  "database-targets",
  "gsd-assessment-truth",
  "gsd-decisions-registry",
  "gsd-flat-hierarchy",
  "gsd-hierarchy-artifacts",
  "gsd-hybrid-hierarchy",
  "gsd-lifecycle-truth",
  "gsd-nested-hierarchy",
  "gsd-requirements-registry",
  "import-action-matrix",
  "jsonl-workflow-history",
  "knowledge-graph-projection",
  "planning-flat-phases",
  "planning-milestone-directories",
  "planning-multi-milestone",
  "planning-supplemental",
  "workflow-definitions",
  "workflow-run-graphs",
  "worktree-topologies",
] as const;

type HasExactKeys<T, Keys extends PropertyKey> =
  [Exclude<keyof T, Keys>, Exclude<Keys, keyof T>] extends [never, never] ? true : false;

const PREVIEW_KEYS_MATCH: HasExactKeys<
  LegacyImportPreviewEnvelope,
  (typeof LEGACY_IMPORT_PREVIEW_TOP_LEVEL_KEYS)[number]
> = true;
const COUNT_KEYS_MATCH: HasExactKeys<
  LegacyImportPreviewCounts,
  (typeof LEGACY_IMPORT_PREVIEW_COUNT_KEYS)[number]
> = true;
const SOURCE_KEYS_MATCH: HasExactKeys<
  LegacyImportPreviewSource,
  (typeof LEGACY_IMPORT_SOURCE_ENTRY_KEYS)[number]
> = true;
const CHANGE_KEYS_MATCH: HasExactKeys<
  LegacyImportPreviewChange,
  (typeof LEGACY_IMPORT_CHANGE_ENTRY_KEYS)[number]
> = true;
const DIAGNOSIS_KEYS_MATCH: HasExactKeys<
  LegacyImportPreviewDiagnosis,
  (typeof LEGACY_IMPORT_DIAGNOSIS_ENTRY_KEYS)[number]
> = true;
const RESOLUTION_KEYS_MATCH: HasExactKeys<
  LegacyImportPreviewResolution,
  (typeof LEGACY_IMPORT_RESOLUTION_ENTRY_KEYS)[number]
> = true;

function assertNonEmptyStrings(values: readonly string[], label: string): void {
  assert.ok(values.length > 0, `${label} must not be empty`);
  for (const value of values) {
    assert.equal(value.trim(), value, `${label} values must be trimmed`);
    assert.ok(value.length > 0, `${label} values must not be blank`);
  }
}

function hashBytes(bytes: Buffer): LegacyImportSha256 {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function assertLegacyImportSurfaceRegistry(registry: readonly LegacyImportSurface[]): void {
  const ids = registry.map((surface) => surface.id);
  assert.equal(new Set(ids).size, ids.length, "legacy surface IDs must be unique");
  assert.deepEqual(ids, [...ids].sort(), "legacy surface IDs must use canonical lexical order");

  for (const surface of registry) {
    assert.match(surface.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${surface.id}: stable ID must be kebab-case`);
    assert.ok(surface.description.trim().length > 0, `${surface.id}: description is required`);
    assert.ok(surface.interpreter.id.trim().length > 0, `${surface.id}: interpreter ID is required`);
    assert.ok(surface.interpreter.version >= 1, `${surface.id}: interpreter version is required`);
    assertNonEmptyStrings(surface.interpreter.implementations, `${surface.id}: interpreter implementations`);
    assertNonEmptyStrings(surface.pathPatterns, `${surface.id}: path patterns`);
    assertNonEmptyStrings(surface.sourceKinds, `${surface.id}: source kinds`);
    assertNonEmptyStrings(surface.requiredScenarios, `${surface.id}: required scenarios`);
    assertNonEmptyStrings(surface.expectedDispositions, `${surface.id}: expected dispositions`);
    assert.ok(Array.isArray(surface.aliases), `${surface.id}: aliases metadata is required`);
  }
}

function surfaceById(id: string): LegacyImportSurface {
  const surface = SUPPORTED_LEGACY_SURFACES.find((candidate) => candidate.id === id);
  assert.ok(surface, `missing legacy surface ${id}`);
  return surface;
}

test("legacy import surface registry pins every approved source and target family", () => {
  assertLegacyImportSurfaceRegistry(SUPPORTED_LEGACY_SURFACES);
  assert.deepEqual(
    SUPPORTED_LEGACY_SURFACES.map((surface) => surface.id),
    EXPECTED_SURFACE_IDS,
  );

  assert.deepEqual(
    [...new Set(SUPPORTED_LEGACY_SURFACES.map((surface) => surface.family))].sort(),
    [
      "change-action",
      "custom-workflow",
      "database-target",
      "gsd-hierarchy",
      "gsd-registry",
      "gsd-truth",
      "jsonl-history",
      "knowledge-graph",
      "planning",
      "workflow-graph",
      "worktree",
    ],
  );
});

test("legacy import surface registry rejects duplicate IDs and missing metadata", () => {
  const duplicate = [...SUPPORTED_LEGACY_SURFACES, SUPPORTED_LEGACY_SURFACES[0]];
  assert.throws(
    () => assertLegacyImportSurfaceRegistry(duplicate),
    /legacy surface IDs must be unique/,
  );

  const missingMetadata = SUPPORTED_LEGACY_SURFACES.map((surface, index) => (
    index === 0 ? { ...surface, description: "" } : surface
  ));
  assert.throws(
    () => assertLegacyImportSurfaceRegistry(missingMetadata),
    /database-targets: description is required/,
  );
});

test("legacy import surface registry pins worktree logs and legacy truth-loss scenarios", () => {
  assert.deepEqual(surfaceById("jsonl-workflow-history").pathPatterns, [
    ".gsd/event-log.jsonl",
    ".gsd/event-log-M*.jsonl.archived",
    ".gsd-worktrees/*/.gsd/event-log.jsonl",
    ".gsd/worktrees/*/.gsd/event-log.jsonl",
    "$GSD_STATE_DIR/projects/*/worktrees/*/.gsd/event-log.jsonl",
  ]);

  const lifecycleScenarios = surfaceById("gsd-lifecycle-truth").requiredScenarios;
  for (const scenario of [
    "manifest-task-narrative-preserved",
    "manifest-task-full-summary-md-preserved",
    "markdown-task-narrative-loss",
    "markdown-task-full-summary-md-loss",
    "slices-depends-vs-slice-dependencies-conflict",
  ]) {
    assert.ok(lifecycleScenarios.includes(scenario), `gsd-lifecycle-truth must cover ${scenario}`);
  }

  const assessmentScenarios = surfaceById("gsd-assessment-truth").requiredScenarios;
  for (const scenario of [
    "run-uat-assessment",
    "roadmap-assessment",
    "fabricated-backfill-placeholder-assessment",
  ]) {
    assert.ok(assessmentScenarios.includes(scenario), `gsd-assessment-truth must cover ${scenario}`);
  }
});

test("legacy import surface registry matches workflow_import_applications Preview DDL", () => {
  const schemaSource = readFileSync(
    new URL("../db-projection-import-kernel-closeout-foundation-schema.ts", import.meta.url),
    "utf8",
  );
  const previewCheck = schemaSource.match(
    /preview_json TEXT NOT NULL CHECK \(([\s\S]*?)\n      \),\n      backup_ref/,
  )?.[1];
  assert.ok(previewCheck, "workflow_import_applications must retain its preview_json CHECK");

  const scalarKeys = [...previewCheck.matchAll(/json_extract\(preview_json, '\$\.([a-z_]+)'\)/g)]
    .map((match) => match[1]);
  const countKeys = [...previewCheck.matchAll(/json_extract\(preview_json, '\$\.counts\.([a-z_]+)'\)/g)]
    .map((match) => match[1]);
  const arrayKeys = [...previewCheck.matchAll(/json_type\(preview_json, '\$\.([a-z_]+)'\) IS 'array'/g)]
    .map((match) => match[1]);

  assert.deepEqual(
    [...scalarKeys, "counts", ...arrayKeys],
    LEGACY_IMPORT_PREVIEW_TOP_LEVEL_KEYS,
  );
  assert.deepEqual(countKeys, LEGACY_IMPORT_PREVIEW_COUNT_KEYS);
});

test("legacy import surface registry pins the deterministic Preview envelope contract", () => {
  assert.equal(SCHEMA_VERSION, 44, "M004/S01 corpus contract targets the accepted v44 schema");
  assert.equal(LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION, SCHEMA_VERSION);
  assert.equal(LEGACY_IMPORT_PREVIEW_SCHEMA_VERSION, 1);
  assert.deepEqual(LEGACY_IMPORT_CHANGE_ACTIONS, ["create", "update", "delete", "preserve"]);
  assert.deepEqual(LEGACY_IMPORT_SOURCE_OUTCOMES, [
    "mapped",
    "preserved",
    "unparsed",
    "ignored-with-reason",
  ]);
  assert.deepEqual(LEGACY_IMPORT_RESOLUTION_DISPOSITIONS, [
    "mapped",
    "preserved",
    "requires-user",
    "unsupported",
  ]);

  const hash = "sha256:0000000000000000000000000000000000000000000000000000000000000000" as LegacyImportSha256;
  const locator = { start_byte: 0, end_byte: 4, line: 1 };
  const source: LegacyImportPreviewSource = {
    source_id: "source-1",
    path: ".gsd/DECISIONS.md",
    kind: "markdown",
    byte_size: 4,
    sha256: hash,
    parser_id: "gsd-decisions-table",
    parser_version: "1",
    encoding: "utf-8",
    outcome: "mapped",
  };
  const change: LegacyImportPreviewChange = {
    change_id: "change-1",
    action: "create",
    target: { kind: "decision", key: "D001" },
    raw: { source_id: source.source_id, locator, value: "D001", sha256: hash },
    normalized: { id: "D001" },
    provenance: {
      source_id: source.source_id,
      parser_id: source.parser_id,
      parser_version: source.parser_version,
    },
    reason_code: "decision-table-row",
  };
  const diagnosis: LegacyImportPreviewDiagnosis = {
    diagnosis_id: "diagnosis-1",
    code: "ambiguous-source",
    severity: "blocker",
    source_id: source.source_id,
    locator,
    raw_value: "D001",
    message: "Two sources claim the same decision.",
  };
  const resolution: LegacyImportPreviewResolution = {
    diagnosis_id: diagnosis.diagnosis_id,
    disposition: "requires-user",
    target: change.target,
  };
  const preview: LegacyImportPreviewEnvelope = {
    preview_schema_version: 1,
    preview_id: "preview-1",
    import_kind: "legacy-corpus",
    importer_version: "v1",
    base_project_revision: 0,
    base_authority_epoch: 0,
    base_database_schema_version: 44,
    source_set_hash: hash,
    change_set_hash: hash,
    counts: { create: 1, update: 0, delete: 0, preserve: 0, unparsed: 0, unresolved: 1 },
    sources: [source],
    changes: [change],
    diagnoses: [diagnosis],
    resolutions: [resolution],
  };

  assert.equal(PREVIEW_KEYS_MATCH, true);
  assert.equal(COUNT_KEYS_MATCH, true);
  assert.equal(SOURCE_KEYS_MATCH, true);
  assert.equal(CHANGE_KEYS_MATCH, true);
  assert.equal(DIAGNOSIS_KEYS_MATCH, true);
  assert.equal(RESOLUTION_KEYS_MATCH, true);
  assert.deepEqual(Object.keys(preview), LEGACY_IMPORT_PREVIEW_TOP_LEVEL_KEYS);
  assert.deepEqual(Object.keys(preview.counts), LEGACY_IMPORT_PREVIEW_COUNT_KEYS);
  assert.deepEqual(Object.keys(source), LEGACY_IMPORT_SOURCE_ENTRY_KEYS);
  assert.deepEqual(Object.keys(change), LEGACY_IMPORT_CHANGE_ENTRY_KEYS);
  assert.deepEqual(Object.keys(diagnosis), LEGACY_IMPORT_DIAGNOSIS_ENTRY_KEYS);
  assert.deepEqual(Object.keys(resolution), LEGACY_IMPORT_RESOLUTION_ENTRY_KEYS);
});

test("legacy corpus validator loads a deterministic synthetic Preview oracle", () => {
  const corpusRoot = new URL("./__fixtures__/legacy-import-corpus/v1/", import.meta.url);
  const corpusCase = loadLegacyImportCorpusCase(corpusRoot, "synthetic-smoke");

  assert.doesNotThrow(() => validateLegacyImportCorpusCase(corpusCase));
  assert.deepEqual(corpusCase.files.map((file) => file.path), [".gsd/DECISIONS.md", ".gsd/STATE.md"]);
});

test("legacy corpus validator fails closed when deterministic evidence drifts", () => {
  const corpusRoot = new URL("./__fixtures__/legacy-import-corpus/v1/", import.meta.url);
  const corpusCase = loadLegacyImportCorpusCase(corpusRoot, "synthetic-smoke");
  const withOracle = (mutate: (oracle: LegacyImportPreviewEnvelope) => void) => {
    const oracle = structuredClone(corpusCase.oracle) as LegacyImportPreviewEnvelope;
    mutate(oracle);
    return { ...corpusCase, oracle };
  };

  assert.throws(
    () => validateLegacyImportCorpusCase(withOracle((oracle) => {
      oracle.changes[0].normalized = { created_at: "2026-01-01T00:00:00Z" };
    })),
    /timestamps are forbidden/,
  );
  assert.throws(
    () => validateLegacyImportCorpusCase(withOracle((oracle) => {
      oracle.counts.create = 0;
    })),
    /counts do not match/,
  );
  assert.throws(
    () => validateLegacyImportCorpusCase(withOracle((oracle) => {
      oracle.sources[0].byte_size = 4;
    })),
    /fingerprint does not match bytes/,
  );
  assert.throws(
    () => validateLegacyImportCorpusCase(withOracle((oracle) => {
      oracle.changes[0].raw.locator.end_byte = 5;
    })),
    /raw hash must cover its exact byte span/,
  );
  assert.throws(
    () => validateLegacyImportCorpusCase(withOracle((oracle) => {
      oracle.changes[0].raw.locator.line = 2;
    })),
    /line does not match its byte span/,
  );
  assert.throws(
    () => validateLegacyImportCorpusCase(withOracle((oracle) => {
      oracle.sources = [...oracle.sources].reverse();
    })),
    /\[case synthetic-smoke\] at \$\.sources: entries must use canonical order/,
  );
  assert.throws(
    () => validateLegacyImportCorpusCase(withOracle((oracle) => {
      oracle.sources[1].source_id = oracle.sources[0].source_id;
    })),
    /source IDs must be unique/,
  );
  assert.throws(
    () => validateLegacyImportCorpusCase(withOracle((oracle) => {
      oracle.sources[0].source_id = " source-decisions ";
    })),
    /\$\.sources\[0\]\.source_id: invalid oracle schema/,
  );
  assert.throws(
    () => validateLegacyImportCorpusCase(withOracle((oracle) => {
      oracle.changes[0].raw.value = { id: "D001" };
    })),
    /\$\.changes\[0\]\.raw\.value:.*non-string raw value requires json_pointer/,
  );
  assert.throws(
    () => validateLegacyImportCorpusCase(withOracle((oracle) => {
      oracle.diagnoses[0].raw_value = "ready";
    })),
    /\$\.diagnoses\[0\]\.raw_value:.*source_id=source-state.*raw value must match/,
  );
  assert.throws(
    () => validateLegacyImportCorpusCase(withOracle((oracle) => {
      oracle.diagnoses[0].locator.json_pointer = "/missing";
    })),
    /\$\.diagnoses\[0\]\.raw_value\.json_pointer:.*JSON pointer token does not exist/,
  );
  assert.throws(
    () => validateLegacyImportCorpusCase(withOracle((oracle) => {
      oracle.resolutions = [];
    })),
    /\$\.resolutions: diagnosis diagnosis-blocked-state must have exactly one resolution/,
  );
  assert.throws(
    () => validateLegacyImportCorpusCase(withOracle((oracle) => {
      oracle.resolutions[0].diagnosis_id = "diagnosis-missing";
    })),
    /\$\.resolutions: diagnosis diagnosis-blocked-state must have exactly one resolution/,
  );

  for (const [field, value] of [
    ["import_kind", "Legacy-Corpus"],
    ["import_kind", " legacy-corpus "],
    ["importer_version", " v1-test "],
    ["importer_version", "   "],
  ] as const) {
    assert.throws(
      () => validateLegacyImportCorpusCase(withOracle((oracle) => {
        oracle[field] = value;
      })),
      new RegExp(`\\$\\.${field}:.*invalid oracle schema`),
    );
  }

  assert.doesNotThrow(() => validateLegacyImportCorpusCase(withOracle((oracle) => {
    oracle.diagnoses[0].raw_value = {
      redacted: true,
      sha256: "sha256:7b92de7d08814ff2863dbd0239cdcb3cd107364ebf588b5d95693527f066f106",
    };
  })));
  assert.throws(
    () => validateLegacyImportCorpusCase(withOracle((oracle) => {
      oracle.diagnoses[0].raw_value = {
        redacted: true,
        sha256: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      };
    })),
    /\$\.diagnoses\[0\]\.raw_value:.*redacted evidence hash must cover its exact byte span/,
  );
  assert.throws(
    () => validateLegacyImportCorpusCase(withOracle((oracle) => {
      oracle.diagnoses[0].raw_value = {
        redacted: true,
        sha256: "sha256:7b92de7d08814ff2863dbd0239cdcb3cd107364ebf588b5d95693527f066f106",
      };
      oracle.diagnoses[0].message = "Protected state was blocked.";
    })),
    /\$\.diagnoses\[0\]\.message:.*redacted diagnosis message exposes protected content/,
  );
  assert.throws(
    () => validateLegacyImportCorpusCase(withOracle((oracle) => {
      oracle.diagnoses[0].raw_value = {
        redacted: true,
        sha256: "sha256:7b92de7d08814ff2863dbd0239cdcb3cd107364ebf588b5d95693527f066f106",
      };
      oracle.diagnoses[0].message = "Protected bytes were \"blocked\".";
    })),
    /\$\.diagnoses\[0\]\.message:.*redacted diagnosis message exposes protected content/,
  );

  const invalidUtf8 = Buffer.from([0xff]);
  const invalidUtf8Hash = hashBytes(invalidUtf8);
  const invalidUtf8Oracle = structuredClone(corpusCase.oracle) as LegacyImportPreviewEnvelope;
  invalidUtf8Oracle.sources[1].byte_size = invalidUtf8.byteLength;
  invalidUtf8Oracle.sources[1].sha256 = invalidUtf8Hash;
  invalidUtf8Oracle.source_set_hash = legacyImportCorpusHash(invalidUtf8Oracle.sources);
  assert.throws(
    () => validateLegacyImportCorpusCase({
      ...corpusCase,
      files: corpusCase.files.map((file) => file.path === ".gsd/STATE.md"
        ? { ...file, bytes: invalidUtf8, byteSize: invalidUtf8.byteLength, sha256: invalidUtf8Hash }
        : file),
      oracle: invalidUtf8Oracle,
    }),
    /\$\.sources\[1\]\.encoding:.*source_id=source-state.*expected_disposition=preserved.*declared UTF-8 source contains invalid UTF-8 bytes/,
  );

  assert.throws(
    () => validateLegacyImportCorpusCase(withOracle((oracle) => {
      oracle.sources[1].outcome = "ignored-with-reason";
      oracle.diagnoses = [];
      oracle.resolutions = [];
      oracle.counts.unresolved = 0;
      oracle.source_set_hash = legacyImportCorpusHash(oracle.sources);
    })),
    /\$\.sources\[1\]\.outcome:.*source_id=source-state.*expected_disposition=ignored-with-reason.*requires an attached explicit reason/,
  );
  assert.doesNotThrow(() => validateLegacyImportCorpusCase(withOracle((oracle) => {
    oracle.sources[1].outcome = "ignored-with-reason";
    oracle.source_set_hash = legacyImportCorpusHash(oracle.sources);
  })));
  assert.doesNotThrow(() => validateLegacyImportCorpusCase(withOracle((oracle) => {
    oracle.sources[0].outcome = "ignored-with-reason";
    oracle.source_set_hash = legacyImportCorpusHash(oracle.sources);
  })));
});

test("legacy corpus validator resolves only valid RFC 6901 array tokens", () => {
  const corpusRoot = new URL("./__fixtures__/legacy-import-corpus/v1/", import.meta.url);
  const corpusCase = loadLegacyImportCorpusCase(corpusRoot, "synthetic-smoke");
  const stateBytes = Buffer.from("[\"blocked\"]\n", "utf8");
  const stateHash = hashBytes(stateBytes);
  const withPointer = (jsonPointer: string) => {
    const oracle = structuredClone(corpusCase.oracle) as LegacyImportPreviewEnvelope;
    oracle.sources[1].byte_size = stateBytes.byteLength;
    oracle.sources[1].sha256 = stateHash;
    oracle.source_set_hash = legacyImportCorpusHash(oracle.sources);
    oracle.diagnoses[0].locator = {
      start_byte: 1,
      end_byte: 10,
      line: 1,
      json_pointer: jsonPointer,
    };
    return {
      ...corpusCase,
      files: corpusCase.files.map((file) => file.path === ".gsd/STATE.md"
        ? { ...file, bytes: stateBytes, byteSize: stateBytes.byteLength, sha256: stateHash }
        : file),
      oracle,
    };
  };

  assert.doesNotThrow(() => validateLegacyImportCorpusCase(withPointer("/0")));
  for (const invalidPointer of ["/01", "/length"]) {
    assert.throws(
      () => validateLegacyImportCorpusCase(withPointer(invalidPointer)),
      /JSON pointer array token is not a canonical index/,
    );
  }
  assert.throws(
    () => validateLegacyImportCorpusCase(withPointer("/~2")),
    /JSON pointer token has an invalid escape/,
  );
  assert.throws(
    () => validateLegacyImportCorpusCase(withPointer("/9007199254740992")),
    /JSON pointer token does not exist/,
  );
});

test("legacy corpus validator records symlink target bytes without following the link", (t) => {
  const root = mkdtempSync(`${tmpdir()}/gsd-legacy-corpus-`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(`${root}/symlink-smoke/source`, { recursive: true });
  writeFileSync(`${root}/outside.txt`, "must-not-be-read");
  symlinkSync("../../outside.txt", `${root}/symlink-smoke/source/link.txt`);
  writeFileSync(`${root}/symlink-smoke/oracle.json`, "{}");
  writeFileSync(`${root}/oracle.schema.json`, "{}");

  const corpusCase = loadLegacyImportCorpusCase(pathToFileURL(`${root}/`), "symlink-smoke");

  assert.equal(corpusCase.files.length, 1);
  assert.equal(corpusCase.files[0].entryKind, "symlink");
  assert.equal(corpusCase.files[0].bytes.toString("utf8"), "../../outside.txt");
  assert.notEqual(corpusCase.files[0].bytes.toString("utf8"), "must-not-be-read");
});

test("legacy corpus validator reports case, JSON path, source, and locator context", () => {
  const corpusRoot = new URL("./__fixtures__/legacy-import-corpus/v1/", import.meta.url);
  const corpusCase = loadLegacyImportCorpusCase(corpusRoot, "synthetic-smoke");
  const oracle = structuredClone(corpusCase.oracle) as LegacyImportPreviewEnvelope;
  oracle.changes[0].raw.locator.end_byte = 5;

  assert.throws(
    () => validateLegacyImportCorpusCase({ ...corpusCase, oracle }),
    /\[case synthetic-smoke\] at \$\.changes\[0\]\.raw\.locator:.*source_id=source-decisions.*locator=.*expected_disposition=mapped/,
  );
});
