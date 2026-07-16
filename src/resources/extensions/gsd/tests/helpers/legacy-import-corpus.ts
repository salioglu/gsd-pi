// Project/App: gsd-pi
// File Purpose: Deterministic test-only loader and validator for legacy import corpus cases.

import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

import AjvModule from "ajv/dist/2020.js";

import {
  LEGACY_IMPORT_PREVIEW_COUNT_KEYS,
  LEGACY_IMPORT_PREVIEW_TOP_LEVEL_KEYS,
  type LegacyImportLocator,
  type LegacyImportPreviewEnvelope,
  type LegacyImportPreviewSource,
  type LegacyImportSha256,
  type LegacyImportValue,
} from "../../legacy-import-contract.ts";

const Ajv = AjvModule.default ?? AjvModule;

export interface LegacyImportCorpusFile {
  path: string;
  bytes: Buffer;
  byteSize: number;
  sha256: LegacyImportSha256;
  entryKind: "file" | "symlink";
}

export interface LegacyImportCorpusCase {
  name: string;
  files: readonly LegacyImportCorpusFile[];
  oracle: LegacyImportPreviewEnvelope;
  schema: object;
}

function sha256(value: string | Buffer): LegacyImportSha256 {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const properties = Object.keys(record).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${properties.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function legacyImportCorpusHash(value: unknown): LegacyImportSha256 {
  return sha256(canonicalJson(value));
}

function compareNames(left: { name: string }, right: { name: string }): number {
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;
  return 0;
}

function corpusFile(path: string, bytes: Buffer, entryKind: "file" | "symlink"): LegacyImportCorpusFile {
  return { path, bytes, byteSize: bytes.byteLength, sha256: sha256(bytes), entryKind };
}

function discoverFiles(rootPath: string, relativePath = ""): LegacyImportCorpusFile[] {
  const entries = readdirSync(`${rootPath}/${relativePath}`, { withFileTypes: true }).sort(compareNames);
  const files: LegacyImportCorpusFile[] = [];
  for (const entry of entries) {
    const path = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    const absolutePath = `${rootPath}/${path}`;
    if (entry.isDirectory()) {
      files.push(...discoverFiles(rootPath, path));
    } else if (entry.isFile()) {
      files.push(corpusFile(path, readFileSync(absolutePath), "file"));
    } else if (entry.isSymbolicLink()) {
      files.push(corpusFile(path, Buffer.from(readlinkSync(absolutePath), "utf8"), "symlink"));
    } else {
      throw new Error(`corpus source contains unsupported entry: ${path}`);
    }
  }
  return files;
}

export function loadLegacyImportCorpusCase(corpusRoot: URL, caseName: string): LegacyImportCorpusCase {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(caseName)) {
    throw new Error(`invalid corpus case name: ${caseName}`);
  }
  const caseRoot = fileURLToPath(new URL(`./${caseName}/`, corpusRoot));
  return {
    name: caseName,
    files: discoverFiles(`${caseRoot}/source`),
    oracle: JSON.parse(readFileSync(`${caseRoot}/oracle.json`, "utf8")) as LegacyImportPreviewEnvelope,
    schema: JSON.parse(readFileSync(fileURLToPath(new URL("./oracle.schema.json", corpusRoot)), "utf8")) as object,
  };
}

function fail(corpusCase: LegacyImportCorpusCase, path: string, message: string): never {
  throw new Error(`[case ${corpusCase.name}] at ${path}: ${message}`);
}

function evidenceLabel(sourceId: string, locator: LegacyImportLocator): string {
  return `source_id=${sourceId} locator=${canonicalJson(locator)}`;
}

function sourceEvidenceLabel(
  source: Pick<LegacyImportPreviewSource, "source_id" | "outcome">,
  locator: LegacyImportLocator | string,
): string {
  const locatorValue = typeof locator === "string" ? locator : canonicalJson(locator);
  return `source_id=${source.source_id} locator=${locatorValue} expected_disposition=${source.outcome}`;
}

function assertCanonicalOrder<T>(
  corpusCase: LegacyImportCorpusCase,
  values: readonly T[],
  path: string,
  key: (value: T) => string,
): void {
  const actual = values.map(key);
  if (new Set(actual).size !== actual.length) fail(corpusCase, path, "IDs must be unique");
  if (JSON.stringify(actual) !== JSON.stringify([...actual].sort())) {
    fail(corpusCase, path, "entries must use canonical order");
  }
  if (actual.some((value) => value.trim().length === 0)) {
    fail(corpusCase, path, "IDs must be stable non-empty strings");
  }
}

function assertNoTimestamps(corpusCase: LegacyImportCorpusCase, value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoTimestamps(corpusCase, entry, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (key === "timestamp" || key.endsWith("_timestamp") || key.endsWith("_at")) {
      fail(corpusCase, childPath, "timestamps are forbidden");
    }
    assertNoTimestamps(corpusCase, entry, childPath);
  }
}

function assertLocator(
  corpusCase: LegacyImportCorpusCase,
  path: string,
  locator: LegacyImportLocator,
  source: LegacyImportPreviewSource,
  file: LegacyImportCorpusFile,
): Buffer {
  const context = sourceEvidenceLabel(source, locator);
  if (!Number.isInteger(locator.start_byte) || !Number.isInteger(locator.end_byte)) {
    fail(corpusCase, path, `${context}; exact start_byte and end_byte are required`);
  }
  const endByte = locator.end_byte as number;
  if (locator.start_byte < 0 || endByte <= locator.start_byte || endByte > file.byteSize) {
    fail(corpusCase, path, `${context}; byte span is outside ${file.path}`);
  }
  const expectedLine = file.bytes.subarray(0, locator.start_byte).reduce(
    (line, byte) => line + (byte === 10 ? 1 : 0),
    1,
  );
  if (locator.line !== undefined && locator.line !== expectedLine) {
    fail(corpusCase, path, `${context}; line does not match its byte span`);
  }
  return file.bytes.subarray(locator.start_byte, endByte);
}

function resolveJsonPointer(document: unknown, pointer: string): unknown {
  if (pointer === "") return document;
  if (!pointer.startsWith("/")) throw new Error("JSON pointer must be empty or start with /");
  return pointer.slice(1).split("/").reduce<unknown>((value, encodedToken) => {
    if (/~(?:[^01]|$)/.test(encodedToken)) {
      throw new Error(`JSON pointer token has an invalid escape: ${encodedToken}`);
    }
    const token = encodedToken.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) {
        throw new Error(`JSON pointer array token is not a canonical index: ${token}`);
      }
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index >= value.length) {
        throw new Error(`JSON pointer token does not exist: ${token}`);
      }
      return value[index];
    }
    if (value !== null && typeof value === "object" && Object.hasOwn(value, token)) {
      return (value as Record<string, unknown>)[token];
    }
    throw new Error(`JSON pointer token does not exist: ${token}`);
  }, document);
}

function assertJsonPointer(
  corpusCase: LegacyImportCorpusCase,
  path: string,
  locator: LegacyImportLocator,
  source: LegacyImportPreviewSource,
  file: LegacyImportCorpusFile,
  rawBytes: Buffer,
): unknown {
  if (locator.json_pointer === undefined) return undefined;
  const context = sourceEvidenceLabel(source, locator);
  if (!isUtf8(file.bytes) || !isUtf8(rawBytes)) {
    fail(corpusCase, path, `${context}; json_pointer requires UTF-8 evidence`);
  }
  try {
    const pointerValue = resolveJsonPointer(JSON.parse(file.bytes.toString("utf8")), locator.json_pointer);
    const spanValue = JSON.parse(rawBytes.toString("utf8"));
    if (canonicalJson(pointerValue) !== canonicalJson(spanValue)) {
      fail(corpusCase, path, `${context}; JSON pointer and byte span resolve to different values`);
    }
    return pointerValue;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("[case ")) throw error;
    fail(corpusCase, path, `${context}; ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isRedactedEvidence(value: LegacyImportValue): value is { redacted: true; sha256: string } {
  if (value === null || Array.isArray(value) || typeof value !== "object") return false;
  const record = value as Record<string, LegacyImportValue>;
  return Object.keys(record).sort().join(",") === "redacted,sha256"
    && record.redacted === true
    && typeof record.sha256 === "string";
}

function assertRawValue(
  corpusCase: LegacyImportCorpusCase,
  path: string,
  value: LegacyImportValue,
  source: LegacyImportPreviewSource,
  locator: LegacyImportLocator,
  file: LegacyImportCorpusFile,
  rawBytes: Buffer,
  allowRedaction: boolean,
): unknown {
  const pointerValue = assertJsonPointer(corpusCase, `${path}.json_pointer`, locator, source, file, rawBytes);
  const context = sourceEvidenceLabel(source, locator);
  if (allowRedaction && isRedactedEvidence(value)) {
    if (value.sha256 !== sha256(rawBytes)) {
      fail(corpusCase, path, `${context}; redacted evidence hash must cover its exact byte span`);
    }
    return pointerValue;
  }
  if (pointerValue !== undefined && canonicalJson(pointerValue) !== canonicalJson(value)) {
    fail(corpusCase, path, `${context}; raw value must match its JSON pointer and byte span`);
  }
  if (pointerValue !== undefined) return pointerValue;
  if (!isUtf8(rawBytes)) fail(corpusCase, path, `${context}; raw value requires UTF-8 evidence`);
  if (typeof value === "string") {
    if (value !== rawBytes.toString("utf8")) {
      fail(corpusCase, path, `${context}; raw string value must match its exact byte span`);
    }
    return value;
  }
  fail(corpusCase, path, `${context}; non-string raw value requires json_pointer`);
}

function assertRedactedMessage(
  corpusCase: LegacyImportCorpusCase,
  path: string,
  message: string,
  rawValue: LegacyImportValue,
  rawBytes: Buffer,
  pointerValue: unknown,
  source: LegacyImportPreviewSource,
  locator: LegacyImportLocator,
): void {
  if (!isRedactedEvidence(rawValue)) return;
  const protectedValues = new Set<string>();
  if (isUtf8(rawBytes)) protectedValues.add(rawBytes.toString("utf8"));
  if (pointerValue === null || ["string", "number", "boolean"].includes(typeof pointerValue)) {
    protectedValues.add(String(pointerValue));
  }
  for (const protectedValue of protectedValues) {
    if (protectedValue.length > 0 && message.includes(protectedValue)) {
      fail(corpusCase, path, `${sourceEvidenceLabel(source, locator)}; redacted diagnosis message exposes protected content`);
    }
  }
}

function schemaErrorPath(instancePath: string): string {
  if (!instancePath) return "$";
  return `$${instancePath.split("/").slice(1).map((token) => /^[0-9]+$/.test(token)
    ? `[${token}]`
    : `.${token.replace(/~1/g, "/").replace(/~0/g, "~")}`).join("")}`;
}

function validateSchema(corpusCase: LegacyImportCorpusCase): void {
  try {
    const ajv = new Ajv({ allErrors: true, strict: true });
    const validate = ajv.compile(corpusCase.schema);
    if (!validate(corpusCase.oracle)) {
      const path = schemaErrorPath(validate.errors?.[0]?.instancePath ?? "");
      fail(corpusCase, path, `invalid oracle schema: ${ajv.errorsText(validate.errors)}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("[case ")) throw error;
    fail(corpusCase, "$schema", error instanceof Error ? error.message : String(error));
  }
}

export function validateLegacyImportCorpusCase(corpusCase: LegacyImportCorpusCase): void {
  validateSchema(corpusCase);
  const oracle = corpusCase.oracle;
  assertNoTimestamps(corpusCase, oracle);
  if (JSON.stringify(Object.keys(oracle)) !== JSON.stringify(LEGACY_IMPORT_PREVIEW_TOP_LEVEL_KEYS)) {
    fail(corpusCase, "$", "Preview keys must match the exact wire contract and order");
  }
  if (JSON.stringify(Object.keys(oracle.counts)) !== JSON.stringify(LEGACY_IMPORT_PREVIEW_COUNT_KEYS)) {
    fail(corpusCase, "$.counts", "count keys must match the exact wire contract and order");
  }

  assertCanonicalOrder(corpusCase, oracle.sources, "$.sources", (source) => `${source.path}\0${source.source_id}`);
  if (new Set(oracle.sources.map((source) => source.source_id)).size !== oracle.sources.length) {
    fail(corpusCase, "$.sources", "source IDs must be unique");
  }
  assertCanonicalOrder(corpusCase, oracle.changes, "$.changes", (change) => change.change_id);
  assertCanonicalOrder(corpusCase, oracle.diagnoses, "$.diagnoses", (diagnosis) => diagnosis.diagnosis_id);
  assertCanonicalOrder(corpusCase, oracle.resolutions, "$.resolutions", (resolution) => resolution.diagnosis_id);

  const filesByPath = new Map(corpusCase.files.map((file) => [file.path, file]));
  if (oracle.sources.length !== corpusCase.files.length) {
    fail(corpusCase, "$.sources", "oracle must contain exactly one source disposition per discovered entry");
  }
  oracle.sources.forEach((source, index) => {
    const path = `$.sources[${index}]`;
    const file = filesByPath.get(source.path);
    if (!file) fail(corpusCase, path, `${sourceEvidenceLabel(source, source.path)}; oracle source does not exist`);
    if (source.byte_size !== file.byteSize || source.sha256 !== file.sha256) {
      fail(corpusCase, path, `${sourceEvidenceLabel(source, "whole-file")}; source fingerprint does not match bytes`);
    }
    if (file.entryKind === "symlink" && source.kind !== "symlink") {
      fail(corpusCase, `${path}.kind`, `${sourceEvidenceLabel(source, "whole-file")}; symlink evidence must declare kind=symlink`);
    }
    if (source.encoding === "utf-8" && !isUtf8(file.bytes)) {
      fail(corpusCase, `${path}.encoding`, `${sourceEvidenceLabel(source, "whole-file")}; declared UTF-8 source contains invalid UTF-8 bytes`);
    }
    filesByPath.delete(source.path);
  });
  if (filesByPath.size > 0) fail(corpusCase, "$.sources", "discovered entry is missing an explicit disposition");

  const sourcesById = new Map(oracle.sources.map((source) => [source.source_id, source]));
  const filesBySourceId = new Map<string, LegacyImportCorpusFile>();
  for (const source of oracle.sources) {
    const file = corpusCase.files.find((candidate) => candidate.path === source.path);
    if (file) filesBySourceId.set(source.source_id, file);
  }
  oracle.changes.forEach((change, index) => {
    const path = `$.changes[${index}]`;
    const source = sourcesById.get(change.raw.source_id);
    const file = filesBySourceId.get(change.raw.source_id);
    if (!source || !file) {
      fail(corpusCase, `${path}.raw.source_id`, `${evidenceLabel(change.raw.source_id, change.raw.locator)}; raw source is missing`);
    }
    if (change.provenance.source_id !== source.source_id
      || change.provenance.parser_id !== source.parser_id
      || change.provenance.parser_version !== source.parser_version) {
      fail(corpusCase, `${path}.provenance`, `${sourceEvidenceLabel(source, change.raw.locator)}; provenance must match its source parser`);
    }
    const locatorPath = `${path}.raw.locator`;
    const rawBytes = assertLocator(corpusCase, locatorPath, change.raw.locator, source, file);
    if (change.raw.sha256 !== sha256(rawBytes)) {
      fail(corpusCase, locatorPath, `${sourceEvidenceLabel(source, change.raw.locator)}; raw hash must cover its exact byte span`);
    }
    if (change.raw.locator.json_pointer !== undefined && source.encoding !== "utf-8") {
      fail(corpusCase, `${locatorPath}.json_pointer`, `${sourceEvidenceLabel(source, change.raw.locator)}; json_pointer source must declare UTF-8 encoding`);
    }
    assertRawValue(corpusCase, `${path}.raw.value`, change.raw.value, source, change.raw.locator, file, rawBytes, false);
  });

  oracle.diagnoses.forEach((diagnosis, index) => {
    const path = `$.diagnoses[${index}]`;
    const source = sourcesById.get(diagnosis.source_id);
    const file = filesBySourceId.get(diagnosis.source_id);
    if (!source || !file) {
      fail(corpusCase, `${path}.source_id`, `${evidenceLabel(diagnosis.source_id, diagnosis.locator)}; diagnosis source is missing`);
    }
    const rawBytes = assertLocator(corpusCase, `${path}.locator`, diagnosis.locator, source, file);
    if (diagnosis.locator.json_pointer !== undefined && source.encoding !== "utf-8") {
      fail(corpusCase, `${path}.locator.json_pointer`, `${sourceEvidenceLabel(source, diagnosis.locator)}; json_pointer source must declare UTF-8 encoding`);
    }
    const pointerValue = assertRawValue(
      corpusCase,
      `${path}.raw_value`,
      diagnosis.raw_value,
      source,
      diagnosis.locator,
      file,
      rawBytes,
      true,
    );
    assertRedactedMessage(
      corpusCase,
      `${path}.message`,
      diagnosis.message,
      diagnosis.raw_value,
      rawBytes,
      pointerValue,
      source,
      diagnosis.locator,
    );
  });

  const diagnosisIds = new Set(oracle.diagnoses.map((diagnosis) => diagnosis.diagnosis_id));
  const resolutionIds = new Set(oracle.resolutions.map((resolution) => resolution.diagnosis_id));
  for (const diagnosisId of diagnosisIds) {
    if (!resolutionIds.has(diagnosisId)) fail(corpusCase, "$.resolutions", `diagnosis ${diagnosisId} must have exactly one resolution`);
  }
  oracle.resolutions.forEach((resolution, index) => {
    if (!diagnosisIds.has(resolution.diagnosis_id)) {
      fail(corpusCase, `$.resolutions[${index}].diagnosis_id`, `resolution diagnosis is missing: ${resolution.diagnosis_id}`);
    }
  });

  oracle.sources.forEach((source, index) => {
    if (source.outcome !== "ignored-with-reason") return;
    const hasChangeReason = oracle.changes.some((change) => (
      change.raw.source_id === source.source_id && change.reason_code.trim().length > 0
    ));
    const hasResolvedDiagnosis = oracle.diagnoses.some((diagnosis) => (
      diagnosis.source_id === source.source_id && resolutionIds.has(diagnosis.diagnosis_id)
    ));
    if (!hasChangeReason && !hasResolvedDiagnosis) {
      fail(
        corpusCase,
        `$.sources[${index}].outcome`,
        `${sourceEvidenceLabel(source, "whole-file")}; ignored-with-reason requires an attached explicit reason`,
      );
    }
  });

  if (oracle.source_set_hash !== legacyImportCorpusHash(oracle.sources)) {
    fail(corpusCase, "$.source_set_hash", "source_set_hash is not deterministic");
  }
  if (oracle.change_set_hash !== legacyImportCorpusHash(oracle.changes)) {
    fail(corpusCase, "$.change_set_hash", "change_set_hash is not deterministic");
  }
  const counts = {
    create: oracle.changes.filter((change) => change.action === "create").length,
    update: oracle.changes.filter((change) => change.action === "update").length,
    delete: oracle.changes.filter((change) => change.action === "delete").length,
    preserve: oracle.changes.filter((change) => change.action === "preserve").length,
    unparsed: oracle.sources.filter((source) => source.outcome === "unparsed").length,
    unresolved: oracle.resolutions.filter((resolution) => resolution.disposition === "requires-user" || resolution.disposition === "unsupported").length,
  };
  if (canonicalJson(oracle.counts) !== canonicalJson(counts)) {
    fail(corpusCase, "$.counts", "counts do not match their entries");
  }
}
