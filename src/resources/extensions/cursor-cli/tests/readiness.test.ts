import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCursorAgentSpawnInvocation, getCursorAgentCommandCandidates, parseCursorAgentStatus } from "../readiness.ts";

test("getCursorAgentCommandCandidates includes Windows shims", () => {
	assert.deepEqual(getCursorAgentCommandCandidates("win32"), ["cursor-agent.cmd", "cursor-agent.exe", "cursor-agent"]);
	assert.deepEqual(getCursorAgentCommandCandidates("linux"), ["cursor-agent"]);
});

test("buildCursorAgentSpawnInvocation uses cmd /c on Windows", () => {
	assert.deepEqual(buildCursorAgentSpawnInvocation("cursor-agent.cmd", ["--version"], "win32"), {
		command: "cmd",
		args: ["/c", "cursor-agent.cmd", "--version"],
	});
});

test("parseCursorAgentStatus recognizes auth status output", () => {
	assert.equal(parseCursorAgentStatus('{"authenticated":true}'), true);
	assert.equal(parseCursorAgentStatus('{"loggedIn":false}'), false);
	assert.equal(parseCursorAgentStatus("Authenticated as user@example.com"), true);
	assert.equal(parseCursorAgentStatus("not authenticated"), false);
	assert.equal(parseCursorAgentStatus(""), null);
});
