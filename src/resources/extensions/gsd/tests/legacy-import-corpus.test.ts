// Project/App: gsd-pi
// File Purpose: Contract tests for the versioned legacy-import surface registry and Preview envelope.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { graphQuery } from "../../../../../packages/mcp-server/src/readers/graph.ts";
import { loadDefinitionFromFile } from "../definition-loader.ts";
import { readGraph } from "../graph.ts";
import { parseKnowledgeRows } from "../knowledge-parser.ts";
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
import { redactSecrets } from "../redact-secrets.ts";
import { listRuns } from "../run-manager.ts";
import {
  readWorktreeEventLogPath,
  resolveWorkflowEventLedgerLocation,
} from "../workflow-event-ledger.ts";
import {
  normalizeWorkflowEventCommand,
  workflowEventEntityKey,
} from "../workflow-event-vocabulary.ts";
import { findForkPoint, readEvents } from "../workflow-events.ts";
import { readManifest } from "../workflow-manifest.ts";
import { discoverPlugins } from "../workflow-plugins.ts";
import {
  canonicalWorktreesDir,
  legacyWorktreesDir,
  worktreePathFor,
  worktreesDirs,
} from "../worktree-placement.ts";
import {
  isGsdWorktreePath,
  normalizeWorktreePathForCompare,
  projectRootFromWorktreePath,
  resolveExternalStateProjectGsdFromWorktreePath,
  resolveExternalStateProjectIdentityFromWorktreePath,
} from "../worktree-root.ts";
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

test("legacy corpus planning validates every required planning family without inferred ambiguity", () => {
  const corpusRoot = new URL("./__fixtures__/legacy-import-corpus/v1/", import.meta.url);
  const caseNames = [
    "planning-flat-complete",
    "planning-milestone-dirs",
    "planning-multi-milestone",
    "planning-multi-milestone-heading",
    "planning-multi-milestone-details",
    "planning-multi-milestone-summary",
    "planning-multi-milestone-completed-range",
    "planning-multi-milestone-emoji-range",
    "planning-number-aliases",
    "planning-loss-surfaces",
  ] as const;
  const cases = caseNames.map((caseName) => loadLegacyImportCorpusCase(corpusRoot, caseName));

  for (const corpusCase of cases) {
    validateLegacyImportCorpusCase(corpusCase);
  }

  const byName = new Map(cases.map((corpusCase) => [corpusCase.name, corpusCase.oracle]));
  const oracle = (caseName: (typeof caseNames)[number]) => {
    const result = byName.get(caseName);
    assert.ok(result, `missing ${caseName}`);
    return result;
  };
  const targetKeys = (caseName: (typeof caseNames)[number]) =>
    oracle(caseName).changes.map((change) => change.target.key).sort();
  const diagnosisCodes = (caseName: (typeof caseNames)[number]) =>
    oracle(caseName).diagnoses.map((diagnosis) => diagnosis.code).sort();

  assert.equal(oracle("planning-flat-complete").counts.unresolved, 0);
  assert.deepEqual(targetKeys("planning-flat-complete"), [
    "M001",
    "M001/S01",
    "M001/S01/T01",
    "M001/S01/T01",
    "R001",
  ]);

  const grammarCases = [
    [
      "planning-multi-milestone-heading",
      "heading",
      [
        {
          target: { kind: "milestone", key: "M001" },
          normalized: {
            grammar: "heading",
            id: "M001",
            title: "Foundation",
            status: "complete",
            sequence: 1,
          },
        },
        {
          target: { kind: "milestone", key: "M002" },
          normalized: {
            grammar: "heading",
            id: "M002",
            title: "Delivery",
            status: "active",
            sequence: 2,
          },
        },
        {
          target: { kind: "slice", key: "M001/S01" },
          normalized: {
            grammar: "heading",
            id: "S01",
            milestone_id: "M001",
            title: "Repository Foundation",
            status: "complete",
            sequence: 1,
          },
        },
        {
          target: { kind: "slice", key: "M002/S01" },
          normalized: {
            grammar: "heading",
            id: "S01",
            milestone_id: "M002",
            title: "Delivery Path",
            status: "pending",
            sequence: 1,
          },
        },
      ],
    ],
    [
      "planning-multi-milestone-details",
      "details",
      [
        {
          target: { kind: "milestone", key: "M001" },
          normalized: {
            grammar: "details",
            id: "M001",
            title: "Foundation",
            status: "complete",
            sequence: 1,
          },
        },
        {
          target: { kind: "milestone", key: "M002" },
          normalized: {
            grammar: "details",
            id: "M002",
            title: "Delivery",
            status: "active",
            sequence: 2,
          },
        },
        {
          target: { kind: "slice", key: "M001/S01" },
          normalized: {
            grammar: "details",
            id: "S01",
            milestone_id: "M001",
            title: "Repository Foundation",
            status: "complete",
            sequence: 1,
          },
        },
        {
          target: { kind: "slice", key: "M002/S01" },
          normalized: {
            grammar: "details",
            id: "S01",
            milestone_id: "M002",
            title: "Delivery Path",
            status: "pending",
            sequence: 1,
          },
        },
      ],
    ],
    [
      "planning-multi-milestone-summary",
      "summary",
      [
        {
          target: { kind: "milestone", key: "M001" },
          normalized: {
            grammar: "summary",
            id: "M001",
            title: "v1.0 Foundation",
            status: "complete",
            sequence: 1,
          },
        },
        {
          target: { kind: "milestone", key: "M002" },
          normalized: {
            grammar: "summary",
            id: "M002",
            title: "v2.0 Delivery",
            status: "active",
            sequence: 2,
          },
        },
        {
          target: { kind: "slice", key: "M001/S01" },
          normalized: {
            grammar: "summary",
            id: "S01",
            milestone_id: "M001",
            title: "Repository Foundation",
            status: "complete",
            sequence: 1,
          },
        },
        {
          target: { kind: "slice", key: "M002/S01" },
          normalized: {
            grammar: "summary",
            id: "S01",
            milestone_id: "M002",
            title: "Delivery Path",
            status: "pending",
            sequence: 1,
          },
        },
      ],
    ],
    [
      "planning-multi-milestone-completed-range",
      "completed-range",
      [
        {
          target: { kind: "milestone", key: "M001" },
          normalized: {
            grammar: "completed-range",
            id: "M001",
            title: "v1.0 Completed Foundation",
            status: "complete",
            sequence: 1,
          },
        },
        {
          target: { kind: "milestone", key: "M002" },
          normalized: {
            grammar: "completed-range",
            id: "M002",
            title: "v2.0 Completed Delivery",
            status: "complete",
            sequence: 2,
          },
        },
        {
          target: { kind: "slice", key: "M001/S01" },
          normalized: {
            grammar: "completed-range",
            id: "S01",
            milestone_id: "M001",
            title: "Phase 1",
            status: "complete",
            sequence: 1,
          },
        },
        {
          target: { kind: "slice", key: "M001/S02" },
          normalized: {
            grammar: "completed-range",
            id: "S02",
            milestone_id: "M001",
            title: "Phase 2",
            status: "complete",
            sequence: 2,
          },
        },
        {
          target: { kind: "slice", key: "M002/S01" },
          normalized: {
            grammar: "completed-range",
            id: "S01",
            milestone_id: "M002",
            title: "Phase 3",
            status: "complete",
            sequence: 1,
          },
        },
        {
          target: { kind: "slice", key: "M002/S02" },
          normalized: {
            grammar: "completed-range",
            id: "S02",
            milestone_id: "M002",
            title: "Phase 4",
            status: "complete",
            sequence: 2,
          },
        },
      ],
    ],
    [
      "planning-multi-milestone-emoji-range",
      "emoji-range",
      [
        {
          target: { kind: "milestone", key: "M001" },
          normalized: {
            grammar: "emoji-range",
            id: "M001",
            title: "Migration",
            status: "active",
            sequence: 1,
          },
        },
        {
          target: { kind: "slice", key: "M001/S01" },
          normalized: {
            grammar: "emoji-range",
            id: "S01",
            milestone_id: "M001",
            title: "Foundation",
            status: "complete",
            sequence: 1,
          },
        },
        {
          target: { kind: "slice", key: "M001/S02" },
          normalized: {
            grammar: "emoji-range",
            id: "S02",
            milestone_id: "M001",
            title: "Delivery",
            status: "pending",
            sequence: 2,
          },
        },
      ],
    ],
  ] as const;
  for (const [caseName, grammar, expectedOutputs] of grammarCases) {
    const preview = oracle(caseName);
    assert.equal(preview.counts.unresolved, 0, `${grammar} grammar must map without user input`);
    assert.deepEqual(
      preview.changes.map((change) => ({ target: change.target, normalized: change.normalized })),
      expectedOutputs,
    );
    assert.ok(preview.sources.every((source) => source.outcome === "mapped"));
  }

  const mixedRoadmap = oracle("planning-multi-milestone");
  assert.deepEqual(diagnosisCodes("planning-multi-milestone"), ["competing-roadmap-grammars"]);
  assert.deepEqual(mixedRoadmap.sources.map((source) => [source.path, source.outcome]), [
    [".planning/ROADMAP.md", "unparsed"],
  ]);
  assert.deepEqual(
    mixedRoadmap.changes.map((change) => ({
      action: change.action,
      target: change.target,
      normalized: change.normalized,
    })),
    [
      { action: "preserve", target: { kind: "legacy-roadmap-fragment", key: "details" }, normalized: { disposition: "preserved", grammar: "details" } },
      { action: "preserve", target: { kind: "legacy-roadmap-fragment", key: "heading" }, normalized: { disposition: "preserved", grammar: "heading" } },
      { action: "preserve", target: { kind: "legacy-roadmap-fragment", key: "ranges" }, normalized: { disposition: "preserved", grammar: "ranges" } },
      { action: "preserve", target: { kind: "legacy-roadmap-fragment", key: "summary" }, normalized: { disposition: "preserved", grammar: "summary" } },
    ],
  );
  assert.ok(mixedRoadmap.resolutions.some((resolution) => resolution.disposition === "requires-user"));

  const milestoneDirectories = oracle("planning-milestone-dirs");
  assert.deepEqual(
    targetKeys("planning-milestone-dirs").filter((key) => key.startsWith("M001")),
    ["M001", "M001/S01", "M001/S01/T01"],
  );
  assert.ok(
    milestoneDirectories.changes.every((change) =>
      change.target.kind === "legacy-artifact" || !change.target.key.startsWith("v1.0")),
    "legacy milestone labels are provenance, never canonical keys",
  );
  assert.deepEqual(diagnosisCodes("planning-milestone-dirs"), ["duplicate-phase-number"]);
  assert.deepEqual(
    milestoneDirectories.changes
      .filter((change) => ["M001", "M001/S01", "M001/S01/T01"].includes(change.target.key))
      .map((change) => ({
        target: change.target,
        legacyProvenance: (change.normalized as { legacy_provenance?: unknown }).legacy_provenance,
      })),
    [
      { target: { kind: "milestone", key: "M001" }, legacyProvenance: { milestone_id: "v1.0" } },
      { target: { kind: "slice", key: "M001/S01" }, legacyProvenance: { milestone_id: "v1.0", phase_number: "01", phase_slug: "foundation" } },
      { target: { kind: "task", key: "M001/S01/T01" }, legacyProvenance: { milestone_id: "v1.0", phase_number: "01", phase_slug: "foundation", plan_number: "01" } },
    ],
  );
  assert.deepEqual(milestoneDirectories.resolutions, [
    {
      diagnosis_id: "diagnosis-duplicate-phase-number",
      disposition: "requires-user",
    },
  ]);

  const aliases = oracle("planning-number-aliases");
  assert.deepEqual(
    aliases.sources.filter((source) => source.outcome === "mapped").map((source) => source.path),
    [
      ".planning/ROADMAP.md",
      ".planning/phases/01.2-alias-ordering/01.2-03-PLAN.md",
      ".planning/phases/01.2-alias-ordering/01.2-03b-PLAN.md",
      ".planning/phases/01.2-alias-ordering/01.2-04-PLAN.md",
    ],
  );
  assert.deepEqual(targetKeys("planning-number-aliases"), [
    "M001/S01",
    "M001/S01/T01",
    "M001/S01/T02",
    "M001/S01/T03",
  ]);
  assert.deepEqual(diagnosisCodes("planning-number-aliases"), ["plan-number-conflict"]);
  assert.ok(aliases.resolutions.some((resolution) => resolution.disposition === "requires-user"));

  const lossSurfaces = oracle("planning-loss-surfaces");
  assert.ok(diagnosisCodes("planning-loss-surfaces").includes("malformed-roadmap-row"));
  assert.ok(diagnosisCodes("planning-loss-surfaces").includes("placeholder-plan"));
  assert.ok(diagnosisCodes("planning-loss-surfaces").includes("conflicting-completion-evidence"));
  assert.ok(
    lossSurfaces.changes.some(
      (change) => change.reason_code === "legacy-skipped-means-cancelled" && change.normalized === "cancelled",
    ),
  );
  assert.ok(
    lossSurfaces.changes.some(
      (change) =>
        change.reason_code === "orphan-summary-preserved-verbatim" && change.action === "preserve",
    ),
  );
  assert.ok(
    lossSurfaces.sources.some(
      (source) => source.path.startsWith(".planning/.archive/") && source.outcome === "ignored-with-reason",
    ),
  );

  const sources = cases.flatMap((corpusCase) => corpusCase.oracle.sources);
  assert.deepEqual(
    [...new Set(sources.map((source) => source.parser_id))].sort(),
    [
      "gsd-lifecycle-truth",
      "planning-milestone-directory-parser",
      "planning-parser",
      "planning-roadmap-parser",
      "planning-supplemental-classifier",
    ],
  );
  assert.deepEqual(
    [...new Set(sources.map((source) => source.outcome))].sort(),
    ["ignored-with-reason", "mapped", "preserved", "unparsed"],
  );
});

test("legacy corpus gsd truth preserves hierarchy evidence and refuses competing authority", () => {
  const corpusRoot = new URL("./__fixtures__/legacy-import-corpus/v1/", import.meta.url);
  const caseNames = [
    "gsd-nested",
    "gsd-flat",
    "gsd-alias-hybrid",
    "registries",
    "registries-lowercase",
    "lifecycle-truth-matrix",
    "assessment-matrix",
  ] as const;
  const cases = caseNames.map((caseName) => loadLegacyImportCorpusCase(corpusRoot, caseName));

  for (const corpusCase of cases) {
    validateLegacyImportCorpusCase(corpusCase);
  }

  const corpusPath = fileURLToPath(corpusRoot);
  for (const caseName of ["lifecycle-truth-matrix", "assessment-matrix"] as const) {
    const manifest = readManifest(`${corpusPath}${caseName}/source`);
    assert.ok(manifest, `${caseName} must contain a producer-valid StateManifest`);
    assert.equal(manifest.version, 1);
    assert.ok(Array.isArray(manifest.verification_evidence));
  }
  const dependencyDatabase = new DatabaseSync(
    `${corpusPath}lifecycle-truth-matrix/source/.gsd/gsd.db`,
    { readOnly: true },
  );
  try {
    const conflict = dependencyDatabase.prepare(`
      SELECT
        (SELECT version FROM schema_version) AS schema_version,
        (SELECT depends FROM slices WHERE milestone_id = 'M001' AND id = 'S02') AS depends_json,
        (SELECT depends_on_slice_id FROM slice_dependencies
          WHERE milestone_id = 'M001' AND slice_id = 'S02') AS junction_dependency
    `).get() as Record<string, unknown>;
    assert.deepEqual({ ...conflict }, {
      schema_version: 44,
      depends_json: '["S00"]',
      junction_dependency: "S99",
    });
    const integrity = dependencyDatabase.prepare("PRAGMA integrity_check").get() as Record<
      string,
      unknown
    >;
    assert.deepEqual(Object.values(integrity), ["ok"]);
  } finally {
    dependencyDatabase.close();
  }

  const byName = new Map(cases.map((corpusCase) => [corpusCase.name, corpusCase.oracle]));
  const oracle = (caseName: (typeof caseNames)[number]) => {
    const result = byName.get(caseName);
    assert.ok(result, `missing ${caseName}`);
    return result;
  };
  const targetKeys = (caseName: (typeof caseNames)[number]) =>
    oracle(caseName).changes.map((change) => change.target.key);
  const diagnosisCodes = (caseName: (typeof caseNames)[number]) =>
    oracle(caseName).diagnoses.map((diagnosis) => diagnosis.code);
  const sourcePaths = (caseName: (typeof caseNames)[number]) =>
    oracle(caseName).sources.map((source) => source.path);
  const sourceRows = (caseName: (typeof caseNames)[number]) =>
    oracle(caseName).sources.map((source) => [source.path, source.parser_id, source.outcome]);
  const diagnosisRows = (caseName: (typeof caseNames)[number]) =>
    oracle(caseName).diagnoses.map((diagnosis) => [
      diagnosis.diagnosis_id,
      diagnosis.code,
      diagnosis.source_id,
    ]);
  const changeFor = (caseName: (typeof caseNames)[number], key: string, field?: string) => {
    const matches = oracle(caseName).changes.filter(
      (change) => change.target.key === key && change.target.field === field,
    );
    assert.equal(matches.length, 1, `${caseName} must have one exact change for ${key}`);
    return matches[0]!;
  };
  const semanticChange = (caseName: (typeof caseNames)[number], key: string, field?: string) => {
    const change = changeFor(caseName, key, field);
    return {
      action: change.action,
      target: change.target,
      normalized: change.normalized,
      reason: change.reason_code,
    };
  };
  const changeRows = (caseName: (typeof caseNames)[number]) =>
    oracle(caseName).changes.map((change) => [
      change.action,
      change.target.kind,
      change.target.key,
      change.target.field ?? null,
      change.normalized,
      change.reason_code,
    ]);

  assert.deepEqual(sourceRows("gsd-nested"), [
    [".gsd/milestones/M001-foundation/M001-ROADMAP.md", "gsd-nested-hierarchy", "mapped"],
    [".gsd/milestones/M001-foundation/slices/S01-core/S01-PLAN.md", "gsd-nested-hierarchy", "mapped"],
    [".gsd/milestones/M001-foundation/slices/S02-api/S02-PLAN.md", "gsd-nested-hierarchy", "mapped"],
    [".gsd/milestones/M001-foundation/slices/S03-client/tasks/T01-PLAN.md", "gsd-nested-hierarchy", "mapped"],
    [".gsd/milestones/M001-foundation/slices/S04-release/T01-PLAN.md", "gsd-nested-hierarchy", "mapped"],
    [".gsd/milestones/M002-delivery/M002-ROADMAP.md", "gsd-nested-hierarchy", "mapped"],
    [".gsd/milestones/M002-delivery/slices/S01-ship/S01-PLAN.md", "gsd-nested-hierarchy", "mapped"],
    [".gsd/milestones/M003-operations/M003-ROADMAP.md", "gsd-nested-hierarchy", "mapped"],
    [".gsd/milestones/M004-experiments/M004-ROADMAP.md", "gsd-nested-hierarchy", "mapped"],
    [".gsd/milestones/M099-ghost/M099-CONTEXT.md", "gsd-nested-hierarchy", "preserved"],
  ]);
  assert.deepEqual(changeRows("gsd-nested"), [
    ["create", "milestone", "M001", null, { id: "M001", title: "Foundation" }, "nested-milestone-heading"],
    ["create", "slice", "M001/S01", null, { id: "S01", milestone_id: "M001", status: "complete", title: "Core setup", depends_on: [] }, "nested-roadmap-checklist"],
    ["create", "task", "M001/S01/T01", null, { id: "T01", milestone_id: "M001", slice_id: "S01", status: "complete", title: "Create the project skeleton" }, "nested-checkbox-task"],
    ["create", "slice", "M001/S02", null, { id: "S02", milestone_id: "M001", status: "pending", title: "API wiring", depends_on: ["S01"] }, "nested-roadmap-checklist"],
    ["create", "task", "M001/S02/T01", null, { id: "T01", milestone_id: "M001", slice_id: "S02", status: "pending", title: "Connect the service boundary" }, "nested-heading-task"],
    ["create", "slice", "M001/S03", null, { id: "S03", milestone_id: "M001", status: "pending", title: "Client flow", depends_on: ["S01", "S02"] }, "nested-roadmap-dependency-range"],
    ["create", "task", "M001/S03/T01", null, { id: "T01", milestone_id: "M001", slice_id: "S03", status: "pending", title: "Build the client flow" }, "nested-task-subdirectory"],
    ["create", "slice", "M001/S04", null, { id: "S04", milestone_id: "M001", status: "pending", title: "Release checks", depends_on: ["S02", "S03"] }, "nested-roadmap-dependency-range"],
    ["create", "task", "M001/S04/T01", null, { id: "T01", milestone_id: "M001", slice_id: "S04", status: "pending", title: "Run release checks" }, "nested-flat-task-within-slice"],
    ["create", "milestone", "M002", null, { id: "M002", title: "Delivery" }, "nested-milestone-heading"],
    ["create", "slice", "M002/S01", null, { id: "S01", milestone_id: "M002", status: "complete", title: "Ship candidate", depends_on: [], risk: "medium" }, "nested-roadmap-table"],
    ["create", "task", "M002/S01/T01", null, { id: "T01", milestone_id: "M002", slice_id: "S01", status: "complete", title: "Publish the candidate" }, "nested-xml-task"],
    ["create", "milestone", "M003", null, { id: "M003", title: "Operations" }, "nested-milestone-heading"],
    ["create", "slice", "M003/S01", null, { id: "S01", milestone_id: "M003", status: "pending", title: "Observability" }, "nested-roadmap-prose"],
    ["create", "milestone", "M004", null, { id: "M004", title: "Experiments" }, "nested-milestone-heading"],
    ["create", "slice", "M004/S01", null, { id: "S01", milestone_id: "M004", status: "pending", title: "Explore the idea", sketch: true, tasks: [] }, "nested-sketch-placeholder"],
    ["preserve", "artifact", ".gsd/milestones/M099-ghost/M099-CONTEXT.md", null, { reason: "ghost-milestone-without-roadmap" }, "nested-ghost-preserved"],
  ]);
  assert.deepEqual(diagnosisRows("gsd-nested"), []);

  assert.deepEqual(sourceRows("gsd-flat"), [
    [".gsd/phases/01-foundation/01-01-PLAN.md", "gsd-flat-hierarchy", "mapped"],
    [".gsd/phases/01-foundation/01-01-SUMMARY.md", "gsd-flat-hierarchy", "mapped"],
    [".gsd/phases/01-foundation/01-02-SUMMARY.md", "gsd-flat-hierarchy", "unparsed"],
    [".gsd/phases/01-foundation/01-ROADMAP.md", "gsd-flat-hierarchy", "mapped"],
    [".gsd/phases/01-foundation/NOTES.md", "gsd-artifact-classifier", "preserved"],
    [".gsd/phases/15-observability/15-ROADMAP.md", "gsd-flat-hierarchy", "mapped"],
    [".gsd/phases/M016-delivery/M016-ROADMAP.md", "gsd-flat-hierarchy", "mapped"],
  ]);
  assert.deepEqual(changeRows("gsd-flat"), [
    ["create", "milestone", "M001", null, { id: "M001", title: "Foundation" }, "flat-milestone-alias"],
    ["create", "slice", "M001/S01", null, { id: "S01", milestone_id: "M001", status: "pending", title: "Core setup" }, "flat-slice-checklist"],
    ["create", "task", "M001/S01/T01", null, { id: "T01", milestone_id: "M001", slice_id: "S01", status: "pending", title: "Create the project skeleton" }, "flat-task-frontmatter-parent"],
    ["update", "task", "M001/S01/T01", "status", "complete", "flat-matching-summary-attestation"],
    ["create", "milestone", "M015", null, { id: "M015", source_alias: "15", title: "Observability" }, "flat-bare-numeric-milestone"],
    ["create", "slice", "M015/S01", null, { id: "S01", milestone_id: "M015", status: "pending", title: "Add telemetry" }, "flat-slice-checklist"],
    ["create", "milestone", "M016", null, { id: "M016", source_alias: "M016-delivery", title: "Delivery" }, "flat-descriptor-milestone"],
    ["create", "slice", "M016/S01", null, { id: "S01", milestone_id: "M016", status: "pending", title: "Release candidate" }, "flat-slice-checklist"],
    ["preserve", "artifact", ".gsd/phases/01-foundation/NOTES.md", null, { reason: "unknown-phase-suffix" }, "flat-unknown-artifact-preserved"],
  ]);
  assert.deepEqual(diagnosisRows("gsd-flat"), [
    ["diagnosis-flat-wrong-parent-summary", "task-summary-parent-conflict", "flat-wrong-parent-summary"],
  ]);

  const hybrid = oracle("gsd-alias-hybrid");
  assert.deepEqual(sourceRows("gsd-alias-hybrid"), [
    [".gsd/milestones/M002-delivery/M002-ROADMAP.md", "gsd-hybrid-hierarchy", "mapped"],
    [".gsd/milestones/M003-platform/M003-ROADMAP.md", "gsd-hybrid-hierarchy", "unparsed"],
    [".gsd/milestones/M004-payments/M004-ROADMAP.md", "gsd-hybrid-hierarchy", "unparsed"],
    [".gsd/milestones/M007-abc123/M007-abc123-ROADMAP.md", "gsd-hybrid-hierarchy", "unparsed"],
    [".gsd/milestones/M015-telemetry/M015-ROADMAP.md", "gsd-hybrid-hierarchy", "unparsed"],
    [".gsd/phases/01-foundation/01-ROADMAP.md", "gsd-hybrid-hierarchy", "mapped"],
    [".gsd/phases/03-platform/03-ROADMAP.md", "gsd-hybrid-hierarchy", "unparsed"],
    [".gsd/phases/03-services/03-ROADMAP.md", "gsd-hybrid-hierarchy", "unparsed"],
    [".gsd/phases/04-billing/04-ROADMAP.md", "gsd-hybrid-hierarchy", "unparsed"],
    [".gsd/phases/05-def456-team-search/05-ROADMAP.md", "gsd-hybrid-hierarchy", "mapped"],
    [".gsd/phases/07-abc123-alpha-team/07-ROADMAP.md", "gsd-hybrid-hierarchy", "unparsed"],
    [".gsd/phases/15-observability/15-ROADMAP.md", "gsd-hybrid-hierarchy", "unparsed"],
  ]);
  assert.deepEqual(changeRows("gsd-alias-hybrid"), [
    ["create", "milestone", "M001", null, { id: "M001", layout: "flat", title: "Flat foundation" }, "hybrid-non-overlap"],
    ["create", "slice", "M001/S01", null, { id: "S01", milestone_id: "M001", status: "pending", title: "Core setup" }, "hybrid-non-overlap"],
    ["create", "milestone", "M002", null, { id: "M002", layout: "nested", title: "Nested delivery" }, "hybrid-non-overlap"],
    ["create", "slice", "M002/S01", null, { id: "S01", milestone_id: "M002", status: "pending", title: "Ship candidate" }, "hybrid-non-overlap"],
    ["create", "milestone", "M005-def456", null, { id: "M005-def456", layout: "flat", title: "Team search" }, "hybrid-non-overlap-team-id"],
    ["create", "slice", "M005-def456/S01", null, { id: "S01", milestone_id: "M005-def456", status: "pending", title: "Index records" }, "hybrid-non-overlap-team-id"],
  ]);
  assert.deepEqual(diagnosisRows("gsd-alias-hybrid"), [
    ["diagnosis-hybrid-ambiguous-m003-path", "ambiguous-path", "hybrid-flat-m003-services"],
    ["diagnosis-hybrid-ambiguous-team-m007", "ambiguous-team-milestone-alias", "hybrid-nested-m007-abc123"],
    ["diagnosis-hybrid-content-m004", "hybrid-conflicting-content", "hybrid-nested-m004"],
    ["diagnosis-hybrid-duplicate-m003", "duplicate-logical-milestone", "hybrid-nested-m003"],
    ["diagnosis-hybrid-duplicate-m015", "duplicate-logical-milestone", "hybrid-nested-m015"],
    ["diagnosis-hybrid-status-m004", "hybrid-conflicting-status", "hybrid-nested-m004"],
  ]);
  assert.ok(
    hybrid.resolutions.every(
      (resolution) => resolution.disposition === "requires-user" && !("target" in resolution),
    ),
  );

  assert.ok(targetKeys("registries").includes("D001"));
  assert.ok(targetKeys("registries").includes("D002"));
  assert.ok(targetKeys("registries").includes("R001"));
  assert.ok(targetKeys("registries").includes("NET-01"));
  assert.deepEqual(
    oracle("registries").changes
      .filter((change) => change.action === "create")
      .map((change) => change.target.key)
      .sort(),
    ["D001", "D002", "NET-01", "R001", "R030", "R040"],
  );
  assert.deepEqual(diagnosisCodes("registries").sort(), [
    "duplicate-requirement-id",
    "freeform-decision-content",
    "invalid-decision-id",
    "invalid-made-by",
    "invalid-requirement-id",
    "requirement-status-conflict",
  ]);
  const registryProjection = (caseName: "registries" | "registries-lowercase") =>
    oracle(caseName).changes
      .filter((change) => change.action === "create")
      .map((change) => ({
        target: change.target,
        normalized: change.normalized,
        reason: change.reason_code,
      }));
  assert.deepEqual(changeRows("registries"), [
    ["create", "decision", "D001", null, { id: "D001", when_context: "M001", scope: "storage", decision: "Choose persistence", choice: "SQLite", rationale: "Local durable authority", revisable: "No", made_by: "agent", superseded_by: "D002" }, "canonical-seven-column-decision"],
    ["create", "decision", "D002", null, { id: "D002", when_context: "M002", scope: "storage", decision: "Refine persistence (amends D001)", choice: "WAL mode", rationale: "Safe concurrent reads", revisable: "Yes", made_by: "human", superseded_by: null }, "canonical-eight-column-decision"],
    ["preserve", "legacy-decision-row", "D003", null, { id: "D003", when_context: "M003", scope: "storage", decision: "Refine durability (amends D002)", choice: "Full sync", rationale: "Safer checkpoints", revisable: "Yes", amends: "D002", unresolved_field: "made_by" }, "invalid-made-by-preserved"],
    ["preserve", "legacy-decision-fragment", ".gsd/DECISIONS.md#freeform", null, { path: ".gsd/DECISIONS.md", fragment: "freeform", preservation: "verbatim" }, "freeform-decision-content-preserved"],
    ["create", "requirement", "NET-01", null, { id: "NET-01", class: "", status: "validated", description: "The offline handoff path has executable proof.", why: "", source: "", primary_owner: "", supporting_slices: "", validation: "M002/S01", notes: "Focused handoff test passed." }, "categorical-requirement-id"],
    ["create", "requirement", "R001", null, { id: "R001", class: "core-capability", status: "active", description: "Persist workflow truth in one local database.", why: "Agents must resume without projection drift.", source: "user", primary_owner: "M001/S01", supporting_slices: "M001/S02", validation: "unmapped", notes: "Markdown is a projection." }, "canonical-active-requirement"],
    ["create", "requirement", "R030", null, { id: "R030", class: "", status: "deferred", description: "Replicate canonical state to another machine.", why: "", source: "", primary_owner: "none", supporting_slices: "none", validation: "unmapped", notes: "" }, "requirement-field-aliases-normalized"],
    ["create", "requirement", "R040", null, { id: "R040", class: "", status: "out-of-scope", description: "Do not require a hosted service.", why: "", source: "", primary_owner: "none", supporting_slices: "none", validation: "n/a", notes: "" }, "canonical-out-of-scope-requirement"],
  ]);
  assert.deepEqual(registryProjection("registries-lowercase"), registryProjection("registries"));
  assert.deepEqual(
    semanticChange("registries-lowercase", "D003"),
    semanticChange("registries", "D003"),
  );
  assert.deepEqual(
    semanticChange("registries-lowercase", ".gsd/decisions.md#freeform"),
    {
      action: "preserve",
      target: { kind: "legacy-decision-fragment", key: ".gsd/decisions.md#freeform" },
      normalized: { path: ".gsd/decisions.md", fragment: "freeform", preservation: "verbatim" },
      reason: "freeform-decision-content-preserved",
    },
  );
  assert.deepEqual(sourcePaths("registries"), [".gsd/DECISIONS.md", ".gsd/REQUIREMENTS.md"]);
  assert.deepEqual(sourcePaths("registries-lowercase"), [".gsd/decisions.md", ".gsd/requirements.md"]);
  assert.deepEqual(diagnosisCodes("registries-lowercase"), diagnosisCodes("registries"));
  for (const caseName of ["registries", "registries-lowercase"] as const) {
    assert.ok(
      oracle(caseName).resolutions
        .filter((resolution) => resolution.disposition === "requires-user")
        .every((resolution) => !("target" in resolution)),
    );
  }

  const lifecycle = oracle("lifecycle-truth-matrix");
  assert.ok(sourcePaths("lifecycle-truth-matrix").includes(".gsd/gsd.db"));
  assert.ok(sourcePaths("lifecycle-truth-matrix").includes(".gsd/state-manifest.json"));
  assert.ok(sourcePaths("lifecycle-truth-matrix").includes(".gsd/milestones/M003/M003-PARKED.md"));
  assert.ok(sourcePaths("lifecycle-truth-matrix").includes(".gsd/milestones/M004/slices/S01/tasks/T01/T01-SUMMARY.md"));
  assert.deepEqual(changeRows("lifecycle-truth-matrix"), [
    ["create", "milestone-status", "M002", null, "complete", "all-roadmap-slices-checked"],
    ["preserve", "legacy-evidence", "M001/structured-status", null, { status: "active", authority: "state-manifest" }, "structured-lifecycle-conflict-evidence"],
    ["preserve", "legacy-evidence", "M001/S02/structured-status", null, { status: "active", authority: "state-manifest" }, "adopted-lifecycle-authority"],
    ["preserve", "legacy-evidence", "M001/S02/depends-column", null, { representation: "database slices.depends", value: ["S00"] }, "dependency-conflict-raw-evidence"],
    ["preserve", "legacy-evidence", "M001/S02/dependency-junction", null, { representation: "database slice_dependencies", value: ["S99"] }, "dependency-conflict-raw-evidence"],
    ["create", "task-status", "M001/S01/T02", null, "complete", "flat-checkbox-complete"],
    ["create", "task", "M001/S02/T01", "full_summary_md", "# Canonical summary\n\nFull Markdown retained.", "manifest-task-full-summary-preserved"],
    ["create", "task", "M001/S02/T01", "narrative", "Canonical narrative retained from the manifest.", "manifest-task-narrative-preserved"],
    ["create", "task-status", "M001/S02/T02", null, "cancelled", "legacy-skipped-means-cancelled"],
    ["create", "task-status", "M001/S02/T01", null, "active", "manifest-task-status"],
    ["preserve", "legacy-artifact", ".gsd/milestones/M001/slices/S02/S02-SUMMARY.md", "full_summary_md", { structured_value: null, preservation: "verbatim-artifact" }, "markdown-task-full-summary-md-loss"],
    ["preserve", "legacy-artifact", ".gsd/milestones/M001/slices/S01/tasks/T01/T01-PLAN.md", "narrative", { structured_value: null, preservation: "verbatim-artifact" }, "markdown-task-narrative-loss"],
    ["preserve", "legacy-evidence", "M001/summary-status", null, { status: "complete", authority: "summary-projection" }, "milestone-summary-precedence"],
    ["create", "task-status", "M001/S01/T01", null, "pending", "nested-task-requires-matching-summary"],
    ["create", "milestone-status", "M003", null, "parked", "parked-marker-without-summary"],
    ["create", "slice", "M001/S03", null, { status: "pending", is_sketch: true, task_count: 0 }, "sketch-slice-has-no-task-inference"],
    ["create", "slice-status", "M004/S01", null, "complete", "all-tasks-complete-with-slice-summary"],
    ["create", "task-status", "M004/S01/T01", null, "complete", "matching-task-summary-attestation"],
    ["create", "task-status", "M004/S01/T02", null, "complete", "flat-checkbox-complete"],
  ]);
  assert.deepEqual(diagnosisCodes("lifecycle-truth-matrix").sort(), [
    "checkbox-only-completion-advisory",
    "incomplete-success-signal",
    "markdown-task-full-summary-md-loss",
    "markdown-task-narrative-loss",
    "projection-conflicts-with-adopted-lifecycle",
    "projection-conflicts-with-adopted-lifecycle",
    "slice-summary-upgrades-unchecked-roadmap",
    "slices-depends-vs-slice-dependencies-conflict",
    "summary-overrides-unchecked-task",
    "task-summary-parent-conflict",
  ]);
  assert.ok(
    lifecycle.changes.every(
      (change) =>
        change.action === "preserve" ||
        (change.target.key !== "M001" && change.target.key !== "M001/S02"),
    ),
  );
  assert.ok(
    lifecycle.resolutions.some(
      (resolution) =>
        resolution.diagnosis_id === "diagnosis-dependency-representation-conflict" &&
        resolution.disposition === "requires-user" &&
        !("target" in resolution),
    ),
  );
  const dependencyDiagnosis = lifecycle.diagnoses.find(
    (diagnosis) => diagnosis.diagnosis_id === "diagnosis-dependency-representation-conflict",
  );
  assert.deepEqual(
    dependencyDiagnosis && {
      code: dependencyDiagnosis.code,
      severity: dependencyDiagnosis.severity,
      sourceId: dependencyDiagnosis.source_id,
      rawValue: dependencyDiagnosis.raw_value,
      message: dependencyDiagnosis.message,
    },
    {
      code: "slices-depends-vs-slice-dependencies-conflict",
      severity: "blocker",
      sourceId: "lifecycle-dependency-database",
      rawValue: {
        redacted: true,
        sha256: "sha256:5c06606b31c31c3dfab03ce04ee502731830f6220178e10b5d006815de8b06ba",
      },
      message:
        "The database slices.depends column conflicts with the database slice_dependencies junction row; both representations are preserved.",
    },
  );

  const assessments = oracle("assessment-matrix");
  assert.ok(sourcePaths("assessment-matrix").includes(".gsd/state-manifest.json"));
  assert.ok(sourcePaths("assessment-matrix").includes(".gsd/milestones/M001/slices/S08/S08-BACKFILL-ASSESSMENT.md"));
  assert.ok(sourcePaths("assessment-matrix").includes(".gsd/milestones/M001/M001-VALIDATION.md"));
  assert.deepEqual(
    readManifest(`${corpusPath}assessment-matrix/source`)?.assessments,
    [
      {
        path: "milestones/M001/slices/S01/S01-ASSESSMENT.md",
        milestone_id: "M001",
        slice_id: "S01",
        task_id: null,
        status: "pass",
        scope: "run-uat",
        full_content: "**Verdict:** PASS\n\nStructured UAT passed.",
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        path: "milestones/M001/slices/S02/S02-ASSESSMENT.md",
        milestone_id: "M001",
        slice_id: "S02",
        task_id: null,
        status: "passed",
        scope: "run-uat",
        full_content: "**Verdict:** PASSED\n\nLegacy passed alias.",
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        path: "milestones/M001/slices/S03/S03-ASSESSMENT.md",
        milestone_id: "M001",
        slice_id: "S03",
        task_id: null,
        status: "fail",
        scope: "run-uat",
        full_content: "**Verdict:** FAIL\n\nStructured UAT failed.",
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        path: "milestones/M001/slices/S04/S04-ASSESSMENT.md",
        milestone_id: "M001",
        slice_id: "S04",
        task_id: null,
        status: "partial",
        scope: "run-uat",
        full_content: "**Verdict:** PARTIAL\n\nOne check passed and one failed.",
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        path: "milestones/M001/M001-VALIDATION.md",
        milestone_id: "M001",
        slice_id: null,
        task_id: null,
        status: "needs-attention",
        scope: "milestone-validation",
        full_content:
          "**Verdict:** NEEDS ATTENTION\n\nStructured milestone validation requires attention.",
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        path: "milestones/M010/slices/S01/S01-ASSESSMENT.md",
        milestone_id: "M010",
        slice_id: "S01",
        task_id: null,
        status: "pass",
        scope: "run-uat",
        full_content: "**Verdict:** PASS\n\nClean structured UAT passed.",
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        path: "milestones/M010/M010-VALIDATION.md",
        milestone_id: "M010",
        slice_id: null,
        task_id: null,
        status: "pass",
        scope: "milestone-validation",
        full_content: "**Verdict:** PASS\n\nClean structured milestone validation passed.",
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ],
  );
  assert.deepEqual(changeRows("assessment-matrix"), [
    ["preserve", "legacy-artifact", "M001/S08/backfill-assessment", null, { verdict: "pass", authority: "artifact-only" }, "fabricated-backfill-placeholder-not-uat"],
    ["create", "assessment", "M010/milestone-validation", null, { scope: "milestone-validation", verdict: "pass", authority: "structured" }, "structured-milestone-validation"],
    ["create", "assessment", "M010/S01/run-uat", null, { scope: "run-uat", verdict: "pass", authority: "structured" }, "structured-run-uat"],
    ["preserve", "legacy-evidence", "M001/structured-milestone-validation-evidence", null, { scope: "milestone-validation", verdict: "needs-attention", authority: "structured" }, "structured-conflict-evidence"],
    ["preserve", "legacy-artifact", "M001/S05/assessment-artifact", null, { verdict: null, authority: "artifact-only" }, "invalid-partial-verdict"],
    ["preserve", "legacy-artifact", "M001/S06/assessment-artifact", null, { verdict: null, authority: "artifact-only" }, "malformed-assessment-verdict"],
    ["preserve", "legacy-artifact", "M001/S07/assessment-artifact", null, { verdict: null, authority: "artifact-only" }, "missing-assessment-verdict"],
    ["preserve", "legacy-artifact", "M001/roadmap-assessment", null, { verdict: "pass", authority: "planning-only" }, "roadmap-assessment-not-uat"],
    ["create", "assessment", "M001/S03/run-uat", null, { scope: "run-uat", verdict: "fail", authority: "structured" }, "structured-run-uat"],
    ["create", "assessment", "M001/S04/run-uat", null, { scope: "run-uat", verdict: "partial", authority: "structured", result_shape: "mixed" }, "structured-run-uat"],
    ["preserve", "legacy-evidence", "M001/S01/structured-run-uat-evidence", null, { scope: "run-uat", verdict: "pass", authority: "structured", conflicted: true }, "structured-run-uat"],
    ["create", "assessment", "M001/S02/run-uat", null, { scope: "run-uat", verdict: "pass", authority: "structured", legacy_verdict: "passed" }, "legacy-passed-normalized-to-pass"],
    ["preserve", "legacy-artifact", "M001/S01/assessment-artifact", null, { verdict: "fail", authority: "artifact-only", precedence: 1 }, "assessment-artifact-not-structured-authority"],
    ["preserve", "legacy-artifact", "M001/S01/uat-artifact", null, { verdict: "pass", authority: "artifact-only", precedence: 2 }, "uat-artifact-secondary-to-assessment"],
    ["preserve", "legacy-artifact", "M001/file-only-validation", null, { verdict: "pass", authority: "artifact-only" }, "file-validation-not-authority"],
  ]);
  assert.deepEqual(diagnosisCodes("assessment-matrix"), [
    "fabricated-backfill-placeholder-not-uat",
    "file-validation-not-authority",
    "invalid-partial-verdict",
    "malformed-assessment-verdict",
    "missing-assessment-verdict",
    "roadmap-assessment-not-uat",
    "structured-assessment-vs-artifact-conflict",
    "structured-milestone-validation-vs-artifact-conflict",
    "uat-vs-assessment-conflict",
  ]);
  assert.ok(!targetKeys("assessment-matrix").includes("M001/S01/run-uat"));
  assert.ok(!targetKeys("assessment-matrix").includes("M001/milestone-validation"));
  assert.ok(
    assessments.resolutions
      .filter((resolution) => resolution.disposition === "requires-user")
      .every((resolution) => !("target" in resolution)),
  );

  const sources = cases.flatMap((corpusCase) => corpusCase.oracle.sources);
  assert.deepEqual(
    [...new Set(sources.map((source) => source.parser_id))].sort(),
    [
      "gsd-artifact-classifier",
      "gsd-assessment-truth",
      "gsd-decisions-table",
      "gsd-flat-hierarchy",
      "gsd-hybrid-hierarchy",
      "gsd-lifecycle-truth",
      "gsd-nested-hierarchy",
      "gsd-requirements-sections",
      "gsd-sqlite-target",
    ],
  );
});

test("legacy corpus supplemental preserves evidence without replay or filesystem mutation", async () => {
  const corpusRoot = new URL("./__fixtures__/legacy-import-corpus/v1/", import.meta.url);
  const caseNames = [
    "jsonl-history",
    "custom-workflow",
    "knowledge-graph",
    "worktree-topology",
  ] as const;
  const cases = caseNames.map((caseName) => loadLegacyImportCorpusCase(corpusRoot, caseName));
  for (const corpusCase of cases) validateLegacyImportCorpusCase(corpusCase);

  const byName = new Map(cases.map((corpusCase) => [corpusCase.name, corpusCase.oracle]));
  const oracle = (caseName: (typeof caseNames)[number]) => {
    const result = byName.get(caseName);
    assert.ok(result, `missing ${caseName}`);
    return result;
  };
  const sourceRows = (caseName: (typeof caseNames)[number]) =>
    oracle(caseName).sources.map((source) => [source.path, source.parser_id, source.outcome]);
  const changeRows = (caseName: (typeof caseNames)[number]) =>
    oracle(caseName).changes.map((change) => [
      change.change_id,
      change.action,
      change.target.kind,
      change.target.key,
      change.target.field ?? null,
      change.reason_code,
    ]);
  const diagnosisRows = (caseName: (typeof caseNames)[number]) =>
    oracle(caseName).diagnoses.map((diagnosis) => [
      diagnosis.diagnosis_id,
      diagnosis.code,
      diagnosis.severity,
      diagnosis.source_id,
    ]);
  const semanticHash = (caseName: (typeof caseNames)[number]) => legacyImportCorpusHash(
    oracle(caseName).changes.map((change) => ({
      action: change.action,
      target: change.target,
      normalized: change.normalized,
      reason: change.reason_code,
    })),
  );
  const fingerprints = () => caseNames.flatMap((caseName) => {
    const corpusCase = loadLegacyImportCorpusCase(corpusRoot, caseName);
    return corpusCase.files.map((file) => [caseName, file.path, file.entryKind, file.sha256]);
  });
  const before = fingerprints();

  assert.deepEqual(sourceRows("jsonl-history"), [
    ["$GSD_STATE_DIR/projects/project-a/worktrees/M004/.gsd/event-log.jsonl", "gsd-workflow-events", "preserved"],
    [".gsd-worktrees/M002/.gsd/event-log.jsonl", "gsd-workflow-events", "preserved"],
    [".gsd-worktrees/M005/.gsd/event-log.jsonl", "gsd-workflow-events", "ignored-with-reason"],
    [".gsd/doctor-history.jsonl", "legacy-jsonl-exclusion", "ignored-with-reason"],
    [".gsd/event-log-M001.jsonl.archived", "gsd-workflow-events", "preserved"],
    [".gsd/event-log-M999.jsonl.archived", "gsd-workflow-events", "unparsed"],
    [".gsd/event-log.jsonl", "gsd-workflow-events", "preserved"],
    [".gsd/worktrees/M003/.gsd/event-log.jsonl", "gsd-workflow-events", "preserved"],
  ]);
  assert.deepEqual(changeRows("jsonl-history"), [
    ["history-active-001", "preserve", "legacy-workflow-event", ".gsd/event-log.jsonl#L001", null, "history-evidence-only"],
    ["history-active-002", "preserve", "legacy-workflow-event", ".gsd/event-log.jsonl#L002", null, "history-evidence-only"],
    ["history-active-003", "preserve", "legacy-workflow-event", ".gsd/event-log.jsonl#L003", null, "adopted-history-evidence-only"],
    ["history-active-004", "preserve", "legacy-workflow-event", ".gsd/event-log.jsonl#L004", null, "unadopted-history-evidence-only"],
    ["history-active-005", "preserve", "legacy-workflow-event", ".gsd/event-log.jsonl#L005", null, "duplicate-history-evidence-preserved"],
    ["history-active-006", "preserve", "legacy-workflow-event", ".gsd/event-log.jsonl#L006", null, "out-of-order-history-evidence-preserved"],
    ["history-active-007", "preserve", "legacy-workflow-event", ".gsd/event-log.jsonl#L007", null, "unknown-history-event-preserved"],
    ["history-archive-001", "preserve", "legacy-workflow-event", ".gsd/event-log-M001.jsonl.archived#L001", null, "archived-history-evidence-only"],
    ["history-archive-002", "preserve", "legacy-workflow-event", ".gsd/event-log-M001.jsonl.archived#L002", null, "archived-history-evidence-only"],
    ["history-canonical-worktree-001", "preserve", "legacy-workflow-event", ".gsd-worktrees/M002/.gsd/event-log.jsonl#L001", null, "fork-base-history-preserved"],
    ["history-canonical-worktree-002", "preserve", "legacy-workflow-event", ".gsd-worktrees/M002/.gsd/event-log.jsonl#L002", null, "fork-branch-history-preserved"],
    ["history-external-worktree-001", "preserve", "legacy-workflow-event", "$GSD_STATE_DIR/projects/project-a/worktrees/M004/.gsd/event-log.jsonl#L001", null, "external-worktree-history-evidence-only"],
    ["history-legacy-worktree-001", "preserve", "legacy-workflow-event", ".gsd/worktrees/M003/.gsd/event-log.jsonl#L001", null, "fork-base-history-preserved"],
    ["history-legacy-worktree-002", "preserve", "legacy-workflow-event", ".gsd/worktrees/M003/.gsd/event-log.jsonl#L002", null, "fork-branch-history-preserved"],
  ]);
  assert.deepEqual(diagnosisRows("jsonl-history"), [
    ["diagnosis-corrupt-line", "corrupt-jsonl-line", "warning", "history-corrupt-m999"],
    ["diagnosis-duplicate-event", "duplicate-event-hash", "info", "history-active"],
    ["diagnosis-empty-worktree-ledger", "empty-worktree-ledger-excluded", "info", "history-empty-m005"],
    ["diagnosis-history-fork-canonical", "history-fork-preserved", "info", "history-canonical-m002"],
    ["diagnosis-history-fork-legacy", "history-fork-preserved", "info", "history-legacy-m003"],
    ["diagnosis-non-workflow-jsonl", "non-workflow-jsonl-excluded", "info", "history-doctor-exclusion"],
    ["diagnosis-out-of-order-event", "out-of-order-event", "warning", "history-active"],
    ["diagnosis-secret-shaped-history", "secret-shaped-history-evidence", "warning", "history-active"],
    ["diagnosis-unknown-command", "unknown-workflow-command", "warning", "history-active"],
  ]);

  assert.deepEqual(sourceRows("custom-workflow"), [
    [".gsd/workflow-defs/collision.yaml", "gsd-workflow-definition", "ignored-with-reason"],
    [".gsd/workflow-defs/legacy-alias.yaml", "gsd-workflow-definition", "preserved"],
    [".gsd/workflow-runs/complete/2026-01-01T00-00-00/DEFINITION.yaml", "gsd-workflow-run-graph", "preserved"],
    [".gsd/workflow-runs/complete/2026-01-01T00-00-00/GRAPH.yaml", "gsd-workflow-run-graph", "preserved"],
    [".gsd/workflow-runs/drift/2026-01-02T00-00-00/DEFINITION.yaml", "gsd-workflow-run-graph", "preserved"],
    [".gsd/workflow-runs/drift/2026-01-02T00-00-00/GRAPH.yaml", "gsd-workflow-run-graph", "preserved"],
    [".gsd/workflow-runs/malformed/2026-01-05T00-00-00/DEFINITION.yaml", "gsd-workflow-run-graph", "preserved"],
    [".gsd/workflow-runs/malformed/2026-01-05T00-00-00/GRAPH.yaml", "gsd-workflow-run-graph", "unparsed"],
    [".gsd/workflow-runs/missing/2026-01-04T00-00-00/DEFINITION.yaml", "gsd-workflow-run-graph", "preserved"],
    [".gsd/workflow-runs/missing/2026-01-04T00-00-00/PARAMS.json", "gsd-workflow-run-graph", "preserved"],
    [".gsd/workflow-runs/partial/2026-01-03T00-00-00/DEFINITION.yaml", "gsd-workflow-run-graph", "preserved"],
    [".gsd/workflow-runs/partial/2026-01-03T00-00-00/GRAPH.yaml", "gsd-workflow-run-graph", "preserved"],
    [".gsd/workflow-runs/partial/2026-01-03T00-00-00/PARAMS.json", "gsd-workflow-run-graph", "preserved"],
    [".gsd/workflow-runs/unknown/2026-01-06T00-00-00/DEFINITION.yaml", "gsd-workflow-run-graph", "preserved"],
    [".gsd/workflow-runs/unknown/2026-01-06T00-00-00/GRAPH.yaml", "gsd-workflow-run-graph", "unparsed"],
    [".gsd/workflows/bugfix.md", "gsd-workflow-definition", "preserved"],
    [".gsd/workflows/collision.yaml", "gsd-workflow-definition", "preserved"],
    [".gsd/workflows/drift.yaml", "gsd-workflow-definition", "preserved"],
    [".gsd/workflows/malformed.yaml", "gsd-workflow-definition", "unparsed"],
    [".gsd/workflows/phased.md", "gsd-workflow-definition", "preserved"],
    [".gsd/workflows/schema-invalid.yaml", "gsd-workflow-definition", "unparsed"],
    [".gsd/workflows/unknown-field.yml", "gsd-workflow-definition", "preserved"],
    ["gsd-home/workflows/collision.yaml", "gsd-workflow-definition", "ignored-with-reason"],
    ["gsd-home/workflows/global-only.yaml", "gsd-workflow-definition", "preserved"],
  ]);
  assert.deepEqual(changeRows("custom-workflow").map((row) => row[3]), [
    "gsd-home/workflows/global-only.yaml",
    ".gsd/workflow-defs/legacy-alias.yaml",
    ".gsd/workflow-runs/complete/2026-01-01T00-00-00/DEFINITION.yaml",
    ".gsd/workflow-runs/complete/2026-01-01T00-00-00/GRAPH.yaml",
    ".gsd/workflow-runs/drift/2026-01-02T00-00-00/DEFINITION.yaml",
    ".gsd/workflow-runs/drift/2026-01-02T00-00-00/GRAPH.yaml",
    ".gsd/workflow-runs/malformed/2026-01-05T00-00-00/DEFINITION.yaml",
    ".gsd/workflow-runs/missing/2026-01-04T00-00-00/DEFINITION.yaml",
    ".gsd/workflow-runs/missing/2026-01-04T00-00-00/PARAMS.json",
    ".gsd/workflow-runs/partial/2026-01-03T00-00-00/DEFINITION.yaml",
    ".gsd/workflow-runs/partial/2026-01-03T00-00-00/GRAPH.yaml",
    ".gsd/workflow-runs/partial/2026-01-03T00-00-00/PARAMS.json",
    ".gsd/workflow-runs/unknown/2026-01-06T00-00-00/DEFINITION.yaml",
    ".gsd/workflows/bugfix.md",
    ".gsd/workflows/collision.yaml",
    ".gsd/workflows/drift.yaml",
    ".gsd/workflows/phased.md",
    ".gsd/workflows/unknown-field.yml",
  ]);
  assert.deepEqual(diagnosisRows("custom-workflow").map((row) => row.slice(0, 3)), [
    ["definition-bundled-shadowed", "lower-precedence-workflow-shadowed", "info"],
    ["definition-global-collision-ignored", "lower-precedence-workflow-ignored", "info"],
    ["definition-legacy-collision-ignored", "lower-precedence-workflow-ignored", "info"],
    ["definition-malformed", "malformed-workflow-definition", "warning"],
    ["definition-schema-invalid", "unsupported-workflow-definition-version", "warning"],
    ["run-definition-drift", "workflow-definition-drift", "warning"],
    ["run-malformed-graph", "malformed-workflow-graph", "warning"],
    ["run-missing-graph", "missing-workflow-graph", "warning"],
    ["run-secret-parameter-redacted", "sensitive-workflow-parameter", "warning"],
    ["run-unknown-status", "unknown-workflow-step-status", "warning"],
  ]);

  assert.deepEqual(sourceRows("knowledge-graph"), [
    [".gsd/KNOWLEDGE.md", "gsd-knowledge-graph", "preserved"],
    [".gsd/graphs/.last-build-snapshot.json", "gsd-knowledge-graph", "unparsed"],
    [".gsd/graphs/graph.json", "gsd-knowledge-graph", "preserved"],
    [".gsd/milestones/M001/M001-LEARNINGS.md", "gsd-knowledge-graph", "preserved"],
    [".gsd/phases/02-legacy/02-LEARNINGS.md", "gsd-knowledge-graph", "ignored-with-reason"],
  ]);
  assert.deepEqual(changeRows("knowledge-graph"), [
    ["change-knowledge-derived-graph", "preserve", "legacy-knowledge-graph-snapshot", ".gsd/graphs/graph.json", null, "derived-graph-preserved-without-rebuild"],
    ["change-knowledge-nested-learnings", "preserve", "legacy-knowledge-source", "M001-LEARNINGS", null, "nested-learnings-preserved"],
    ["change-knowledge-root", "preserve", "legacy-knowledge-source", ".gsd/KNOWLEDGE.md", null, "knowledge-markdown-preserved"],
  ]);
  assert.deepEqual(diagnosisRows("knowledge-graph").map((row) => row.slice(0, 3)), [
    ["diagnosis-derived-graph-source-conflict", "derived-graph-source-conflict", "warning"],
    ["diagnosis-graph-source-missing", "graph-source-missing", "warning"],
    ["diagnosis-legacy-flat-learnings-not-read", "legacy-flat-learnings-not-read", "info"],
    ["diagnosis-malformed-graph-snapshot", "malformed-graph-snapshot", "warning"],
  ]);

  assert.deepEqual(sourceRows("worktree-topology"), [
    ["active-guard/project/.gsd/PREFERENCES.md", "gsd-worktree-topology", "preserved"],
    ["active-guard/project/.gsd/worktrees/M006/git-marker.txt", "gsd-worktree-topology", "preserved"],
    ["canonical/project/.gsd-worktrees/M001/git-marker.txt", "gsd-worktree-topology", "preserved"],
    ["duplicate-identity/project/.gsd-worktrees/M005", "gsd-worktree-topology", "preserved"],
    ["duplicate-identity/project/.gsd/worktrees/M005", "gsd-worktree-topology", "ignored-with-reason"],
    ["duplicate-identity/shared/M005/git-marker.txt", "gsd-worktree-topology", "preserved"],
    ["external/project/.gsd", "gsd-worktree-topology", "preserved"],
    ["external/state/projects/project-hash/worktrees/M003/git-marker.txt", "gsd-worktree-topology", "preserved"],
    ["interrupted-conflict/project/.gsd.migrating/PREFERENCES.md", "gsd-worktree-topology", "preserved"],
    ["interrupted-conflict/project/.gsd/PREFERENCES.md", "gsd-worktree-topology", "preserved"],
    ["interrupted/project/.gsd.migrating/PREFERENCES.md", "gsd-worktree-topology", "preserved"],
    ["legacy/project/.gsd/worktrees/M002/git-marker.txt", "gsd-worktree-topology", "preserved"],
    ["malformed/project/.gsd-worktrees/M008/git-marker.txt", "gsd-worktree-topology", "unparsed"],
    ["root-conflict/project/.gsd-worktrees/M004/git-marker.txt", "gsd-worktree-topology", "preserved"],
    ["root-conflict/project/.gsd/worktrees/M004/git-marker.txt", "gsd-worktree-topology", "preserved"],
    ["stale-canonical/project/.gsd-worktrees/M007/README.txt", "gsd-worktree-topology", "ignored-with-reason"],
    ["stale-canonical/project/.gsd/worktrees/M007/git-marker.txt", "gsd-worktree-topology", "preserved"],
  ]);
  assert.deepEqual(changeRows("worktree-topology").map((row) => row[3]), [
    "active-guard/project-state",
    "active-guard/M006",
    "canonical/M001",
    "duplicate-identity/M005/canonical",
    "duplicate-identity/M005/physical",
    "external/M003",
    "external/project-state-link",
    "interrupted-conflict/current",
    "interrupted-conflict/staging",
    "interrupted/staging",
    "legacy/M002",
    "root-conflict/M004/canonical",
    "root-conflict/M004/legacy",
    "stale-canonical/M007/legacy",
  ]);
  assert.deepEqual(diagnosisRows("worktree-topology").map((row) => row.slice(0, 3)), [
    ["diagnosis-active-worktree-guard", "active-worktree-migration-guard", "info"],
    ["diagnosis-duplicate-physical-identity", "duplicate-physical-identity", "info"],
    ["diagnosis-interrupted-migration", "interrupted-migration", "warning"],
    ["diagnosis-interrupted-root-conflict", "interrupted-migration-root-conflict", "blocker"],
    ["diagnosis-malformed-git-marker", "malformed-git-marker", "warning"],
    ["diagnosis-root-conflict", "canonical-legacy-root-conflict", "blocker"],
    ["diagnosis-stale-canonical", "stale-canonical-does-not-shadow-legacy", "info"],
  ]);

  assert.deepEqual(caseNames.map((caseName) => semanticHash(caseName)), [
    "sha256:7a8577e612620e2fd48d3d5f6b7b78a0c4fcc057f43481e32eb32668212c7ae5",
    "sha256:4c5e58c6769ba8a0df6164d991afc5d8d36b4c0d29e32fc7b07f9c385288ab66",
    "sha256:618e2fffe915053eb829179e87af1081517f1d2bfb4c8ce36d8f910f1a323565",
    "sha256:3955cc04bb609320fbc33beaec578a8fe2ae2bf333aa1b8116fe3d2fb7ebb2a7",
  ]);
  assert.deepEqual(
    caseNames.map((caseName) => {
      const value = oracle(caseName);
      return [
        legacyImportCorpusHash(value.sources),
        legacyImportCorpusHash(value.changes),
        legacyImportCorpusHash(value.diagnoses),
        legacyImportCorpusHash(value.resolutions),
      ];
    }),
    [
      [
        "sha256:95ab8976c4896dac47664994ebfda28ee7c0f6ccdc42cb093c9cb2c76c03a9d8",
        "sha256:16f75c063fffe96c74e098b2d99b370c793a43790f062c9fcefdfb7d14df6b69",
        "sha256:8e396672b2cc6ede21635cec6070909e96b76bef76dbba0cba53bc055669912b",
        "sha256:523d9537cc0c4564ee1a664c85b61c45b972c23f49bc7a587a3f084b48319ccc",
      ],
      [
        "sha256:5c516e6aa1b1e2d023d4e102d8ef2c9d9c46a07eec9d35c793170d4c55eeeb30",
        "sha256:1b9d8acf8df1c380596c2b68bb2a6bd446d12e78be98f4a1d7b2236189edb133",
        "sha256:c6deda53f479696cf617c300656e040e03fe89da85e35220eac89f7796694572",
        "sha256:5dc7bd17d903e37b156b6f4926d2a07bf735aff550ec2734330f35000ada3ba6",
      ],
      [
        "sha256:a7f5713ba6aff3f6aa8ee258d0743a1a3e58a6100235d55bb88e2de41da9c737",
        "sha256:b598ab41be378fbb1915df3bb03a99509cb3bc318f4cc452d47b6b034a6f7836",
        "sha256:bb489fd7b29f5a93ded05daaab99408de0774c7ad26971a8d91199aac8c1b621",
        "sha256:c4dd8e9335bdf8a11826b62bb9c7eca7b5bb74be966cf77af716b52890952f2b",
      ],
      [
        "sha256:88642e5dc3ae5e526aae037b739720f4d88b8a17710d3e79112d3b0d10fe80d5",
        "sha256:9da47ec6f3d6bf6302e57b0d0fe6402c59cd538b86da4d44dbd2ff01364e76d8",
        "sha256:aa8ca91795efd53982a0f2e2529555efa2fe81238e2145dae5edb623d85159d4",
        "sha256:b213d8d4b795372bb36178514a906098c7f62b7eda13532786097fc2ed62fb13",
      ],
    ],
  );
  assert.ok(cases.every((corpusCase) => corpusCase.oracle.changes.every((change) => change.action === "preserve")));
  assert.ok(cases.every((corpusCase) => corpusCase.oracle.sources.every((source) => source.outcome !== "mapped")));
  assert.ok(oracle("jsonl-history").changes.every(
    (change) => (change.normalized as Record<string, unknown>).replay_policy === "evidence-only",
  ));
  const sensitiveDiagnoses = [
    oracle("jsonl-history").diagnoses.find(
      (diagnosis) => diagnosis.diagnosis_id === "diagnosis-secret-shaped-history",
    ),
    oracle("custom-workflow").diagnoses.find(
      (diagnosis) => diagnosis.diagnosis_id === "run-secret-parameter-redacted",
    ),
  ];
  assert.deepEqual(sensitiveDiagnoses.map((diagnosis) => diagnosis?.raw_value), [
    {
      redacted: true,
      sha256: "sha256:3e2b17e2fb31af768f6807d754d8b428322d736f6f1bdaff961a7886ba9337e5",
    },
    {
      redacted: true,
      sha256: "sha256:ec356b4f7535bfb167550cba8c333a5fd3ab93bfd4cc7821236840aec193bcd0",
    },
  ]);
  assert.ok(sensitiveDiagnoses.every((diagnosis) => diagnosis !== undefined));
  assert.ok(!sensitiveDiagnoses[0]!.message.includes("fixture-token-1234"));
  assert.ok(!sensitiveDiagnoses[1]!.message.includes("synthetic-token-workflow-2026"));
  assert.deepEqual(
    oracle("worktree-topology").resolutions,
    [
      { diagnosis_id: "diagnosis-active-worktree-guard", disposition: "preserved" },
      {
        diagnosis_id: "diagnosis-duplicate-physical-identity",
        disposition: "mapped",
        target: { kind: "legacy-worktree-topology", key: "duplicate-identity/M005/canonical" },
      },
      { diagnosis_id: "diagnosis-interrupted-migration", disposition: "preserved" },
      { diagnosis_id: "diagnosis-interrupted-root-conflict", disposition: "requires-user" },
      { diagnosis_id: "diagnosis-malformed-git-marker", disposition: "preserved" },
      { diagnosis_id: "diagnosis-root-conflict", disposition: "requires-user" },
      {
        diagnosis_id: "diagnosis-stale-canonical",
        disposition: "mapped",
        target: { kind: "legacy-worktree-topology", key: "stale-canonical/M007/legacy" },
      },
    ],
  );
  const unresolved = cases.flatMap((corpusCase) => corpusCase.oracle.resolutions.filter(
    (resolution) => resolution.disposition === "requires-user",
  ));
  assert.deepEqual(unresolved.map((resolution) => resolution.diagnosis_id), [
    "diagnosis-interrupted-root-conflict",
    "diagnosis-root-conflict",
  ]);
  assert.ok(unresolved.every((resolution) => !("target" in resolution)));

  const corpusPath = fileURLToPath(corpusRoot);
  const historyRoot = join(corpusPath, "jsonl-history", "source");
  const activeHistory = readEvents(join(historyRoot, ".gsd", "event-log.jsonl"));
  const canonicalHistory = readEvents(join(historyRoot, ".gsd-worktrees", "M002", ".gsd", "event-log.jsonl"));
  const legacyHistory = readEvents(join(historyRoot, ".gsd", "worktrees", "M003", ".gsd", "event-log.jsonl"));
  assert.equal(activeHistory.length, 8);
  assert.equal(readEvents(join(historyRoot, ".gsd", "event-log-M999.jsonl.archived")).length, 0);
  assert.equal(findForkPoint(activeHistory, canonicalHistory), 0);
  assert.equal(findForkPoint(activeHistory, legacyHistory), 0);
  assert.equal(normalizeWorkflowEventCommand(activeHistory[0]?.cmd), "plan_milestone");
  assert.deepEqual(workflowEventEntityKey(activeHistory[0]!), { type: "milestone", id: "M001" });
  assert.equal(workflowEventEntityKey(activeHistory[6]!), null);
  assert.ok(!redactSecrets(JSON.stringify(activeHistory[7])).includes("fixture-token-1234"));
  assert.equal(
    resolveWorkflowEventLedgerLocation(join(historyRoot, ".gsd-worktrees", "M002")).isWorktree,
    true,
  );
  assert.equal(
    readWorktreeEventLogPath(join(historyRoot, ".gsd", "worktrees", "M003")),
    join(historyRoot, ".gsd", "worktrees", "M003", ".gsd", "event-log.jsonl"),
  );

  const workflowRoot = join(corpusPath, "custom-workflow", "source");
  const originalGsdHome = process.env.GSD_HOME;
  process.env.GSD_HOME = join(workflowRoot, "gsd-home");
  try {
    const plugins = discoverPlugins(workflowRoot);
    assert.deepEqual(
      ["bugfix", "collision", "global-only", "legacy-alias", "phased", "unknown-field"]
        .map((name) => {
          const plugin = plugins.get(name);
          assert.ok(plugin, `missing production plugin ${name}`);
          return [name, plugin.source, plugin.format, plugin.meta.displayName, plugin.meta.phases];
        }),
      [
        ["bugfix", "project", "md", "Project Bugfix Override", ["project-triage", "project-verify"]],
        ["collision", "project", "yaml", "collision-current-project", ["current"]],
        ["global-only", "global", "yaml", "global-only", ["global"]],
        ["legacy-alias", "project", "yaml", "legacy-alias", ["inspect", "report"]],
        ["phased", "project", "md", "Conversational Review", ["ask", "recommend", "validate"]],
        ["unknown-field", "project", "yaml", "unknown-field", ["preserve"]],
      ],
    );
  } finally {
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
  }
  const legacyDefinition = loadDefinitionFromFile(
    join(workflowRoot, ".gsd", "workflow-defs", "legacy-alias.yaml"),
  );
  assert.deepEqual(legacyDefinition.steps.map((step) => [step.id, step.requires]), [
    ["inspect", []],
    ["report", ["inspect"]],
  ]);
  assert.deepEqual(
    readGraph(join(workflowRoot, ".gsd", "workflow-runs", "complete", "2026-01-01T00-00-00"))
      .steps.map((step) => [step.id, step.status]),
    [["collect", "complete"], ["iterate", "expanded"]],
  );
  assert.deepEqual(listRuns(workflowRoot).map((run) => [run.name, run.status, run.steps]), [
    ["complete", "complete", { total: 2, completed: 1, pending: 0, active: 0 }],
    ["drift", "pending", { total: 2, completed: 0, pending: 2, active: 0 }],
    ["partial", "running", { total: 3, completed: 1, pending: 1, active: 1 }],
    ["unknown", "pending", { total: 1, completed: 0, pending: 0, active: 0 }],
  ]);

  const knowledgeRoot = join(corpusPath, "knowledge-graph", "source");
  assert.deepEqual(
    parseKnowledgeRows(readFileSync(join(knowledgeRoot, ".gsd", "KNOWLEDGE.md"), "utf8"))
      .map((row) => [row.table, row.id]),
    [["rules", "K001"], ["patterns", "P001"], ["lessons", "L001"]],
  );
  const graph = await graphQuery(knowledgeRoot, "Authority");
  assert.deepEqual(graph.nodes.map((node) => node.id), ["milestone:M001", "rule:K001", "lesson:M001:1"]);
  assert.deepEqual(graph.edges.map((edge) => [edge.from, edge.to, edge.type]), [
    ["milestone:M001", "lesson:M001:1", "relates_to"],
  ]);

  const topologySource = join(corpusPath, "worktree-topology", "source");
  const topologyRoot = mkdtempSync(join(tmpdir(), "gsd-t05-topology-"));
  try {
    cpSync(topologySource, topologyRoot, { recursive: true, verbatimSymlinks: true });
    for (const source of oracle("worktree-topology").sources) {
      if (!source.path.endsWith("/git-marker.txt")) continue;
      const descriptor = join(topologyRoot, source.path);
      renameSync(descriptor, join(dirname(descriptor), ".git"));
    }

    const canonicalProject = join(topologyRoot, "canonical", "project");
    const legacyProject = join(topologyRoot, "legacy", "project");
    const staleProject = join(topologyRoot, "stale-canonical", "project");
    const duplicateProject = join(topologyRoot, "duplicate-identity", "project");
    assert.deepEqual(worktreesDirs(canonicalProject), [
      canonicalWorktreesDir(canonicalProject),
      legacyWorktreesDir(canonicalProject),
    ]);
    assert.equal(worktreePathFor(canonicalProject, "M001"), join(canonicalProject, ".gsd-worktrees", "M001"));
    assert.equal(worktreePathFor(legacyProject, "M002"), join(legacyProject, ".gsd", "worktrees", "M002"));
    assert.equal(worktreePathFor(staleProject, "M007"), join(staleProject, ".gsd", "worktrees", "M007"));
    assert.equal(worktreePathFor(duplicateProject, "M005"), join(duplicateProject, ".gsd-worktrees", "M005"));
    assert.equal(
      normalizeWorktreePathForCompare(join(duplicateProject, ".gsd-worktrees", "M005")),
      normalizeWorktreePathForCompare(join(duplicateProject, ".gsd", "worktrees", "M005")),
    );
    assert.equal(
      realpathSync(join(duplicateProject, ".gsd-worktrees", "M005")),
      realpathSync(join(duplicateProject, ".gsd", "worktrees", "M005")),
    );

    const externalWorktree = join(topologyRoot, "external", "state", "projects", "project-hash", "worktrees", "M003");
    const originalStateDir = process.env.GSD_STATE_DIR;
    process.env.GSD_STATE_DIR = join(topologyRoot, "external", "state");
    try {
      assert.equal(isGsdWorktreePath(externalWorktree), true);
      assert.equal(projectRootFromWorktreePath(externalWorktree), join(topologyRoot, "external", "state", "projects", "project-hash"));
      assert.equal(
        resolveExternalStateProjectGsdFromWorktreePath(externalWorktree),
        join(topologyRoot, "external", "state", "projects", "project-hash"),
      );
      assert.equal(resolveExternalStateProjectIdentityFromWorktreePath(externalWorktree), "project-hash");
    } finally {
      if (originalStateDir === undefined) delete process.env.GSD_STATE_DIR;
      else process.env.GSD_STATE_DIR = originalStateDir;
    }
  } finally {
    rmSync(topologyRoot, { recursive: true, force: true });
  }

  assert.deepEqual(fingerprints(), before, "read-only production checks must not mutate corpus bytes");
});

test("legacy corpus capstone classifies database targets and changes without applying", () => {
  const corpusRoot = new URL("./__fixtures__/legacy-import-corpus/v1/", import.meta.url);
  const caseNames = ["db-target-matrix", "action-matrix", "composite-capstone"] as const;
  const cases = caseNames.map((caseName) => loadLegacyImportCorpusCase(corpusRoot, caseName));
  for (const corpusCase of cases) validateLegacyImportCorpusCase(corpusCase);

  const byName = new Map(cases.map((corpusCase) => [corpusCase.name, corpusCase]));
  const corpusCase = (caseName: (typeof caseNames)[number]) => {
    const result = byName.get(caseName);
    assert.ok(result, `missing ${caseName}`);
    return result;
  };
  const oracle = (caseName: (typeof caseNames)[number]) => corpusCase(caseName).oracle;
  const sourceRows = (caseName: (typeof caseNames)[number]) =>
    oracle(caseName).sources.map((source) => [source.path, source.parser_id, source.outcome]);
  const changeRows = (caseName: (typeof caseNames)[number]) =>
    oracle(caseName).changes.map((change) => [
      change.change_id,
      change.action,
      change.target.kind,
      change.target.key,
      change.target.field ?? null,
      change.reason_code,
    ]);
  const diagnosisRows = (caseName: (typeof caseNames)[number]) =>
    oracle(caseName).diagnoses.map((diagnosis) => [
      diagnosis.diagnosis_id,
      diagnosis.code,
      diagnosis.severity,
      diagnosis.source_id,
    ]);
  const semanticHash = (caseName: (typeof caseNames)[number]) => legacyImportCorpusHash(
    oracle(caseName).changes.map((change) => ({
      action: change.action,
      target: change.target,
      normalized: change.normalized,
      reason: change.reason_code,
    })),
  );
  const fingerprints = () => caseNames.flatMap((caseName) => {
    const loaded = loadLegacyImportCorpusCase(corpusRoot, caseName);
    return loaded.files.map((file) => [caseName, file.path, file.entryKind, file.byteSize, file.sha256]);
  });
  const before = fingerprints();
  const corpusPath = fileURLToPath(corpusRoot);

  assert.deepEqual(sourceRows("db-target-matrix"), [
    ["corrupt/.gsd/gsd.db", "gsd-sqlite-target", "unparsed"],
    ["current-v44/.gsd/gsd.db", "gsd-sqlite-target", "mapped"],
    ["future-v45/.gsd/gsd.db", "gsd-sqlite-target", "unparsed"],
    ["historical-v30/.gsd/gsd.db", "gsd-sqlite-target", "mapped"],
    ["historical-v34/.gsd/gsd.db", "gsd-sqlite-target", "mapped"],
    ["historical-v43/.gsd/gsd.db", "gsd-sqlite-target", "mapped"],
    ["unversioned-populated/.gsd/gsd.db", "gsd-sqlite-target", "mapped"],
    ["wal-present/.gsd/gsd.db", "gsd-sqlite-target", "mapped"],
    ["wal-present/.gsd/gsd.db-shm", "gsd-sqlite-target", "preserved"],
    ["wal-present/.gsd/gsd.db-wal", "gsd-sqlite-target", "preserved"],
  ]);
  assert.deepEqual(changeRows("db-target-matrix"), []);
  assert.deepEqual(diagnosisRows("db-target-matrix"), [
    ["diagnosis-corrupt-database", "corrupt-database", "blocker", "database-corrupt"],
    ["diagnosis-future-schema", "future-schema-version", "blocker", "database-future-v45"],
    ["diagnosis-historical-v30", "historical-schema-version", "info", "database-historical-v30"],
    ["diagnosis-historical-v34", "historical-schema-version", "info", "database-historical-v34"],
    ["diagnosis-historical-v43", "historical-schema-version", "info", "database-historical-v43"],
    ["diagnosis-unversioned-populated", "unversioned-populated-database", "warning", "database-unversioned-populated"],
    ["diagnosis-wal-sidecars", "wal-sidecars-present", "warning", "database-wal-main"],
  ]);
  assert.deepEqual(oracle("db-target-matrix").resolutions, [
    { diagnosis_id: "diagnosis-corrupt-database", disposition: "unsupported" },
    { diagnosis_id: "diagnosis-future-schema", disposition: "unsupported" },
    {
      diagnosis_id: "diagnosis-historical-v30",
      disposition: "mapped",
      target: { kind: "database-target", key: "historical-v30/.gsd/gsd.db" },
    },
    {
      diagnosis_id: "diagnosis-historical-v34",
      disposition: "mapped",
      target: { kind: "database-target", key: "historical-v34/.gsd/gsd.db" },
    },
    {
      diagnosis_id: "diagnosis-historical-v43",
      disposition: "mapped",
      target: { kind: "database-target", key: "historical-v43/.gsd/gsd.db" },
    },
    {
      diagnosis_id: "diagnosis-unversioned-populated",
      disposition: "mapped",
      target: { kind: "database-target", key: "unversioned-populated/.gsd/gsd.db" },
    },
    {
      diagnosis_id: "diagnosis-wal-sidecars",
      disposition: "preserved",
      target: { kind: "database-target", key: "wal-present/.gsd/gsd.db" },
    },
  ]);

  const targetRoot = join(corpusPath, "db-target-matrix", "source");
  const inspectTarget = <T>(scenario: string, inspect: (database: DatabaseSync) => T): T => {
    const database = new DatabaseSync(join(targetRoot, scenario, ".gsd", "gsd.db"), { readOnly: true });
    try {
      database.exec("PRAGMA query_only=ON");
      return inspect(database);
    } finally {
      database.close();
    }
  };
  const objectExists = (database: DatabaseSync, type: "table" | "trigger", name: string) =>
    database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = ? AND name = ?")
      .get(type, name)?.count === 1;
  const validTargetScenarios = [
    "current-v44",
    "future-v45",
    "historical-v30",
    "historical-v34",
    "historical-v43",
    "unversioned-populated",
  ];
  for (const scenario of validTargetScenarios) {
    assert.equal(inspectTarget(scenario, (database) => database.prepare("PRAGMA integrity_check").get()?.integrity_check), "ok");
  }
  assert.deepEqual(
    Object.fromEntries(validTargetScenarios.map((scenario) => [scenario, inspectTarget(
      scenario,
      (database) => database.prepare("SELECT max(version) AS version FROM schema_version").get()?.version ?? 0,
    )])),
    {
      "current-v44": 44,
      "future-v45": 45,
      "historical-v30": 30,
      "historical-v34": 34,
      "historical-v43": 43,
      "unversioned-populated": 0,
    },
  );
  assert.equal(inspectTarget("historical-v30", (database) => objectExists(database, "table", "project_authority")), false);
  assert.equal(inspectTarget("historical-v34", (database) => objectExists(database, "table", "workflow_import_applications")), false);
  assert.equal(inspectTarget("historical-v43", (database) => objectExists(database, "trigger", "trg_workflow_lifecycle_reopen_authorization")), false);
  assert.deepEqual(inspectTarget("current-v44", (database) => ({
    authority: objectExists(database, "table", "project_authority"),
    imports: objectExists(database, "table", "workflow_import_applications"),
    reopen: objectExists(database, "trigger", "trg_workflow_lifecycle_reopen_authorization"),
    applications: database.prepare("SELECT count(*) AS count FROM workflow_import_applications").get()?.count,
  })), { authority: true, imports: true, reopen: true, applications: 0 });
  assert.deepEqual(inspectTarget("unversioned-populated", (database) => ({
    versions: database.prepare("SELECT count(*) AS count FROM schema_version").get()?.count,
    milestones: database.prepare("SELECT count(*) AS count FROM milestones").get()?.count,
    decisions: database.prepare("SELECT count(*) AS count FROM decisions").get()?.count,
    memories: database.prepare("SELECT count(*) AS count FROM memories").get()?.count,
  })), { versions: 0, milestones: 1, decisions: 1, memories: 1 });
  assert.throws(() => {
    const database = new DatabaseSync(join(targetRoot, "corrupt", ".gsd", "gsd.db"), { readOnly: true });
    try {
      database.prepare("PRAGMA integrity_check").get();
    } finally {
      database.close();
    }
  });
  assert.deepEqual(
    corpusCase("db-target-matrix").files
      .filter((file) => file.path.endsWith("gsd.db-shm") || file.path.endsWith("gsd.db-wal"))
      .map((file) => [file.path, file.byteSize, file.sha256]),
    [
      [
        "wal-present/.gsd/gsd.db-shm",
        32768,
        "sha256:dc06e3e3a3ea75ab42b898b5947b5f0071579dfdb39f8a552f03af572b83115f",
      ],
      [
        "wal-present/.gsd/gsd.db-wal",
        1104,
        "sha256:4f0b8e33edb0a524f59653e497e07b20a05b8e60b4572c6c2a32d13b3d9cb2ef",
      ],
    ],
  );
  const walRoot = join(targetRoot, "wal-present", ".gsd");
  const walBytes = readFileSync(join(walRoot, "gsd.db-wal"));
  const shmBytes = readFileSync(join(walRoot, "gsd.db-shm"));
  assert.ok([0x377f0682, 0x377f0683].includes(walBytes.readUInt32BE(0)));
  assert.equal(walBytes.readUInt32BE(8), 512);
  assert.equal((walBytes.byteLength - 32) / (24 + 512), 2);
  assert.equal(walBytes.readUInt32BE(16), walBytes.readUInt32BE(40));
  assert.equal(walBytes.readUInt32BE(20), walBytes.readUInt32BE(44));
  assert.equal(shmBytes.byteLength, 32768);
  assert.ok(shmBytes.some((byte) => byte !== 0), "SHM witness must contain binary index state");

  assert.deepEqual(sourceRows("action-matrix"), [
    [".gsd/STATE.md", "gsd-lifecycle-truth", "preserved"],
    [".gsd/gsd.db", "gsd-sqlite-target", "mapped"],
    [".gsd/state-manifest.json", "gsd-lifecycle-truth", "mapped"],
  ]);
  assert.deepEqual(changeRows("action-matrix"), [
    ["change-create-d001", "create", "decision", "D001", null, "candidate-row-absent-from-base"],
    ["change-delete-d003", "delete", "decision", "D003", null, "complete-snapshot-row-absent"],
    ["change-preserve-state-narrative", "preserve", "artifact", ".gsd/STATE.md", null, "unmodeled-state-narrative-preserved"],
    ["change-update-d002", "update", "decision", "D002", null, "candidate-row-differs-from-base"],
  ]);
  assert.equal(semanticHash("action-matrix"), "sha256:c506889b432b279c3efd7a292463a752fedc9b07189206dd750ee77d126618ef");
  assert.deepEqual(oracle("action-matrix").counts, {
    create: 1, update: 1, delete: 1, preserve: 1, unparsed: 0, unresolved: 0,
  });
  assert.deepEqual(oracle("action-matrix").diagnoses, []);
  assert.deepEqual(oracle("action-matrix").resolutions, []);

  const actionRoot = join(corpusPath, "action-matrix", "source");
  const manifest = readManifest(actionRoot);
  assert.ok(manifest, "action matrix must contain a producer-valid complete StateManifest");
  const actionDatabase = new DatabaseSync(join(actionRoot, ".gsd", "gsd.db"), { readOnly: true });
  try {
    actionDatabase.exec("PRAGMA query_only=ON");
    assert.deepEqual({ ...actionDatabase.prepare(`
      SELECT
        (SELECT max(version) FROM schema_version) AS schema_version,
        revision,
        authority_epoch
      FROM project_authority WHERE singleton = 1
    `).get() }, { schema_version: 44, revision: 17, authority_epoch: 2 });
    assert.equal(actionDatabase.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    const baseDecisions = actionDatabase.prepare("SELECT * FROM decisions ORDER BY id").all()
      .map((row) => ({ ...row }));
    assert.deepEqual(baseDecisions.map((decision) => decision.id), ["D002", "D003", "D004"]);
    assert.deepEqual(manifest.decisions.map((decision) => decision.id), ["D001", "D002", "D004"]);
    const baseD002 = baseDecisions.find((decision) => decision.id === "D002");
    const manifestD002 = manifest.decisions.find((decision) => decision.id === "D002");
    assert.notDeepEqual(baseD002, manifestD002, "updates require a changed complete-snapshot row");
    const updateD002 = oracle("action-matrix").changes.find(
      (change) => change.action === "update" && change.target.key === "D002",
    );
    assert.ok(updateD002);
    assert.deepEqual(updateD002.normalized, manifestD002);
    assert.ok(baseDecisions.some((decision) => decision.id === "D003"));
    assert.ok(!manifest.decisions.some((decision) => decision.id === "D003"));
    const deleteD003 = oracle("action-matrix").changes.find(
      (change) => change.action === "delete" && change.target.key === "D003",
    );
    assert.ok(deleteD003);
    assert.equal(deleteD003.normalized, null);
    assert.equal(deleteD003.raw.locator.json_pointer, "/decisions");
    assert.deepEqual(deleteD003.raw.value, manifest.decisions);
    assert.deepEqual(
      baseDecisions.find((decision) => decision.id === "D004"),
      manifest.decisions.find((decision) => decision.id === "D004"),
      "identical complete-snapshot rows must be no-ops",
    );
    assert.ok(!oracle("action-matrix").changes.some((change) => change.target.key === "D004"));
    assert.equal(objectExists(actionDatabase, "table", "workflow_import_applications"), true);
    assert.equal(
      actionDatabase.prepare("SELECT count(*) AS count FROM workflow_import_applications").get()?.count,
      0,
    );
  } finally {
    actionDatabase.close();
  }

  assert.deepEqual(sourceRows("composite-capstone"), [
    [".gsd-worktrees/M008/git-marker.txt", "gsd-worktree-topology", "preserved"],
    [".gsd/DECISIONS.md", "gsd-decisions-table", "mapped"],
    [".gsd/KNOWLEDGE.md", "gsd-knowledge-graph", "preserved"],
    [".gsd/REQUIREMENTS.md", "gsd-requirements-sections", "mapped"],
    [".gsd/event-log.jsonl", "gsd-workflow-events", "preserved"],
    [".gsd/gsd.db", "gsd-sqlite-target", "mapped"],
    [".gsd/milestones/M007-capstone-alpha/M007-ROADMAP.md", "gsd-hybrid-hierarchy", "unparsed"],
    [".gsd/milestones/M702-clean/M702-ROADMAP.md", "gsd-nested-hierarchy", "mapped"],
    [".gsd/phases/07-capstone-beta/07-ROADMAP.md", "gsd-hybrid-hierarchy", "unparsed"],
    [".gsd/state-manifest.json", "gsd-assessment-truth", "mapped"],
    [".gsd/workflow-runs/capstone/run-001/GRAPH.yaml", "gsd-workflow-run-graph", "preserved"],
    [".gsd/workflows/capstone.yaml", "gsd-workflow-definition", "preserved"],
    [".planning/ROADMAP.md", "planning-roadmap-parser", "mapped"],
  ]);
  assert.deepEqual(changeRows("composite-capstone"), [
    ["change-create-assessment-m702-s01-run-uat", "create", "assessment", "M702/S01/run-uat", null, "structured-run-uat"],
    ["change-create-decision-d701", "create", "decision", "D701", null, "capstone-clean-decision"],
    ["change-create-milestone-m701", "create", "milestone", "M701", null, "capstone-clean-planning-milestone"],
    ["change-create-milestone-m702", "create", "milestone", "M702", null, "capstone-clean-gsd-milestone"],
    ["change-create-requirement-r701", "create", "requirement", "R701", null, "capstone-clean-requirement"],
    ["change-create-slice-m702-s01", "create", "slice", "M702/S01", null, "capstone-clean-gsd-lifecycle"],
    ["change-preserve-history", "preserve", "legacy-workflow-event", ".gsd/event-log.jsonl#L001", null, "history-evidence-only"],
    ["change-preserve-knowledge", "preserve", "legacy-knowledge-source", ".gsd/KNOWLEDGE.md", null, "knowledge-evidence-only"],
    ["change-preserve-workflow-definition", "preserve", "legacy-workflow-definition", ".gsd/workflows/capstone.yaml", null, "workflow-definition-evidence-only"],
    ["change-preserve-workflow-graph", "preserve", "legacy-workflow-run-graph", "capstone/run-001", null, "workflow-graph-evidence-only"],
    ["change-preserve-worktree", "preserve", "legacy-worktree-topology", ".gsd-worktrees/M008", null, "worktree-evidence-only"],
  ]);
  assert.deepEqual(diagnosisRows("composite-capstone"), [
    ["diagnosis-hybrid-m007-conflicting-content", "hybrid-conflicting-content", "blocker", "capstone-hybrid-m007-nested"],
    ["diagnosis-hybrid-m007-duplicate-logical-milestone", "duplicate-logical-milestone", "blocker", "capstone-hybrid-m007-flat"],
  ]);
  assert.deepEqual(oracle("composite-capstone").resolutions, [
    { diagnosis_id: "diagnosis-hybrid-m007-conflicting-content", disposition: "requires-user" },
    { diagnosis_id: "diagnosis-hybrid-m007-duplicate-logical-milestone", disposition: "requires-user" },
  ]);
  assert.deepEqual(oracle("composite-capstone").counts, {
    create: 6, update: 0, delete: 0, preserve: 5, unparsed: 2, unresolved: 2,
  });
  assert.equal(semanticHash("composite-capstone"), "sha256:a48305cde510b614171a68da43a655fd725d60f3d3c8eef3c6fa64d89e5b7950");
  assert.ok(!oracle("composite-capstone").changes.some((change) => change.target.key.includes("M007")));
  assert.ok(oracle("composite-capstone").changes
    .filter((change) => change.target.kind.startsWith("legacy-"))
    .every((change) => change.action === "preserve"));

  const capstoneRoot = join(corpusPath, "composite-capstone", "source");
  const capstoneManifest = readManifest(capstoneRoot);
  assert.ok(capstoneManifest, "capstone must contain a producer-valid structured truth source");
  assert.deepEqual(capstoneManifest.assessments?.map((assessment) => ({
    key: `${assessment.milestone_id}/${assessment.slice_id}/${assessment.scope}`,
    status: assessment.status,
  })), [{ key: "M702/S01/run-uat", status: "pass" }]);

  const capstoneDatabase = new DatabaseSync(
    join(capstoneRoot, ".gsd", "gsd.db"),
    { readOnly: true },
  );
  try {
    capstoneDatabase.exec("PRAGMA query_only=ON");
    assert.deepEqual({ ...capstoneDatabase.prepare(`
      SELECT
        (SELECT max(version) FROM schema_version) AS schema_version,
        revision,
        authority_epoch,
        (SELECT count(*) FROM workflow_import_applications) AS import_applications,
        (SELECT count(*) FROM decisions WHERE id = 'D701') AS base_decisions,
        (SELECT count(*) FROM requirements WHERE id = 'R701') AS base_requirements,
        (SELECT count(*) FROM milestones WHERE id IN ('M701', 'M702')) AS base_milestones,
        (SELECT count(*) FROM slices WHERE milestone_id = 'M702' AND id = 'S01') AS base_slices
      FROM project_authority WHERE singleton = 1
    `).get() }, {
      schema_version: 44,
      revision: 27,
      authority_epoch: 3,
      import_applications: 0,
      base_decisions: 0,
      base_requirements: 0,
      base_milestones: 0,
      base_slices: 0,
    });
    assert.equal(capstoneDatabase.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
  } finally {
    capstoneDatabase.close();
  }

  assert.deepEqual(
    caseNames.map((caseName) => [
      legacyImportCorpusHash(oracle(caseName).sources),
      legacyImportCorpusHash(oracle(caseName).changes),
      legacyImportCorpusHash(oracle(caseName).diagnoses),
      legacyImportCorpusHash(oracle(caseName).resolutions),
    ]),
    [
      [
        "sha256:5512ca657bc6b00e33daf1734ffb0d6c277b1d8a3e3216ff4316c9fb8643c3c3",
        "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
        "sha256:a2321edd2f8e33f882dee1ef40642a261a632d124af84d485ee7b81b8f33adcf",
        "sha256:d7449477e6c5f9414fe547e7f291658f4cd855c8942f78fa48b68067ed5aed55",
      ],
      [
        "sha256:c3b70bb96e975620892927e4306d0ee7bb42220594b2cde1eb09390fac0be4d1",
        "sha256:5ee816447ea03a7c8d1ffb391c2b49e7dc3e3cc6ec348c06c777a166c9f51099",
        "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
        "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
      ],
      [
        "sha256:060402a7bc26f3b869dc224f2194101cb9712200399e7951fb5bb82e1b49a8a9",
        "sha256:2caf378b56fadca2116319210cdc808166a03d4bac92f778c7d730a6e7897906",
        "sha256:48e704be969fea42c819b8ca27876897f1228bdcffb462dc041ca9f6d801832a",
        "sha256:309d793c6e8788d9c245c52c70fc059e0e389794fef78f8cefb79289a017ccd9",
      ],
    ],
  );
  assert.deepEqual(fingerprints(), before, "capstone classification must not mutate corpus bytes or paths");
});
