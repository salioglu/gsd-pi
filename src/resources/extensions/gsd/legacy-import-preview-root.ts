// Project/App: gsd-pi
// File Purpose: Pure legacy repository-root projection contributions from retained source bytes.

import {
  addLegacyImportCandidate,
  type LegacyImportDecodedSourceFile,
  type LegacyImportPendingCandidate,
} from "./legacy-import-preview-interpretation.js";

interface RootProjection {
  role: string;
  reasonCode: string;
}

const ROOT_PROJECTIONS: Readonly<Record<string, RootProjection>> = {
  ".gsd/PROJECT.md": {
    role: "readable-status-projection",
    reasonCode: "root-project-projection-preserved",
  },
  ".gsd/QUEUE.md": {
    role: "database-queue-projection",
    reasonCode: "root-queue-projection-preserved",
  },
};

function isSanitizedSecretsManifest(text: string): boolean {
  return /No credential material is included/iu.test(text)
    && /Required environment keys:\s*none/iu.test(text);
}

export function contributeLegacyRootProjections(
  files: readonly LegacyImportDecodedSourceFile[],
  candidates: LegacyImportPendingCandidate[],
): void {
  for (const file of files) {
    const path = file.entry.logical_path;
    const projection = ROOT_PROJECTIONS[path];
    if (projection !== undefined && file.encoding === "utf-8") {
      file.parserId = "gsd-artifact-classifier";
      file.kind = "markdown";
      file.outcome = "preserved";
      addLegacyImportCandidate(
        candidates,
        file,
        { kind: "artifact", key: path },
        { path, preservation: "verbatim", role: projection.role },
        projection.reasonCode,
        0,
        file.bytes.length,
        "preserve",
      );
      continue;
    }
    if (path !== ".gsd/SECRETS-MANIFEST.md" || file.encoding !== "utf-8") continue;
    file.parserId = "gsd-artifact-classifier";
    file.kind = "markdown";
    file.outcome = "preserved";
    const sanitized = isSanitizedSecretsManifest(file.text);
    addLegacyImportCandidate(
      candidates,
      file,
      { kind: "artifact", key: path },
      {
        ...(sanitized ? { contains_secrets: false } : {}),
        path,
        preservation: "verbatim",
        role: sanitized ? "sanitized-manifest" : "secrets-manifest",
      },
      sanitized ? "sanitized-secrets-manifest-preserved" : "secrets-manifest-preserved",
      0,
      file.bytes.length,
      "preserve",
    );
  }
}
