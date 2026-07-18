// Project/App: gsd-pi
// File Purpose: Context-bound writers for project authority and import recovery receipts.

import type { DomainOperationContext } from "../domain-operation.js";
import { getDb } from "../engine.js";
import { requireActiveDomainOperationContext } from "./lifecycle-commands.js";

export interface AuthorityCutoverReceiptInput {
  readonly authorityContractVersion: number;
  readonly evidenceHash: string;
  readonly consentHash: string;
}

export interface AuthorityCutoverReceiptWriteResult {
  readonly cutoverAt: string;
}

export function insertAuthorityCutoverReceipt(
  context: Readonly<DomainOperationContext>,
  input: Readonly<AuthorityCutoverReceiptInput>,
): AuthorityCutoverReceiptWriteResult {
  if (requireActiveDomainOperationContext(context) !== "authority.cutover") {
    throw new Error("authority cutover receipt requires an active authority.cutover operation");
  }
  const operation = getDb().prepare(`
    SELECT expected_revision, expected_authority_epoch, created_at
    FROM workflow_operations
    WHERE operation_id = :operation_id AND project_id = :project_id
  `).get({
    ":operation_id": context.operationId,
    ":project_id": context.projectId,
  });
  const cutoverAt = operation?.["created_at"];
  if (
    operation?.["expected_revision"] !== context.resultingRevision - 1
    || operation?.["expected_authority_epoch"] !== context.resultingAuthorityEpoch - 1
    || typeof cutoverAt !== "string"
    || cutoverAt.trim().length === 0
  ) {
    throw new Error("authority cutover receipt context does not advance exact authority");
  }

  const result = getDb().prepare(`
    INSERT INTO workflow_authority_cutovers (
      operation_id, project_id, authority_contract_version,
      evidence_hash, consent_hash, cutover_at,
      resulting_project_revision, resulting_authority_epoch
    ) VALUES (
      :operation_id, :project_id, :authority_contract_version,
      :evidence_hash, :consent_hash, :cutover_at,
      :resulting_project_revision, :resulting_authority_epoch
    )
  `).run({
    ":operation_id": context.operationId,
    ":project_id": context.projectId,
    ":authority_contract_version": input.authorityContractVersion,
    ":evidence_hash": input.evidenceHash,
    ":consent_hash": input.consentHash,
    ":cutover_at": cutoverAt,
    ":resulting_project_revision": context.resultingRevision,
    ":resulting_authority_epoch": context.resultingAuthorityEpoch,
  });
  if ((result as { changes?: unknown }).changes !== 1) {
    throw new Error("authority cutover receipt was not inserted exactly once");
  }
  return Object.freeze({ cutoverAt });
}
