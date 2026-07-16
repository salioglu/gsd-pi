// Project/App: gsd-pi
// File Purpose: Pure lifecycle truth reconciliation from retained GSD projections and DB observations.

import type { LegacyImportTarget, LegacyImportValue } from "./legacy-import-contract.js";
import type { LegacyImportGsdDatabaseEvidence, LegacyImportGsdDatabaseObservation } from "./legacy-import-preview-gsd.js";
import {
  addLegacyImportCandidate,
  addLegacyImportDiagnosis,
  type LegacyImportDecodedSourceFile,
  type LegacyImportPendingCandidate,
  type LegacyImportPendingDiagnosis,
  type LegacyImportSourceLine,
} from "./legacy-import-preview-interpretation.js";
import { parseLegacyImportJson, type LegacyImportJsonDocument } from "./legacy-import-preview-json.js";
import { hashLegacyImportBytes, hashLegacyImportValue } from "./legacy-import-preview.js";

type SourceFile = LegacyImportDecodedSourceFile;
type SourceLine = LegacyImportSourceLine;
type PendingCandidate = LegacyImportPendingCandidate;
type PendingDiagnosis = LegacyImportPendingDiagnosis;
type JsonRecord = Record<string, LegacyImportValue>;

interface ManifestRecord {
  index: number;
  value: JsonRecord;
}

interface ManifestState {
  file: SourceFile;
  document: LegacyImportJsonDocument;
  milestones: readonly ManifestRecord[];
  slices: readonly ManifestRecord[];
  tasks: readonly ManifestRecord[];
}

type ArtifactRole =
  | "milestone-roadmap"
  | "milestone-summary"
  | "milestone-parked"
  | "slice-plan"
  | "slice-summary"
  | "nested-task-plan"
  | "nested-task-summary"
  | "flat-task-summary";

interface LifecycleArtifact {
  file: SourceFile;
  role: ArtifactRole;
  milestoneId: string;
  sliceId?: string;
  taskId?: string;
}

interface CheckboxClaim {
  id: string;
  checked: boolean;
  line: SourceLine;
}

const MANIFEST_PATH = ".gsd/state-manifest.json";
const MILESTONE_ID = "M\\d+(?:-[a-z0-9]+)?";
const SLICE_ID = "S\\d+";
const TASK_ID = "T\\d+";

function asRecord(value: LegacyImportValue | undefined): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function records(value: LegacyImportValue | undefined): ManifestRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    const record = asRecord(entry);
    return record === undefined ? [] : [{ index, value: record }];
  });
}

function lifecycleIdentity(
  record: ManifestRecord,
  fields: readonly string[],
  patterns: readonly RegExp[],
): string | undefined {
  const values = fields.map((field, index) => {
    const value = textField(record.value, field);
    return value !== undefined && patterns[index].test(value) ? value : undefined;
  });
  const status = textField(record.value, "status");
  return status !== undefined && values.every((value) => value !== undefined)
    ? values.join("/")
    : undefined;
}

function uniqueLifecycleIdentities(
  recordsToValidate: readonly ManifestRecord[],
  fields: readonly string[],
  patterns: readonly RegExp[],
): Set<string> | undefined {
  const identities = recordsToValidate.map((record) => lifecycleIdentity(record, fields, patterns));
  if (identities.some((identity) => identity === undefined)) return undefined;
  const values = identities as string[];
  const unique = new Set(values);
  return unique.size === values.length ? unique : undefined;
}

function textField(record: JsonRecord, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function lineMatching(file: SourceFile, pattern: RegExp): SourceLine | undefined {
  return file.lines.find((line) => pattern.test(line.text));
}

function proseLine(file: SourceFile): SourceLine | undefined {
  return file.lines.find((line) => (
    line.text.trim().length > 0
    && !line.text.startsWith("#")
    && !/^\s*-\s+\[[ xX]\]/u.test(line.text)
  ));
}

function addLineCandidate(
  candidates: PendingCandidate[],
  artifact: LifecycleArtifact,
  target: LegacyImportTarget,
  normalized: LegacyImportValue,
  reason: string,
  line: SourceLine,
  classification: "compare" | "preserve" = "compare",
): void {
  addLegacyImportCandidate(
    candidates,
    artifact.file,
    target,
    normalized,
    reason,
    line.start,
    line.end,
    classification,
  );
}

function diagnoseLine(
  diagnoses: PendingDiagnosis[],
  artifact: LifecycleArtifact,
  code: string,
  severity: "info" | "warning" | "blocker",
  message: string,
  disposition: "mapped" | "preserved" | "requires-user",
  line: SourceLine,
  target?: LegacyImportTarget,
): void {
  addLegacyImportDiagnosis(
    diagnoses,
    artifact.file,
    code,
    severity,
    message,
    disposition,
    line.start,
    line.end,
    target,
  );
}

function jsonLine(file: SourceFile, start: number): number {
  return file.bytes.subarray(0, start).reduce((line, byte) => line + (byte === 10 ? 1 : 0), 1);
}

function addJsonCandidate(
  candidates: PendingCandidate[],
  state: ManifestState,
  pointer: string,
  target: LegacyImportTarget,
  normalized: LegacyImportValue,
  reason: string,
  classification: "compare" | "preserve" = "compare",
): void {
  const token = state.document.locate(pointer);
  candidates.push({
    classification,
    target,
    raw: {
      source_id: state.file.entry.source_id,
      locator: {
        start_byte: token.start_byte,
        end_byte: token.end_byte,
        line: jsonLine(state.file, token.start_byte),
        json_pointer: pointer,
      },
      value: token.value,
      sha256: hashLegacyImportBytes(state.file.bytes.subarray(token.start_byte, token.end_byte)),
    },
    normalized,
    provenance: {
      source_id: state.file.entry.source_id,
      parser_id: state.file.parserId,
      parser_version: state.file.parserVersion,
    },
    reason_code: reason,
  });
}

function rejectManifestSchema(file: SourceFile, diagnoses: PendingDiagnosis[]): undefined {
  file.outcome = "unparsed";
  addLegacyImportDiagnosis(
    diagnoses,
    file,
    "unsupported-lifecycle-manifest-schema",
    "blocker",
    "The lifecycle manifest cannot be safely interpreted as unique structured JSON.",
    "requires-user",
  );
  return undefined;
}

function parseManifest(files: readonly SourceFile[], diagnoses: PendingDiagnosis[]): ManifestState | undefined {
  const file = files.find((candidate) => candidate.entry.logical_path.toLowerCase() === MANIFEST_PATH);
  if (file === undefined || file.outcome === "unparsed" || file.encoding !== "utf-8") return undefined;
  let document: LegacyImportJsonDocument;
  try {
    document = parseLegacyImportJson(file.bytes);
  } catch {
    return rejectManifestSchema(file, diagnoses);
  }
  const root = asRecord(document.value);
  if (root === undefined) return rejectManifestSchema(file, diagnoses);
  const lifecycleFields = ["milestones", "slices", "tasks"] as const;
  if (!lifecycleFields.some((field) => field in root)) return undefined;
  if (lifecycleFields.some((field) => (
    root[field] !== undefined
    && (!Array.isArray(root[field]) || root[field].some((entry) => asRecord(entry) === undefined))
  ))) {
    return rejectManifestSchema(file, diagnoses);
  }
  const milestones = records(root.milestones);
  const slices = records(root.slices);
  const tasks = records(root.tasks);
  const milestoneIds = uniqueLifecycleIdentities(milestones, ["id"], [new RegExp(`^${MILESTONE_ID}$`, "u")]);
  const sliceIds = uniqueLifecycleIdentities(
    slices,
    ["milestone_id", "id"],
    [new RegExp(`^${MILESTONE_ID}$`, "u"), new RegExp(`^${SLICE_ID}$`, "u")],
  );
  const taskIds = uniqueLifecycleIdentities(
    tasks,
    ["milestone_id", "slice_id", "id"],
    [new RegExp(`^${MILESTONE_ID}$`, "u"), new RegExp(`^${SLICE_ID}$`, "u"), new RegExp(`^${TASK_ID}$`, "u")],
  );
  if (
    milestoneIds === undefined
    || sliceIds === undefined
    || taskIds === undefined
    || [...sliceIds].some((identity) => !milestoneIds.has(identity.split("/")[0]))
    || [...taskIds].some((identity) => !sliceIds.has(identity.split("/").slice(0, 2).join("/")))
  ) {
    return rejectManifestSchema(file, diagnoses);
  }
  file.parserId = "gsd-lifecycle-truth";
  file.kind = "json";
  file.outcome = "mapped";
  return {
    file,
    document,
    milestones,
    slices,
    tasks,
  };
}

export function validateLegacyGsdLifecycleManifest(
  files: readonly SourceFile[],
  diagnoses: PendingDiagnosis[],
): void {
  parseManifest(files, diagnoses);
}

function artifactFor(file: SourceFile): LifecycleArtifact | undefined {
  if (file.encoding !== "utf-8" || file.outcome === "unparsed") return undefined;
  const path = file.entry.logical_path;
  let match = new RegExp(`^\\.gsd/milestones/(${MILESTONE_ID})/\\1-(ROADMAP|SUMMARY|PARKED)\\.md$`, "u").exec(path);
  if (match !== null) {
    const role = {
      ROADMAP: "milestone-roadmap",
      SUMMARY: "milestone-summary",
      PARKED: "milestone-parked",
    } as const;
    return { file, role: role[match[2] as keyof typeof role], milestoneId: match[1] };
  }
  match = new RegExp(`^\\.gsd/milestones/(${MILESTONE_ID})/slices/(${SLICE_ID})/\\2-(PLAN|SUMMARY)\\.md$`, "u").exec(path);
  if (match !== null) {
    return {
      file,
      role: match[3] === "PLAN" ? "slice-plan" : "slice-summary",
      milestoneId: match[1],
      sliceId: match[2],
    };
  }
  match = new RegExp(`^\\.gsd/milestones/(${MILESTONE_ID})/slices/(${SLICE_ID})/tasks/(${TASK_ID})/\\3-(PLAN|SUMMARY)\\.md$`, "u").exec(path);
  if (match !== null) {
    return {
      file,
      role: match[4] === "PLAN" ? "nested-task-plan" : "nested-task-summary",
      milestoneId: match[1],
      sliceId: match[2],
      taskId: match[3],
    };
  }
  match = new RegExp(`^\\.gsd/milestones/(${MILESTONE_ID})/slices/(${SLICE_ID})/(${TASK_ID})-SUMMARY\\.md$`, "u").exec(path);
  return match === null ? undefined : {
    file,
    role: "flat-task-summary",
    milestoneId: match[1],
    sliceId: match[2],
    taskId: match[3],
  };
}

function artifactKey(artifact: LifecycleArtifact): string {
  return [artifact.milestoneId, artifact.sliceId, artifact.taskId, artifact.role]
    .filter((value) => value !== undefined)
    .join("/");
}

function artifactsByRole(artifacts: readonly LifecycleArtifact[]): Map<string, LifecycleArtifact> {
  return new Map(artifacts.map((artifact) => [artifactKey(artifact), artifact]));
}

function artifactAt(
  byRole: ReadonlyMap<string, LifecycleArtifact>,
  milestoneId: string,
  role: ArtifactRole,
  sliceId?: string,
  taskId?: string,
): LifecycleArtifact | undefined {
  return byRole.get([milestoneId, sliceId, taskId, role]
    .filter((value) => value !== undefined)
    .join("/"));
}

function markArtifacts(artifacts: readonly LifecycleArtifact[]): void {
  for (const artifact of artifacts) {
    artifact.file.parserId = "gsd-lifecycle-truth";
    artifact.file.kind = "markdown";
    artifact.file.outcome = "mapped";
  }
}

function checkboxClaims(file: SourceFile, idPrefix: "S" | "T"): CheckboxClaim[] {
  const pattern = new RegExp(`^-\\s+\\[([ xX])\\]\\s+(${idPrefix}\\d+):?\\s+.+$`, "u");
  return file.lines.flatMap((line) => {
    const match = pattern.exec(line.text);
    return match === null ? [] : [{ id: match[2], checked: match[1].toLowerCase() === "x", line }];
  });
}

function isComplete(status: string): boolean {
  return status === "complete" || status === "completed" || status === "passed";
}

function manifestIdentity(record: ManifestRecord, ...fields: string[]): string[] | undefined {
  const values = fields.map((field) => textField(record.value, field));
  return values.every((value) => value !== undefined) ? values as string[] : undefined;
}

function interpretManifest(
  state: ManifestState,
  byRole: ReadonlyMap<string, LifecycleArtifact>,
  candidates: PendingCandidate[],
): void {
  for (const milestone of state.milestones) {
    const identity = manifestIdentity(milestone, "id");
    const status = textField(milestone.value, "status");
    if (identity === undefined || status === undefined || status === "pending") continue;
    const [milestoneId] = identity;
    const summary = artifactAt(byRole, milestoneId, "milestone-summary");
    const conflict = summary !== undefined && !isComplete(status);
    addJsonCandidate(
      candidates,
      state,
      `/milestones/${milestone.index}/status`,
      conflict
        ? { kind: "legacy-evidence", key: `${milestoneId}/structured-status` }
        : { kind: "milestone-status", key: milestoneId },
      conflict ? { status, authority: "state-manifest" } : status,
      conflict ? "structured-lifecycle-conflict-evidence" : "manifest-milestone-status",
      conflict ? "preserve" : "compare",
    );
  }

  for (const slice of state.slices) {
    const identity = manifestIdentity(slice, "milestone_id", "id");
    if (identity === undefined) continue;
    const [milestoneId, sliceId] = identity;
    const status = textField(slice.value, "status");
    const summary = artifactAt(byRole, milestoneId, "slice-summary", sliceId);
    if (status !== undefined && status !== "pending") {
      const conflict = summary !== undefined && !isComplete(status);
      addJsonCandidate(
        candidates,
        state,
        `/slices/${slice.index}/status`,
        conflict
          ? { kind: "legacy-evidence", key: `${milestoneId}/${sliceId}/structured-status` }
          : { kind: "slice-status", key: `${milestoneId}/${sliceId}` },
        conflict ? { status, authority: "state-manifest" } : status,
        conflict ? "adopted-lifecycle-authority" : "manifest-slice-status",
        conflict ? "preserve" : "compare",
      );
    }
    if (slice.value.is_sketch === true || slice.value.is_sketch === 1) {
      const taskCount = state.tasks.filter((task) => (
        textField(task.value, "milestone_id") === milestoneId
        && textField(task.value, "slice_id") === sliceId
      )).length;
      addJsonCandidate(
        candidates,
        state,
        `/slices/${slice.index}/is_sketch`,
        { kind: "slice", key: `${milestoneId}/${sliceId}` },
        { status: status ?? "pending", is_sketch: true, task_count: taskCount },
        "sketch-slice-has-no-task-inference",
      );
    }
  }

  for (const task of state.tasks) {
    const identity = manifestIdentity(task, "milestone_id", "slice_id", "id");
    if (identity === undefined) continue;
    const [milestoneId, sliceId, taskId] = identity;
    const key = `${milestoneId}/${sliceId}/${taskId}`;
    const status = textField(task.value, "status");
    if (status !== undefined) {
      addJsonCandidate(
        candidates,
        state,
        `/tasks/${task.index}/status`,
        { kind: "task-status", key },
        status === "skipped" ? "cancelled" : status,
        status === "skipped" ? "legacy-skipped-means-cancelled" : "manifest-task-status",
      );
    }
    for (const field of ["narrative", "full_summary_md"] as const) {
      if (field === "narrative" && status === "skipped") continue;
      const value = textField(task.value, field);
      if (value === undefined) continue;
      addJsonCandidate(
        candidates,
        state,
        `/tasks/${task.index}/${field}`,
        { kind: "task", key, field },
        value,
        field === "narrative" ? "manifest-task-narrative-preserved" : "manifest-task-full-summary-preserved",
      );
    }
  }
}

function preserveMarkdownLosses(
  artifacts: readonly LifecycleArtifact[],
  candidates: PendingCandidate[],
  diagnoses: PendingDiagnosis[],
): void {
  for (const artifact of artifacts) {
    const narrative = artifact.role === "nested-task-plan"
      ? lineMatching(artifact.file, /\bnarrative\b/iu)
      : undefined;
    if (narrative !== undefined) {
      artifact.file.outcome = "preserved";
      const target = { kind: "legacy-artifact", key: artifact.file.entry.logical_path, field: "narrative" };
      addLineCandidate(
        candidates,
        artifact,
        target,
        { structured_value: null, preservation: "verbatim-artifact" },
        "markdown-task-narrative-loss",
        narrative,
        "preserve",
      );
      diagnoseLine(
        diagnoses,
        artifact,
        "markdown-task-narrative-loss",
        "warning",
        "Markdown narrative has no structured task narrative representation and is preserved verbatim.",
        "preserved",
        narrative,
        { kind: "legacy-artifact", key: artifact.file.entry.logical_path },
      );
    }

    const fullSummary = artifact.role === "slice-summary"
      ? lineMatching(artifact.file, /\bfull_summary_md\b/iu)
      : undefined;
    if (fullSummary !== undefined) {
      const target = { kind: "legacy-artifact", key: artifact.file.entry.logical_path, field: "full_summary_md" };
      addLineCandidate(
        candidates,
        artifact,
        target,
        { structured_value: null, preservation: "verbatim-artifact" },
        "markdown-task-full-summary-md-loss",
        fullSummary,
        "preserve",
      );
      diagnoseLine(
        diagnoses,
        artifact,
        "markdown-task-full-summary-md-loss",
        "warning",
        "Markdown summary prose has no structured full_summary_md representation and is preserved verbatim.",
        "preserved",
        fullSummary,
        { kind: "legacy-artifact", key: artifact.file.entry.logical_path },
      );
    }
  }
}

function interpretMilestones(
  state: ManifestState,
  artifacts: readonly LifecycleArtifact[],
  byRole: ReadonlyMap<string, LifecycleArtifact>,
  candidates: PendingCandidate[],
  diagnoses: PendingDiagnosis[],
): void {
  const manifestStatuses = new Map(state.milestones.flatMap((record) => {
    const id = textField(record.value, "id");
    const status = textField(record.value, "status");
    return id === undefined || status === undefined ? [] : [[id, status] as const];
  }));

  for (const artifact of artifacts.filter((candidate) => candidate.role === "milestone-roadmap")) {
    const slices = checkboxClaims(artifact.file, "S");
    const summary = artifactAt(byRole, artifact.milestoneId, "milestone-summary");
    if (slices.length === 0 || slices.some((slice) => !slice.checked) || summary !== undefined) continue;
    const lastSlice = slices.at(-1);
    if (lastSlice === undefined) continue;
    const start = slices[0].line.start;
    const end = lastSlice.line.end;
    const target = { kind: "milestone-status", key: artifact.milestoneId };
    addLegacyImportCandidate(
      candidates,
      artifact.file,
      target,
      "complete",
      "all-roadmap-slices-checked",
      start,
      end,
    );
    const raw = artifact.file.bytes.subarray(start, end).toString("utf8");
    addLegacyImportDiagnosis(
      diagnoses,
      artifact.file,
      "checkbox-only-completion-advisory",
      "info",
      "All roadmap slice checkboxes imply completion but provide no milestone summary attestation.",
      "mapped",
      start,
      end,
      target,
      raw,
    );
    addLegacyImportDiagnosis(
      diagnoses,
      artifact.file,
      "incomplete-success-signal",
      "info",
      "Checkbox-only milestone success remains advisory because no summary exists.",
      "mapped",
      start,
      end,
      target,
      raw,
    );
  }

  for (const artifact of artifacts.filter((candidate) => candidate.role === "milestone-summary")) {
    const heading = lineMatching(artifact.file, new RegExp(`^#\\s+${artifact.milestoneId}\\s+Summary\\b`, "u"));
    if (heading === undefined) continue;
    const structuredStatus = manifestStatuses.get(artifact.milestoneId);
    const conflict = structuredStatus !== undefined && !isComplete(structuredStatus);
    addLineCandidate(
      candidates,
      artifact,
      conflict
        ? { kind: "legacy-evidence", key: `${artifact.milestoneId}/summary-status` }
        : { kind: "milestone-status", key: artifact.milestoneId },
      conflict ? { status: "complete", authority: "summary-projection" } : "complete",
      conflict ? "milestone-summary-precedence" : "milestone-summary-attestation",
      heading,
      conflict ? "preserve" : "compare",
    );
    if (conflict) {
      diagnoseLine(
        diagnoses,
        artifact,
        "projection-conflicts-with-adopted-lifecycle",
        "blocker",
        "The milestone summary projection conflicts with the structured active milestone status.",
        "requires-user",
        heading,
      );
    }
  }

  for (const artifact of artifacts.filter((candidate) => candidate.role === "milestone-parked")) {
    const summary = artifactAt(byRole, artifact.milestoneId, "milestone-summary");
    if (summary !== undefined) {
      artifact.file.outcome = "preserved";
      continue;
    }
    const heading = lineMatching(artifact.file, new RegExp(`^#\\s+${artifact.milestoneId}\\s+Parked\\b`, "u"));
    if (heading !== undefined) {
      addLineCandidate(
        candidates,
        artifact,
        { kind: "milestone-status", key: artifact.milestoneId },
        "parked",
        "parked-marker-without-summary",
        heading,
      );
    }
  }
}

function diagnoseFlatTaskSummary(
  artifact: LifecycleArtifact,
  nestedPlans: readonly LifecycleArtifact[],
  diagnoses: PendingDiagnosis[],
): void {
  const conflictingParent = nestedPlans.some((plan) => (
    plan.milestoneId === artifact.milestoneId
    && plan.taskId === artifact.taskId
    && plan.sliceId !== artifact.sliceId
  ));
  if (!conflictingParent) return;
  artifact.file.outcome = "unparsed";
  const evidence = proseLine(artifact.file) ?? artifact.file.lines[0];
  diagnoseLine(
    diagnoses,
    artifact,
    "task-summary-parent-conflict",
    "blocker",
    "A summary under another slice cannot complete the checked nested task.",
    "requires-user",
    evidence,
  );
}

function interpretTasksAndSlices(
  state: ManifestState,
  artifacts: readonly LifecycleArtifact[],
  byRole: ReadonlyMap<string, LifecycleArtifact>,
  candidates: PendingCandidate[],
  diagnoses: PendingDiagnosis[],
): void {
  const nestedPlans = artifacts.filter((artifact) => artifact.role === "nested-task-plan");
  for (const artifact of artifacts.filter((candidate) => candidate.role === "flat-task-summary")) {
    diagnoseFlatTaskSummary(artifact, nestedPlans, diagnoses);
  }

  const taskStatuses = new Map<string, "complete" | "pending">();
  for (const plan of artifacts.filter((artifact) => artifact.role === "slice-plan")) {
    for (const task of checkboxClaims(plan.file, "T")) {
      const key = `${plan.milestoneId}/${plan.sliceId}/${task.id}`;
      const nestedPlan = artifactAt(byRole, plan.milestoneId, "nested-task-plan", plan.sliceId, task.id);
      const summary = artifactAt(byRole, plan.milestoneId, "nested-task-summary", plan.sliceId, task.id);
      if (summary !== undefined) {
        const heading = lineMatching(summary.file, new RegExp(`^#\\s+${task.id}\\s+Summary\\b`, "u"));
        if (heading !== undefined) {
          addLineCandidate(
            candidates,
            summary,
            { kind: "task-status", key },
            "complete",
            "matching-task-summary-attestation",
            heading,
          );
          if (!task.checked) {
            diagnoseLine(
              diagnoses,
              summary,
              "summary-overrides-unchecked-task",
              "info",
              "The matching task summary completes the unchecked nested task.",
              "mapped",
              heading,
              { kind: "task-status", key },
            );
          }
          taskStatuses.set(key, "complete");
          continue;
        }
      }
      if (task.checked && nestedPlan !== undefined) {
        addLineCandidate(
          candidates,
          plan,
          { kind: "task-status", key },
          "pending",
          "nested-task-requires-matching-summary",
          task.line,
        );
        taskStatuses.set(key, "pending");
      } else if (task.checked) {
        addLineCandidate(
          candidates,
          plan,
          { kind: "task-status", key },
          "complete",
          "flat-checkbox-complete",
          task.line,
        );
        taskStatuses.set(key, "complete");
      } else {
        taskStatuses.set(key, "pending");
      }
    }
  }

  const manifestSliceStatuses = new Map(state.slices.flatMap((record) => {
    const identity = manifestIdentity(record, "milestone_id", "id");
    const status = textField(record.value, "status");
    return identity === undefined || status === undefined ? [] : [[identity.join("/"), status] as const];
  }));
  for (const summary of artifacts.filter((artifact) => artifact.role === "slice-summary")) {
    const key = `${summary.milestoneId}/${summary.sliceId}`;
    const structuredStatus = manifestSliceStatuses.get(key);
    const conflict = structuredStatus !== undefined && !isComplete(structuredStatus);
    if (conflict) {
      summary.file.outcome = "unparsed";
      const evidence = proseLine(summary.file) ?? summary.file.lines[0];
      diagnoseLine(
        diagnoses,
        summary,
        "projection-conflicts-with-adopted-lifecycle",
        "blocker",
        "A Markdown completion projection conflicts with adopted lifecycle authority.",
        "requires-user",
        evidence,
      );
      continue;
    }
    const plan = artifactAt(byRole, summary.milestoneId, "slice-plan", summary.sliceId);
    const tasks = plan === undefined ? [] : checkboxClaims(plan.file, "T");
    if (tasks.length === 0 || tasks.some((task) => taskStatuses.get(`${key}/${task.id}`) !== "complete")) continue;
    const heading = lineMatching(summary.file, new RegExp(`^#\\s+${summary.sliceId}\\s+Summary\\b`, "u"));
    if (heading === undefined) continue;
    const target = { kind: "slice-status", key };
    addLineCandidate(
      candidates,
      summary,
      target,
      "complete",
      "all-tasks-complete-with-slice-summary",
      heading,
    );
    const roadmap = artifactAt(byRole, summary.milestoneId, "milestone-roadmap");
    const roadmapSlice = roadmap === undefined
      ? undefined
      : checkboxClaims(roadmap.file, "S").find((slice) => slice.id === summary.sliceId);
    if (roadmap !== undefined && roadmapSlice !== undefined && !roadmapSlice.checked) {
      diagnoseLine(
        diagnoses,
        roadmap,
        "slice-summary-upgrades-unchecked-roadmap",
        "info",
        "The unchecked slice upgrades only because all tasks are complete and the matching slice summary exists.",
        "mapped",
        roadmapSlice.line,
        target,
      );
    }
  }
}

function dependencyValues(observations: readonly LegacyImportGsdDatabaseObservation[]): string[] {
  return observations.flatMap((observation) => (
    Array.isArray(observation.value)
      ? observation.value.filter((value): value is string => typeof value === "string")
      : typeof observation.value === "string" ? [observation.value] : []
  )).sort();
}

function interpretDatabaseConflicts(
  files: readonly SourceFile[],
  evidenceSet: readonly LegacyImportGsdDatabaseEvidence[],
  candidates: PendingCandidate[],
  diagnoses: PendingDiagnosis[],
): void {
  for (const evidence of evidenceSet) {
    const database = files.find((file) => file.entry.source_id === evidence.source_id);
    if (database === undefined) continue;
    const groups = new Map<string, { column: LegacyImportGsdDatabaseObservation[]; junction: LegacyImportGsdDatabaseObservation[] }>();
    for (const observation of evidence.observations) {
      const milestoneId = observation.key.milestone_id;
      const sliceId = observation.table === "slices" ? observation.key.id : observation.key.slice_id;
      if (milestoneId === undefined || sliceId === undefined) continue;
      const key = `${milestoneId}/${sliceId}`;
      const group = groups.get(key) ?? { column: [], junction: [] };
      group[observation.table === "slices" ? "column" : "junction"].push(observation);
      groups.set(key, group);
    }
    for (const [key, group] of groups) {
      if (
        group.column.length === 0
        || group.junction.length === 0
        || hashLegacyImportValue(dependencyValues(group.column)) === hashLegacyImportValue(dependencyValues(group.junction))
      ) {
        continue;
      }
      for (const observation of [...group.column, ...group.junction]) {
        const junction = observation.table === "slice_dependencies";
        candidates.push({
          classification: "preserve",
          target: { kind: "legacy-evidence", key: `${key}/${junction ? "dependency-junction" : "depends-column"}` },
          raw: {
            source_id: database.entry.source_id,
            locator: observation.raw.locator,
            value: observation.raw.value,
            sha256: observation.raw.sha256,
          },
          normalized: {
            representation: junction ? "database slice_dependencies" : "database slices.depends",
            value: junction ? [observation.value] : observation.value,
          },
          provenance: {
            source_id: database.entry.source_id,
            parser_id: database.parserId,
            parser_version: database.parserVersion,
          },
          reason_code: "dependency-conflict-raw-evidence",
        });
      }
      const anchor = group.junction[0];
      const identity = {
        code: "slices-depends-vs-slice-dependencies-conflict",
        severity: "blocker" as const,
        source_id: database.entry.source_id,
        locator: anchor.raw.locator,
        raw_value: { redacted: true, sha256: anchor.raw.sha256 },
        message: "The database slices.depends column conflicts with the database slice_dependencies junction row; both representations are preserved.",
      };
      diagnoses.push({
        diagnosis_id: hashLegacyImportValue(identity),
        ...identity,
        resolution: { disposition: "requires-user" },
      });
    }
  }
}

export function interpretLegacyGsdLifecycle(
  files: readonly SourceFile[],
  databaseEvidence: readonly LegacyImportGsdDatabaseEvidence[],
  candidates: PendingCandidate[],
  diagnoses: PendingDiagnosis[],
): void {
  interpretDatabaseConflicts(files, databaseEvidence, candidates, diagnoses);
  const state = parseManifest(files, diagnoses);
  if (state === undefined) return;
  const artifacts = files.flatMap((file) => artifactFor(file) ?? []);
  if (state.milestones.length === 0 && state.slices.length === 0 && state.tasks.length === 0) return;
  markArtifacts(artifacts);
  const byRole = artifactsByRole(artifacts);
  interpretManifest(state, byRole, candidates);
  interpretMilestones(state, artifacts, byRole, candidates, diagnoses);
  interpretTasksAndSlices(state, artifacts, byRole, candidates, diagnoses);
  preserveMarkdownLosses(artifacts, candidates, diagnoses);
}
