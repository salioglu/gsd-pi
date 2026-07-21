import {
  applyPreparedVerifiedRecoverApplication,
  loadRetainedVerifiedRecoverApplication,
  loadVerifiedRecoverApplication,
  prepareVerifiedRecoverApplication,
  type PreparedVerifiedRecoverApplication,
  type VerifiedRecoverApplicationResult,
} from "./db-workspace.js";
import {
  executeLegacyImportRecoveryAction,
  parseLegacyImportRecoveryAction,
} from "./legacy-import-recovery-action.js";
import { parseLegacyImportForwardRepairChoices } from "./legacy-import-forward-repair-choice-token.js";
import {
  LEGACY_IMPORT_RESTORE_ASSESSMENT_CONSENT_SCHEMA_VERSION,
  type LegacyImportRestoreAssessmentConsent,
} from "./legacy-import-restore-assessment.js";

export interface LegacyImportRecoveryExecution {
  readonly application: VerifiedRecoverApplicationResult;
  readonly applicationId: string | null;
  readonly appliedPreview: boolean;
  readonly recoveryAction: ReturnType<typeof executeLegacyImportRecoveryAction>;
}

export interface LegacyImportRecoveryExecutionInput {
  readonly basePath: string;
  readonly args: string;
  approvePrepared(
    prepared: Readonly<PreparedVerifiedRecoverApplication>,
    approvedPreviewHash: string | null,
  ): Promise<boolean>;
}

function parseRecoveryRequest(args: string): {
  action: ReturnType<typeof parseLegacyImportRecoveryAction>;
  choices: ReturnType<typeof parseLegacyImportForwardRepairChoices>;
} {
  return {
    action: parseLegacyImportRecoveryAction(args.trim().split(/\s+/u).filter(Boolean)),
    choices: parseLegacyImportForwardRepairChoices(args),
  };
}

export function validateLegacyImportRecoveryRequest(args: string): void {
  parseRecoveryRequest(args);
}

function requestedArgument(args: string, name: string): string | null {
  return new RegExp(`(?:^|\\s)--${name}=([^\\s]+)(?=\\s|$)`, "u").exec(args)?.[1] ?? null;
}

function requestedPreviewApproval(args: string): string | null {
  return /(?:^|\s)--preview=(sha256:[0-9a-f]{64})(?=\s|$)/u.exec(args)?.[1] ?? null;
}

function requestedRestoreConsent(args: string): LegacyImportRestoreAssessmentConsent | undefined {
  const evidenceHash = /(?:^|\s)--consent=proceed:destructive-database-restore:(sha256:[0-9a-f]{64})(?=\s|$)/u.exec(args)?.[1];
  return evidenceHash ? {
    consentSchemaVersion: LEGACY_IMPORT_RESTORE_ASSESSMENT_CONSENT_SCHEMA_VERSION,
    decision: "proceed",
    destructiveDatabaseRestore: true,
    evidenceHash,
  } : undefined;
}

export async function executeLegacyImportRecovery(
  input: Readonly<LegacyImportRecoveryExecutionInput>,
): Promise<LegacyImportRecoveryExecution | null> {
  const { action, choices } = parseRecoveryRequest(input.args);
  const applicationId = requestedArgument(input.args, "application");
  if (!applicationId && action !== "assess") {
    throw new Error("run gsd recover assessment first, then use its --application evidence");
  }
  let application = applicationId
    ? loadVerifiedRecoverApplication(applicationId)
    : loadRetainedVerifiedRecoverApplication();
  let appliedPreview = false;
  if (!application) {
    const prepared = prepareVerifiedRecoverApplication(input.basePath);
    const approvedPreviewHash = requestedPreviewApproval(input.args);
    if (!(await input.approvePrepared(prepared, approvedPreviewHash))) return null;
    application = applyPreparedVerifiedRecoverApplication(prepared, prepared.preview.preview_hash);
    appliedPreview = true;
  }
  return {
    application,
    applicationId,
    appliedPreview,
    recoveryAction: executeLegacyImportRecoveryAction(
      application,
      action,
      choices,
      requestedRestoreConsent(input.args),
    ),
  };
}
