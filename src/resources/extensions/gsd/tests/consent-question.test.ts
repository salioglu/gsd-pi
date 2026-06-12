import test from "node:test";
import assert from "node:assert/strict";

import {
  type AnswerOutcome,
  classifyQuestion,
  evaluateAnswer,
  evaluateAskUserQuestionsRound,
  failPolicyForKind,
  formatUnansweredConsentQuestionMessage,
  shouldPauseForQuestion,
} from "../consent-question.ts";

const GATE_OPTIONS = [
  { label: "Yes, you got it (Recommended)" },
  { label: "Needs adjustment" },
];

const CONSENT_OPTIONS = [
  { label: "Option A (Recommended)" },
  { label: "Option B" },
];

function assistantMessage(text: string): unknown {
  return { role: "assistant", content: [{ type: "text", text }] };
}

// ── Classification ──────────────────────────────────────────────────────────

test("classifyQuestion: gate ids, consent defaults, prose kinds", () => {
  assert.deepEqual(
    classifyQuestion({ id: "depth_verification_M001_confirm" }),
    { kind: "gate", gateSubKind: "approval" },
  );
  assert.deepEqual(
    classifyQuestion({ id: "depth_verification" }),
    { kind: "gate", gateSubKind: "depth-verification" },
  );
  assert.deepEqual(
    classifyQuestion({ id: "destructive_confirm_rm" }),
    { kind: "gate", gateSubKind: "destructive-confirm" },
  );
  // Any other structured question is a real elicitation → consent, fail-closed.
  assert.equal(classifyQuestion({ id: "m004_shape", options: CONSENT_OPTIONS }).kind, "consent");
  assert.equal(classifyQuestion({ id: "free_text_q" }).kind, "consent");
  // Prose classification.
  assert.equal(classifyQuestion({ text: "Should I proceed with the write?" }).kind, "consent");
  assert.equal(
    classifyQuestion({ text: "Want me to research this or skip?", unitType: "research-decision" }).kind,
    "decision",
  );
  assert.equal(classifyQuestion({ text: "Here is the summary of changes." }).kind, "informational");
});

test("failPolicyForKind: only informational is fail-open", () => {
  assert.equal(failPolicyForKind("gate"), "closed");
  assert.equal(failPolicyForKind("consent"), "closed");
  assert.equal(failPolicyForKind("decision"), "closed");
  assert.equal(failPolicyForKind("informational"), "open");
});

// ── Policy table: (kind × answer shape) → outcome ───────────────────────────

type Row = {
  name: string;
  question: { id: string; options?: Array<{ label?: string }> };
  details: Parameters<typeof evaluateAnswer>[0]["details"];
  expected: AnswerOutcome;
};

const gateQ = { id: "depth_verification_M001_confirm", options: GATE_OPTIONS };
const consentQ = { id: "boundary_choice", options: CONSENT_OPTIONS };

const POLICY_TABLE: Row[] = [
  // gate
  { name: "gate × confirm selected → verified", question: gateQ, details: { response: { answers: { [gateQ.id]: { selected: "Yes, you got it (Recommended)" } } } }, expected: "verified" },
  { name: "gate × decline selected → declined", question: gateQ, details: { response: { answers: { [gateQ.id]: { selected: "Needs adjustment" } } } }, expected: "declined" },
  { name: "gate × empty selected → waiting", question: gateQ, details: { response: { answers: { [gateQ.id]: { selected: "" } } } }, expected: "waiting" },
  { name: "gate × empty selected array → waiting", question: gateQ, details: { response: { answers: { [gateQ.id]: { selected: [] } } } }, expected: "waiting" },
  { name: "gate × missing response → waiting", question: gateQ, details: {}, expected: "waiting" },
  { name: "gate × notes-only → waiting (notes never satisfy a gate)", question: gateQ, details: { response: { answers: { [gateQ.id]: { notes: "looks fine" } } } }, expected: "waiting" },
  { name: "gate × cancelled → cancelled", question: gateQ, details: { cancelled: true, response: null }, expected: "cancelled" },
  // consent
  { name: "consent × valid selected → answered", question: consentQ, details: { response: { answers: { [consentQ.id]: { selected: "Option B" } } } }, expected: "answered" },
  { name: "consent × empty selected → waiting (#528)", question: consentQ, details: { response: { answers: { [consentQ.id]: { selected: "" } } } }, expected: "waiting" },
  { name: "consent × missing answer → waiting", question: consentQ, details: { response: { answers: {} } }, expected: "waiting" },
  { name: "consent × missing response → waiting", question: consentQ, details: {}, expected: "waiting" },
  { name: "consent × notes-only → answered (a real user utterance)", question: consentQ, details: { response: { answers: { [consentQ.id]: { notes: "neither — keep it simple" } } } }, expected: "answered" },
  { name: "consent × cancelled → cancelled", question: consentQ, details: { cancelled: true, response: null }, expected: "cancelled" },
];

for (const row of POLICY_TABLE) {
  test(`policy table: ${row.name}`, () => {
    assert.equal(evaluateAnswer({ question: row.question, details: row.details }), row.expected);
  });
}

// ── Round evaluation ────────────────────────────────────────────────────────

test("evaluateAskUserQuestionsRound: most blocking outcome wins", () => {
  const details = {
    response: {
      answers: {
        [consentQ.id]: { selected: "Option A (Recommended)" },
        second: { selected: "" },
      },
    },
  };
  assert.equal(
    evaluateAskUserQuestionsRound([consentQ, { id: "second", options: CONSENT_OPTIONS }], details),
    "waiting",
  );
  assert.equal(evaluateAskUserQuestionsRound([consentQ], { cancelled: true }), "cancelled");
  assert.equal(
    evaluateAskUserQuestionsRound([consentQ], {
      response: { answers: { [consentQ.id]: { selected: "Option A (Recommended)" } } },
    }),
    "answered",
  );
  // Empty round with no response is a no-op for callers.
  assert.equal(evaluateAskUserQuestionsRound([], {}), "answered");
});

// ── Regression: #528 empty selected on a consent question never answers ─────

test("#528: empty selected on a NON-gate question is waiting, not answered", () => {
  const outcome = evaluateAskUserQuestionsRound(
    [{ id: "scope_check", options: CONSENT_OPTIONS }],
    { response: { answers: { scope_check: { selected: "" } } } },
  );
  assert.equal(outcome, "waiting");
  const message = formatUnansweredConsentQuestionMessage([{ id: "scope_check" }]);
  assert.match(message, /scope_check/);
  assert.match(message, /not consent/i);
});

// ── Regression: #682 pause promotion outside the old unit-type allowlist ────

test("#682: consent question in a non-allowlisted unit type pauses", () => {
  const messages = [assistantMessage("The slice is staged. Ready to proceed with the merge?")];
  assert.equal(shouldPauseForQuestion("execute-task", messages), true);
});

test("#682: consent question in interactive mode (no unit type) pauses", () => {
  const messages = [assistantMessage("Does this capture your intent correctly?")];
  assert.equal(shouldPauseForQuestion(undefined, messages), true);
});

test("#682: cancellation marker pauses regardless of unit type", () => {
  const messages = [assistantMessage("ask_user_questions was cancelled before receiving a response")];
  assert.equal(shouldPauseForQuestion(undefined, messages), true);
  assert.equal(shouldPauseForQuestion("execute-task", messages), true);
});

test("shouldPauseForQuestion: informational prose never pauses", () => {
  const messages = [assistantMessage("All tests pass. Moving on to the next task.")];
  assert.equal(shouldPauseForQuestion(undefined, messages), false);
  assert.equal(shouldPauseForQuestion("discuss-project", messages), false);
});

test("shouldPauseForQuestion: plain non-approval question does not pause", () => {
  // Generic questions (no approval/consent language) stay informational —
  // matches the historical contract in deep-project-auto-loop tests.
  const messages = [assistantMessage("Which file did you mean?")];
  assert.equal(shouldPauseForQuestion("discuss-project", messages), false);
});
