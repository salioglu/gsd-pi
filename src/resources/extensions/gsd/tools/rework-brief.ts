import { saveReworkBrief, type ReworkBriefFindingInput } from "../gsd-db.js";
import { isNonEmptyString, validateStringArray } from "../validation.js";

export interface ReworkBriefSaveParams {
  briefId?: string;
  milestoneId: string;
  sliceId: string;
  taskId: string;
  findings: ReworkBriefFindingInput[];
}

export interface ReworkBriefSaveResult {
  briefId: string;
  milestoneId: string;
  sliceId: string;
  taskId: string;
  findingCount: number;
}

function validateFinding(finding: ReworkBriefFindingInput, index: number): ReworkBriefFindingInput {
  if (!isNonEmptyString(finding?.findingId)) throw new Error(`findings[${index}].findingId is required`);
  if (finding.severity !== "blocking" && finding.severity !== "advisory") {
    throw new Error(`findings[${index}].severity must be blocking or advisory`);
  }
  if (!isNonEmptyString(finding.description)) throw new Error(`findings[${index}].description is required`);
  if (!isNonEmptyString(finding.requiredFix)) throw new Error(`findings[${index}].requiredFix is required`);
  return {
    ...finding,
    verificationCommands: validateStringArray(finding.verificationCommands, `findings[${index}].verificationCommands`),
    status: finding.status ?? "pending",
  };
}

function validateParams(params: ReworkBriefSaveParams): ReworkBriefSaveParams {
  if (!isNonEmptyString(params?.milestoneId)) throw new Error("milestoneId is required");
  if (!isNonEmptyString(params?.sliceId)) throw new Error("sliceId is required");
  if (!isNonEmptyString(params?.taskId)) throw new Error("taskId is required");
  if (!Array.isArray(params.findings) || params.findings.length === 0) {
    throw new Error("findings must be a non-empty array");
  }
  return {
    ...params,
    findings: params.findings.map(validateFinding),
  };
}

export async function handleReworkBriefSave(
  rawParams: ReworkBriefSaveParams,
): Promise<ReworkBriefSaveResult | { error: string }> {
  let params: ReworkBriefSaveParams;
  try {
    params = validateParams(rawParams);
  } catch (err) {
    return { error: `validation failed: ${(err as Error).message}` };
  }

  try {
    const { briefId } = saveReworkBrief(params);
    return {
      briefId,
      milestoneId: params.milestoneId,
      sliceId: params.sliceId,
      taskId: params.taskId,
      findingCount: params.findings.length,
    };
  } catch (err) {
    return { error: `db write failed: ${(err as Error).message}` };
  }
}
