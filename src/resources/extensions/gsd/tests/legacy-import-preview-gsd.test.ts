// Project/App: gsd-pi
// File Purpose: Exact semantic corpus tests for pure legacy .gsd interpretation.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import type {
  LegacyImportLocator,
  LegacyImportPreviewChange,
  LegacyImportPreviewDiagnosis,
  LegacyImportPreviewEnvelope,
  LegacyImportPreviewResolution,
  LegacyImportPreviewSource,
  LegacyImportSha256,
} from "../legacy-import-contract.ts";
import {
  interpretLegacyGsdCapture,
  type LegacyImportGsdCandidate,
  type LegacyImportGsdDatabaseEvidence,
  type LegacyImportGsdDatabaseObservation,
  type LegacyImportGsdInterpretation,
} from "../legacy-import-preview-gsd.ts";
import {
  captureLegacyImportSourceSet,
  type LegacyImportSourceCapture,
  type LegacyImportSourceRoot,
} from "../legacy-import-preview-source.ts";
import {
  canonicalLegacyImportJson,
  hashLegacyImportBytes,
  hashLegacyImportValue,
} from "../legacy-import-preview.ts";
import { loadLegacyImportCorpusCase } from "./helpers/legacy-import-corpus.ts";

const CORPUS_ROOT = new URL("./__fixtures__/legacy-import-corpus/v1/", import.meta.url);
const GSD_CASES = [
  "assessment-matrix",
  "gsd-alias-hybrid",
  "gsd-flat",
  "gsd-nested",
  "lifecycle-truth-matrix",
  "registries",
  "registries-lowercase",
] as const;

interface CapturedCase {
  capture: LegacyImportSourceCapture;
  physicalRoot: string;
  oracle: LegacyImportPreviewEnvelope;
  databaseEvidence: readonly LegacyImportGsdDatabaseEvidence[];
}

function compareCanonical(left: unknown, right: unknown): number {
  const leftJson = canonicalLegacyImportJson(left);
  const rightJson = canonicalLegacyImportJson(right);
  return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
}

function freezeDeep<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeDeep(child, seen);
  return Object.freeze(value);
}

function temporaryDirectory(t: { after(fn: () => void): void }): string {
  const path = mkdtempSync(join(tmpdir(), "gsd-preview-truth-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function payloadBytes(capture: LegacyImportSourceCapture, logicalPath: string): Buffer {
  const entry = capture.entries.find((candidate) => candidate.logical_path === logicalPath);
  assert.ok(entry?.payload_id, `${logicalPath}: captured payload`);
  const payload = capture.payloads.find((candidate) => candidate.payload_id === entry.payload_id);
  assert.ok(payload, `${logicalPath}: retained bytes`);
  return Buffer.from(payload.bytes_base64, "base64");
}

function capturedSourceId(capture: LegacyImportSourceCapture, logicalPath: string): LegacyImportSha256 {
  const entry = capture.entries.find((candidate) => candidate.logical_path === logicalPath);
  assert.ok(entry, `${logicalPath}: captured source`);
  return entry.source_id;
}

function lifecycleDatabaseEvidence(
  capture: LegacyImportSourceCapture,
  oracle: LegacyImportPreviewEnvelope,
): LegacyImportGsdDatabaseEvidence {
  const logicalPath = ".gsd/gsd.db";
  const bytes = payloadBytes(capture, logicalPath);
  const rawChanges = new Map(oracle.changes
    .filter((change) => change.raw.source_id === "lifecycle-dependency-database")
    .map((change) => [change.target.key, change.raw]));
  const depends = rawChanges.get("M001/S02/depends-column");
  const junction = rawChanges.get("M001/S02/dependency-junction");
  assert.ok(depends && junction, "lifecycle database evidence spans are sealed by the oracle");
  const observations: readonly LegacyImportGsdDatabaseObservation[] = [
    {
      table: "slices",
      key: { milestone_id: "M001", id: "S02" },
      field: "depends",
      value: ["S00"],
      raw: { locator: depends.locator, value: String(depends.value), sha256: depends.sha256 },
    },
    {
      table: "slice_dependencies",
      key: { milestone_id: "M001", slice_id: "S02" },
      field: "depends_on_slice_id",
      value: "S99",
      raw: { locator: junction.locator, value: String(junction.value), sha256: junction.sha256 },
    },
  ];
  const evidenceValue = {
    evidence_version: 1 as const,
    inspection_version: 1 as const,
    capture_hash: capture.capture_hash,
    source_id: capturedSourceId(capture, logicalPath),
    source_sha256: hashLegacyImportBytes(bytes),
    source_byte_size: bytes.length,
    coverage: [
      { table: "slices" as const, field: "depends" as const, complete: true as const, row_count: 1 },
      { table: "slice_dependencies" as const, field: "depends_on_slice_id" as const, complete: true as const, row_count: 1 },
    ],
    observations,
  };
  return freezeDeep({ ...evidenceValue, evidence_hash: hashLegacyImportValue(evidenceValue) });
}

function captureCase(
  t: { after(fn: () => void): void },
  caseName: (typeof GSD_CASES)[number],
): CapturedCase {
  const base = temporaryDirectory(t);
  const physicalRoot = join(base, ".gsd");
  cpSync(
    fileURLToPath(new URL(`./${caseName}/source/.gsd`, CORPUS_ROOT)),
    physicalRoot,
    { recursive: true, dereference: false },
  );
  const capture = captureLegacyImportSourceSet({
    roots: [{
      id: "gsd",
      kind: "project",
      physical_path: physicalRoot,
      logical_path: ".gsd",
      presence: "required",
    }],
  });
  const oracle = loadLegacyImportCorpusCase(CORPUS_ROOT, caseName).oracle;
  return {
    capture,
    physicalRoot,
    oracle,
    databaseEvidence: caseName === "lifecycle-truth-matrix"
      ? [lifecycleDatabaseEvidence(capture, oracle)]
      : [],
  };
}

function captureFiles(
  t: { after(fn: () => void): void },
  files: Readonly<Record<string, string | Buffer>>,
): LegacyImportSourceCapture {
  const base = temporaryDirectory(t);
  const physicalRoot = join(base, ".gsd");
  for (const [path, content] of Object.entries(files)) {
    const physicalPath = join(physicalRoot, path);
    mkdirSync(dirname(physicalPath), { recursive: true });
    writeFileSync(physicalPath, content);
  }
  return captureLegacyImportSourceSet({
    roots: [{ id: "gsd", kind: "project", physical_path: physicalRoot, logical_path: ".gsd", presence: "required" }],
  });
}

function captureCompositeT04(t: { after(fn: () => void): void }): CapturedCase {
  const base = temporaryDirectory(t);
  const physicalRoot = join(base, ".gsd");
  const selectedPaths = [
    ".gsd/DECISIONS.md",
    ".gsd/REQUIREMENTS.md",
    ".gsd/milestones/M007-capstone-alpha/M007-ROADMAP.md",
    ".gsd/milestones/M702-clean/M702-ROADMAP.md",
    ".gsd/phases/07-capstone-beta/07-ROADMAP.md",
    ".gsd/state-manifest.json",
  ];
  for (const logicalPath of selectedPaths) {
    const relativePath = logicalPath.slice(".gsd/".length);
    const destination = join(physicalRoot, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(fileURLToPath(new URL(`./composite-capstone/source/${logicalPath}`, CORPUS_ROOT)), destination);
  }
  const capture = captureLegacyImportSourceSet({
    roots: [{ id: "gsd", kind: "project", physical_path: physicalRoot, logical_path: ".gsd", presence: "required" }],
  });
  const fullOracle = loadLegacyImportCorpusCase(CORPUS_ROOT, "composite-capstone").oracle;
  const sources = fullOracle.sources.filter((source) => selectedPaths.includes(source.path));
  const sourceIds = new Set(sources.map((source) => source.source_id));
  const changes = fullOracle.changes.filter((change) => sourceIds.has(change.raw.source_id));
  const diagnoses = fullOracle.diagnoses.filter((diagnosis) => sourceIds.has(diagnosis.source_id));
  const diagnosisIds = new Set(diagnoses.map((diagnosis) => diagnosis.diagnosis_id));
  const resolutions = fullOracle.resolutions.filter((resolution) => diagnosisIds.has(resolution.diagnosis_id));
  return {
    capture,
    physicalRoot,
    databaseEvidence: [],
    oracle: { ...fullOracle, sources, changes, diagnoses, resolutions },
  };
}

function sourcePathsById(sources: readonly LegacyImportPreviewSource[]): Map<string, string> {
  return new Map(sources.map((source) => [source.source_id, source.path]));
}

function normalizedSources(sources: readonly LegacyImportPreviewSource[]) {
  return sources.map(({ source_id: _sourceId, ...source }) => source);
}

function normalizedCandidates(
  candidates: readonly (LegacyImportGsdCandidate | LegacyImportPreviewChange)[],
  sourcePaths: ReadonlyMap<string, string>,
) {
  return candidates.map((candidate) => {
    let classification: "compare" | "preserve";
    if ("action" in candidate) {
      classification = candidate.action === "preserve" ? "preserve" : "compare";
    } else {
      classification = candidate.classification;
    }
    return {
      classification,
      target: candidate.target,
      raw: {
        ...candidate.raw,
        source_id: sourcePaths.get(candidate.raw.source_id) ?? candidate.raw.source_id,
      },
      normalized: candidate.normalized,
      provenance: {
        ...candidate.provenance,
        source_id: sourcePaths.get(candidate.provenance.source_id) ?? candidate.provenance.source_id,
      },
      reason_code: candidate.reason_code,
    };
  }).sort(compareCanonical);
}

function diagnosisKey(
  diagnosis: LegacyImportPreviewDiagnosis,
  sourcePaths: ReadonlyMap<string, string>,
): string {
  return canonicalLegacyImportJson({
    code: diagnosis.code,
    source: sourcePaths.get(diagnosis.source_id) ?? diagnosis.source_id,
    locator: diagnosis.locator,
  });
}

function normalizedDiagnoses(
  diagnoses: readonly LegacyImportPreviewDiagnosis[],
  sourcePaths: ReadonlyMap<string, string>,
) {
  return diagnoses.map(({ diagnosis_id: _diagnosisId, source_id: sourceId, ...diagnosis }) => ({
    ...diagnosis,
    source_id: sourcePaths.get(sourceId) ?? sourceId,
  })).sort(compareCanonical);
}

function normalizedResolutions(
  resolutions: readonly LegacyImportPreviewResolution[],
  diagnoses: readonly LegacyImportPreviewDiagnosis[],
  sourcePaths: ReadonlyMap<string, string>,
) {
  const keys = new Map(diagnoses.map((diagnosis) => [
    diagnosis.diagnosis_id,
    diagnosisKey(diagnosis, sourcePaths),
  ]));
  return resolutions.map((resolution) => ({
    diagnosis: keys.get(resolution.diagnosis_id) ?? resolution.diagnosis_id,
    disposition: resolution.disposition,
    ...(resolution.target === undefined ? {} : { target: resolution.target }),
  })).sort(compareCanonical);
}

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

function assertLocator(bytes: Buffer, locator: LegacyImportLocator, label: string): Buffer {
  assert.ok(Number.isSafeInteger(locator.start_byte) && locator.start_byte >= 0, `${label}: start byte`);
  assert.ok(
    locator.end_byte !== undefined
      && Number.isSafeInteger(locator.end_byte)
      && locator.end_byte > locator.start_byte
      && locator.end_byte <= bytes.length,
    `${label}: end byte`,
  );
  const expectedLine = bytes.subarray(0, locator.start_byte).reduce(
    (line, byte) => line + (byte === 10 ? 1 : 0),
    1,
  );
  if (locator.line !== undefined) assert.equal(locator.line, expectedLine, `${label}: line`);
  return bytes.subarray(locator.start_byte, locator.end_byte);
}

function assertRuntimeIdentity(
  capture: LegacyImportSourceCapture,
  interpretation: LegacyImportGsdInterpretation,
): void {
  const sourceIds = new Set(interpretation.sources.map((source) => source.source_id));
  const expectedIds = new Map(capture.entries.map((entry) => [entry.logical_path, entry.source_id]));
  for (const source of interpretation.sources) {
    assert.equal(source.source_id, expectedIds.get(source.path), `${source.path}: captured identity`);
  }
  assert.deepEqual(
    interpretation.candidates.map((candidate) => candidate.ordinal),
    interpretation.candidates.map((_candidate, index) => index + 1),
  );
  for (const candidate of interpretation.candidates) {
    assert.ok(sourceIds.has(candidate.raw.source_id));
    assert.equal(candidate.raw.source_id, candidate.provenance.source_id);
    assert.match(candidate.candidate_id, /^sha256:[0-9a-f]{64}$/u);
    const { candidate_id: _candidateId, ordinal: _ordinal, ...identity } = candidate;
    assert.equal(candidate.candidate_id, hashLegacyImportValue(identity));
    const bytes = payloadBytes(capture, interpretation.sources.find(
      (source) => source.source_id === candidate.raw.source_id,
    )!.path);
    assert.equal(
      candidate.raw.sha256,
      hashLegacyImportBytes(assertLocator(bytes, candidate.raw.locator, candidate.candidate_id)),
    );
  }
  assert.equal(new Set(interpretation.candidates.map((candidate) => candidate.candidate_id)).size, interpretation.candidates.length);
  for (const diagnosis of interpretation.diagnoses) {
    assert.ok(sourceIds.has(diagnosis.source_id));
    assert.match(diagnosis.diagnosis_id, /^sha256:[0-9a-f]{64}$/u);
    const { diagnosis_id: _diagnosisId, ...identity } = diagnosis;
    assert.equal(diagnosis.diagnosis_id, hashLegacyImportValue(identity));
    const bytes = payloadBytes(capture, interpretation.sources.find(
      (source) => source.source_id === diagnosis.source_id,
    )!.path);
    assertLocator(bytes, diagnosis.locator, diagnosis.diagnosis_id);
  }
  assert.deepEqual(
    interpretation.resolutions.map((resolution) => resolution.diagnosis_id),
    interpretation.diagnoses.map((diagnosis) => diagnosis.diagnosis_id),
  );
}

function assertOracleSemantics(captured: CapturedCase, interpretation: LegacyImportGsdInterpretation): void {
  const runtimePaths = sourcePathsById(interpretation.sources);
  const oraclePaths = sourcePathsById(captured.oracle.sources);
  assert.deepEqual(normalizedSources(interpretation.sources), normalizedSources(captured.oracle.sources));
  assert.deepEqual(
    normalizedCandidates(interpretation.candidates, runtimePaths),
    normalizedCandidates(captured.oracle.changes, oraclePaths),
  );
  assert.deepEqual(
    normalizedDiagnoses(interpretation.diagnoses, runtimePaths),
    normalizedDiagnoses(captured.oracle.diagnoses, oraclePaths),
  );
  assert.deepEqual(
    normalizedResolutions(interpretation.resolutions, interpretation.diagnoses, runtimePaths),
    normalizedResolutions(captured.oracle.resolutions, captured.oracle.diagnoses, oraclePaths),
  );
  assertRuntimeIdentity(captured.capture, interpretation);
  assertDeepFrozen(interpretation);
}

function rehashEvidence(
  evidence: LegacyImportGsdDatabaseEvidence,
  changes: Partial<LegacyImportGsdDatabaseEvidence>,
): LegacyImportGsdDatabaseEvidence {
  const { evidence_hash: _oldHash, ...oldValue } = evidence;
  const value = { ...oldValue, ...changes };
  return { ...value, evidence_hash: hashLegacyImportValue(value) } as LegacyImportGsdDatabaseEvidence;
}

describe("legacy .gsd captured-byte interpretation", () => {
  for (const caseName of GSD_CASES) {
    test(`matches the sealed ${caseName} semantics`, (t) => {
      const captured = captureCase(t, caseName);
      const interpretation = interpretLegacyGsdCapture(captured.capture, captured.databaseEvidence);
      assertOracleSemantics(captured, interpretation);
      assert.deepEqual(
        interpretation,
        interpretLegacyGsdCapture(captured.capture, captured.databaseEvidence),
        `${caseName}: deterministic replay`,
      );
    });
  }

  test("retains all meaning after the source tree is removed", (t) => {
    const captured = captureCase(t, "lifecycle-truth-matrix");
    const before = interpretLegacyGsdCapture(captured.capture, captured.databaseEvidence);
    rmSync(captured.physicalRoot, { recursive: true, force: true });
    const after = interpretLegacyGsdCapture(captured.capture, captured.databaseEvidence);
    assert.deepEqual(after, before);
    assertOracleSemantics(captured, after);
  });

  test("composes the filtered T04 capstone without interpreter drift", (t) => {
    const captured = captureCompositeT04(t);
    assertOracleSemantics(captured, interpretLegacyGsdCapture(captured.capture));
  });

  test("preserves registry semantics across canonical and lowercase filenames", (t) => {
    const canonical = captureCase(t, "registries");
    const lowercase = captureCase(t, "registries-lowercase");
    const canonicalResult = interpretLegacyGsdCapture(canonical.capture);
    const lowercaseResult = interpretLegacyGsdCapture(lowercase.capture);
    assert.ok(canonicalResult.candidates.length > 0, "canonical registry interpretation is not empty");
    assert.ok(lowercaseResult.candidates.length > 0, "lowercase registry interpretation is not empty");
    const semantics = (result: LegacyImportGsdInterpretation) => result.candidates.map((candidate) => ({
      classification: candidate.classification,
      target: candidate.target.key.includes(".gsd/")
        ? { ...candidate.target, key: candidate.target.key.toLowerCase() }
        : candidate.target,
      normalized: candidate.normalized !== null
        && typeof candidate.normalized === "object"
        && !Array.isArray(candidate.normalized)
        && "path" in candidate.normalized
        && typeof candidate.normalized.path === "string"
        ? { ...candidate.normalized, path: candidate.normalized.path.toLowerCase() }
        : candidate.normalized,
      reason_code: candidate.reason_code,
    })).sort(compareCanonical);
    assert.deepEqual(semantics(lowercaseResult), semantics(canonicalResult));
  });

  test("fails closed on malformed structured data", (t) => {
    const malformed = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": "{\"milestones\":[",
    }));
    assert.deepEqual(malformed.candidates, []);
    assert.equal(malformed.sources[0]?.outcome, "unparsed");
    assert.equal(malformed.diagnoses[0]?.code, "malformed-state-manifest");
    assert.equal(malformed.resolutions[0]?.disposition, "requires-user");
  });

  test("fails closed on invalid UTF-8", (t) => {
    const invalidUtf8 = interpretLegacyGsdCapture(captureFiles(t, {
      "REQUIREMENTS.md": Buffer.from([0x23, 0x20, 0xc3, 0x28]),
    }));
    assert.deepEqual(invalidUtf8.candidates, []);
    assert.equal(invalidUtf8.sources[0]?.encoding, "binary");
    assert.equal(invalidUtf8.sources[0]?.outcome, "unparsed");
    assert.equal(invalidUtf8.diagnoses[0]?.code, "unsupported-gsd-encoding");
    assert.equal(invalidUtf8.resolutions[0]?.disposition, "unsupported");
  });

  test("records symlink bytes without interpreting their target content", (t) => {
    const base = temporaryDirectory(t);
    const gsd = join(base, ".gsd");
    const support = join(base, "support.md");
    mkdirSync(gsd);
    writeFileSync(support, "# Requirements\n\n### R001 — Must not follow this link\n");
    symlinkSync(support, join(gsd, "REQUIREMENTS.md"));
    const roots: readonly LegacyImportSourceRoot[] = [
      { id: "gsd", kind: "project", physical_path: gsd, logical_path: ".gsd", presence: "required" },
      { id: "support", kind: "external", physical_path: support, logical_path: "support", presence: "required" },
    ];
    const symlink = interpretLegacyGsdCapture(captureLegacyImportSourceSet({ roots }));
    const linkedSource = symlink.sources.find((source) => source.path === ".gsd/REQUIREMENTS.md");
    assert.equal(linkedSource?.kind, "symlink");
    assert.equal(linkedSource?.outcome, "unparsed");
    assert.ok(!symlink.candidates.some((candidate) => candidate.target.key === "R001"));
    assert.ok(symlink.diagnoses.some((diagnosis) => diagnosis.code === "unsupported-gsd-symlink"));
  });

  test("rejects forged database evidence identity", (t) => {
    const captured = captureCase(t, "lifecycle-truth-matrix");
    const evidence = captured.databaseEvidence[0]!;
    assert.throws(
      () => interpretLegacyGsdCapture(captured.capture, [{ ...evidence, evidence_hash: hashLegacyImportBytes(Buffer.from("forged")) }]),
      /database evidence identity/i,
    );
  });

  test("rejects database evidence linked to the wrong source fingerprint", (t) => {
    const captured = captureCase(t, "lifecycle-truth-matrix");
    const evidence = captured.databaseEvidence[0]!;
    assert.throws(
      () => interpretLegacyGsdCapture(captured.capture, [rehashEvidence(evidence, { source_sha256: hashLegacyImportBytes(Buffer.from("wrong")) })]),
      /database evidence source/i,
    );
  });

  test("rejects database evidence outside the captured byte range", (t) => {
    const captured = captureCase(t, "lifecycle-truth-matrix");
    const evidence = captured.databaseEvidence[0]!;
    const forgedObservation = {
      ...evidence.observations[0]!,
      raw: { ...evidence.observations[0]!.raw, locator: { start_byte: evidence.source_byte_size + 1, end_byte: evidence.source_byte_size + 2 } },
    };
    assert.throws(
      () => interpretLegacyGsdCapture(captured.capture, [rehashEvidence(evidence, { observations: [forgedObservation, evidence.observations[1]!] })]),
      /database evidence span/i,
    );
  });

  test("requires complete database coverage and exact raw normalization", (t) => {
    const captured = captureCase(t, "lifecycle-truth-matrix");
    const evidence = captured.databaseEvidence[0]!;
    const withoutEvidence = interpretLegacyGsdCapture(captured.capture);
    const database = withoutEvidence.sources.find((source) => source.path === ".gsd/gsd.db");
    assert.equal(database?.outcome, "unparsed");
    assert.ok(withoutEvidence.diagnoses.some((diagnosis) => diagnosis.code === "missing-complete-database-evidence"));

    const incompleteCoverage = rehashEvidence(evidence, {
      coverage: evidence.coverage.map((coverage) => (
        coverage.table === "slices" ? { ...coverage, row_count: 0 } : coverage
      )),
    });
    assert.throws(
      () => interpretLegacyGsdCapture(captured.capture, [incompleteCoverage]),
      /database evidence coverage/i,
    );

    const forgedObservation = {
      ...evidence.observations[0]!,
      value: ["FORGED"],
    };
    assert.throws(
      () => interpretLegacyGsdCapture(captured.capture, [rehashEvidence(evidence, {
        observations: [forgedObservation, evidence.observations[1]!],
      })]),
      /database evidence span/i,
    );

    const joinedKeyObservation = {
      ...evidence.observations[0]!,
      key: { "id,milestone_id": "joined-key" },
    };
    assert.throws(
      () => interpretLegacyGsdCapture(captured.capture, [rehashEvidence(evidence, {
        observations: [joinedKeyObservation, evidence.observations[1]!],
      })]),
      /database evidence span/i,
    );

    const duplicateObservationEvidence = rehashEvidence(evidence, {
      coverage: evidence.coverage.map((coverage) => (
        coverage.table === "slices" ? { ...coverage, row_count: 2 } : coverage
      )),
      observations: [evidence.observations[0]!, evidence.observations[0]!, evidence.observations[1]!],
    });
    assert.throws(
      () => interpretLegacyGsdCapture(captured.capture, [duplicateObservationEvidence]),
      /database evidence observations are duplicated/i,
    );
  });

  test("preserves unrecognized UTF-8 artifacts with explicit evidence", (t) => {
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "UNKNOWN.md": "# Unknown retained surface\n",
    }));
    assert.equal(interpretation.sources[0]?.outcome, "preserved");
    assert.equal(interpretation.candidates[0]?.classification, "preserve");
    assert.equal(interpretation.diagnoses[0]?.code, "unrecognized-gsd-artifact");
    assert.equal(interpretation.resolutions[0]?.disposition, "preserved");
  });

  test("reads assessment JSON independently of formatting and normalizes before conflict checks", (t) => {
    const manifest = JSON.stringify({
      assessments: [{
        full_content: "**Verdict:** PASSED",
        scope: "run-uat",
        status: "passed",
        slice_id: "S01",
        milestone_id: "M001",
      }],
    }, null, 2);
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": manifest,
      "milestones/M001/slices/S01/S01-ASSESSMENT.md": "# Assessment\n\n**Verdict:** PASS\n",
    }));
    assert.ok(interpretation.candidates.some((candidate) => (
      candidate.target.key === "M001/S01/run-uat"
      && candidate.normalized !== null
      && typeof candidate.normalized === "object"
      && !Array.isArray(candidate.normalized)
      && "verdict" in candidate.normalized
      && candidate.normalized.verdict === "pass"
    )));
    assert.ok(!interpretation.diagnoses.some((diagnosis) => (
      diagnosis.code === "structured-assessment-vs-artifact-conflict"
    )));
  });

  test("fails closed on malformed assessment manifest entries without runtime errors", (t) => {
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": JSON.stringify({ assessments: [null] }),
    }));
    assert.equal(interpretation.sources[0]?.outcome, "unparsed");
    assert.equal(interpretation.diagnoses[0]?.code, "invalid-assessment-manifest");
    assert.equal(interpretation.resolutions[0]?.disposition, "requires-user");
  });

  test("handles alternate lifecycle manifests without fixture-shaped assumptions", (t) => {
    const empty = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": "{}",
    }));
    assert.equal(empty.sources[0]?.outcome, "mapped");
    assert.deepEqual(empty.candidates, []);

    const invalidRoot = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": "null",
      "milestones/M123/M123-ROADMAP.md": "# M123: Alternate\n",
    }));
    assert.ok(invalidRoot.sources.some((source) => source.outcome === "unparsed"));
    assert.ok(invalidRoot.diagnoses.some((diagnosis) => (
      diagnosis.code === "unsupported-lifecycle-manifest-schema"
    )));

    const pretty = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": JSON.stringify({
        milestones: [{ id: "M123", status: "active" }],
        slices: [],
        tasks: [],
      }, null, 2),
    }));
    assert.ok(pretty.candidates.some((candidate) => (
      candidate.target.kind === "milestone-status"
      && candidate.target.key === "M123"
      && candidate.normalized === "active"
    )));
  });

  test("does not fabricate a dependency conflict from complete zero-row evidence", (t) => {
    const captured = captureCase(t, "lifecycle-truth-matrix");
    const evidence = captured.databaseEvidence[0]!;
    const zeroRows = rehashEvidence(evidence, {
      coverage: evidence.coverage.map((coverage) => ({ ...coverage, row_count: 0 })),
      observations: [],
    });
    const interpretation = interpretLegacyGsdCapture(captured.capture, [zeroRows]);
    assert.ok(!interpretation.diagnoses.some((diagnosis) => (
      diagnosis.code === "slices-depends-vs-slice-dependencies-conflict"
    )));
  });

  test("preserves unknown files beside recognized lifecycle artifacts", (t) => {
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": JSON.stringify({ milestones: [], slices: [], tasks: [] }),
      "UNKNOWN.md": "# Unknown beside lifecycle\n",
    }));
    const unknown = interpretation.sources.find((source) => source.path === ".gsd/UNKNOWN.md");
    assert.equal(unknown?.outcome, "preserved");
    assert.ok(interpretation.diagnoses.some((diagnosis) => (
      diagnosis.source_id === unknown?.source_id && diagnosis.code === "unrecognized-gsd-artifact"
    )));
  });

  test("classifies hybrid conflicts from structure rather than fixture vocabulary", (t) => {
    const diagnose = (word: string) => interpretLegacyGsdCapture(captureFiles(t, {
      "milestones/M007-alpha/M007-ROADMAP.md": `# M007: Alpha ${word}\n\n- [ ] S01 Alpha delivery\n`,
      "phases/07-beta/07-ROADMAP.md": `# 007: Beta ${word}\n\n- [ ] S01 Beta delivery\n`,
    })).diagnoses.map((diagnosis) => diagnosis.code).sort();
    const expected = ["duplicate-logical-milestone", "hybrid-conflicting-content"];
    assert.deepEqual(diagnose("capstone"), expected);
    assert.deepEqual(diagnose("launch"), expected);
  });

  test("fails closed on malformed and duplicate lifecycle identities", (t) => {
    const malformed = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": JSON.stringify({
        milestones: [{ id: 1, status: "active" }],
        slices: [],
        tasks: [],
      }),
    }));
    assert.equal(malformed.sources[0]?.outcome, "unparsed");
    assert.equal(malformed.diagnoses[0]?.code, "unsupported-lifecycle-manifest-schema");

    const duplicate = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": JSON.stringify({
        milestones: [{ id: "M001", status: "active" }, { id: "M001", status: "pending" }],
        slices: [],
        tasks: [],
      }),
    }));
    assert.equal(duplicate.sources[0]?.outcome, "unparsed");
    assert.equal(duplicate.diagnoses[0]?.code, "unsupported-lifecycle-manifest-schema");
  });

  test("reconciles database conflicts without a lifecycle manifest", (t) => {
    const fixture = captureCase(t, "lifecycle-truth-matrix");
    const databaseOnly = captureFiles(t, {
      "gsd.db": payloadBytes(fixture.capture, ".gsd/gsd.db"),
    });
    const evidence = lifecycleDatabaseEvidence(databaseOnly, fixture.oracle);
    const interpretation = interpretLegacyGsdCapture(databaseOnly, [evidence]);
    assert.equal(interpretation.candidates.filter((candidate) => (
      candidate.reason_code === "dependency-conflict-raw-evidence"
    )).length, 2);
    assert.ok(interpretation.diagnoses.some((diagnosis) => (
      diagnosis.code === "slices-depends-vs-slice-dependencies-conflict"
    )));
  });

  test("keeps roadmap and manifest lifecycle evidence provenance separate", (t) => {
    const captured = captureCompositeT04(t);
    const interpretation = interpretLegacyGsdCapture(captured.capture);
    const roadmapMilestone = interpretation.candidates.find((candidate) => (
      candidate.target.kind === "milestone" && candidate.target.key === "M702"
    ));
    assert.deepEqual(roadmapMilestone?.normalized, {
      id: "M702",
      layout: "nested",
      title: "Clean database adoption",
    });
    const manifestStatus = interpretation.candidates.find((candidate) => (
      candidate.target.kind === "milestone-status" && candidate.target.key === "M702"
    ));
    assert.equal(manifestStatus?.normalized, "active");
    assert.equal(manifestStatus?.raw.locator.json_pointer, "/milestones/0/status");

    const sourceParserIds = new Map(interpretation.sources.map((source) => [source.source_id, source.parser_id]));
    for (const candidate of interpretation.candidates) {
      assert.equal(candidate.provenance.parser_id, sourceParserIds.get(candidate.provenance.source_id));
    }
  });

  test("fails closed on a recognized roadmap without a canonical heading", (t) => {
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "milestones/M123/M123-ROADMAP.md": "# M123 malformed\n\n- [ ] S01 Work\n",
    }));
    assert.equal(interpretation.sources[0]?.outcome, "unparsed");
    assert.deepEqual(interpretation.candidates, []);
    assert.equal(interpretation.diagnoses[0]?.code, "malformed-roadmap");
    assert.equal(interpretation.resolutions[0]?.disposition, "requires-user");
  });

  test("quarantines every occurrence of a duplicate requirement identity", (t) => {
    const captured = captureCase(t, "registries");
    const interpretation = interpretLegacyGsdCapture(captured.capture);
    assert.ok(!interpretation.candidates.some((candidate) => (
      candidate.target.kind === "requirement" && candidate.target.key === "R001"
    )));
    assert.ok(interpretation.diagnoses.some((diagnosis) => diagnosis.code === "duplicate-requirement-id"));
  });

  test("emits assessment and lifecycle truth from one mixed manifest", (t) => {
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": JSON.stringify({
        milestones: [{ id: "M001", status: "active" }],
        slices: [{ milestone_id: "M001", id: "S01", status: "active" }],
        tasks: [{ milestone_id: "M001", slice_id: "S01", id: "T01", status: "active" }],
        assessments: [{
          milestone_id: "M001",
          slice_id: "S01",
          status: "pass",
          scope: "run-uat",
          full_content: "**Verdict:** PASS",
        }],
      }),
    }));
    const targets = new Set(interpretation.candidates.map((candidate) => (
      `${candidate.target.kind}:${candidate.target.key}`
    )));
    assert.ok(targets.has("milestone-status:M001"));
    assert.ok(targets.has("slice-status:M001/S01"));
    assert.ok(targets.has("task-status:M001/S01/T01"));
    assert.ok(targets.has("assessment:M001/S01/run-uat"));
    assert.equal(interpretation.sources[0]?.parser_id, "gsd-lifecycle-truth");
    assert.ok(interpretation.candidates.every((candidate) => (
      candidate.provenance.parser_id === "gsd-lifecycle-truth"
    )));
  });

  test("emits no truth from a mixed manifest when its assessment schema is invalid", (t) => {
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": JSON.stringify({
        milestones: [{ id: "M001", status: "active" }],
        slices: [],
        tasks: [],
        assessments: [null],
      }),
    }));
    assert.equal(interpretation.sources[0]?.outcome, "unparsed");
    assert.deepEqual(interpretation.candidates, []);
    assert.ok(interpretation.diagnoses.some((diagnosis) => (
      diagnosis.code === "invalid-assessment-manifest"
    )));
  });

  test("emits no truth from a mixed manifest when its lifecycle schema is invalid", (t) => {
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": JSON.stringify({
        milestones: [{ id: 1, status: "active" }],
        slices: [],
        tasks: [],
        assessments: [{
          milestone_id: "M001",
          slice_id: "S01",
          status: "pass",
          scope: "run-uat",
          full_content: "**Verdict:** PASS",
        }],
      }),
      "milestones/M001/M001-SUMMARY.md": "# M001 Summary\n",
    }));
    assert.ok(interpretation.sources.some((source) => source.outcome === "unparsed"));
    assert.ok(interpretation.diagnoses.some((diagnosis) => (
      diagnosis.code === "unsupported-lifecycle-manifest-schema"
    )));
    assert.deepEqual(interpretation.candidates.map((candidate) => candidate.target), [{
      kind: "legacy-artifact",
      key: ".gsd/milestones/M001/M001-SUMMARY.md",
    }]);
  });

  test("does not derive projection conflicts from an invalid mixed manifest", (t) => {
    const interpretation = interpretLegacyGsdCapture(captureFiles(t, {
      "state-manifest.json": JSON.stringify({
        milestones: [{ id: "M001", status: "active" }],
        slices: [],
        tasks: [],
        assessments: [null],
      }),
      "milestones/M001/M001-SUMMARY.md": "# M001 Summary\n",
    }));
    assert.ok(interpretation.sources.some((source) => source.outcome === "unparsed"));
    assert.ok(!interpretation.candidates.some((candidate) => (
      candidate.reason_code === "milestone-summary-precedence"
    )));
    assert.ok(!interpretation.diagnoses.some((diagnosis) => (
      diagnosis.code === "projection-conflicts-with-adopted-lifecycle"
    )));
    assert.ok(interpretation.candidates.some((candidate) => (
      candidate.target.kind === "legacy-artifact"
      && candidate.target.key === ".gsd/milestones/M001/M001-SUMMARY.md"
    )));
  });
});
