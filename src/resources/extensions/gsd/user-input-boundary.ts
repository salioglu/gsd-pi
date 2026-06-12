/**
 * Thin delegate over the Consent Question module (consent-question.ts).
 *
 * The question lifecycle — classification, gating, answer validation,
 * cancellation — lives in consent-question.ts with per-kind fail policy.
 * This module keeps the historical import surface stable for callers
 * (register-hooks, auto-post-unit, auto/phases).
 */

import { shouldPauseForQuestion } from "./consent-question.js";

export {
  approvalGateIdForUnit,
  isAwaitingApprovalBoundary,
  isAwaitingUserInput,
  isExplicitApprovalResponse,
  lastAssistantText,
  messageHasPendingAskUserQuestionsTool,
} from "./consent-question.js";

/**
 * @deprecated Delegates to shouldPauseForQuestion in consent-question.ts.
 * The old unit-type allowlist is gone: a classified consent/decision question
 * pauses regardless of unit type, including interactive mode (#682).
 */
export function shouldPauseForUserApprovalQuestion(
  unitType: string | undefined,
  messages: unknown[] | undefined,
): boolean {
  return shouldPauseForQuestion(unitType, messages);
}
