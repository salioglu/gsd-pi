// Project/App: gsd-pi
// File Purpose: Visual contract tests for the assistant message plain surface (Variant A).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import stripAnsi from "strip-ansi";
import type { AssistantMessage } from "@gsd/pi-ai";

import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";
import { AssistantMessageComponent } from "../assistant-message.js";
import { formatTimestamp } from "../timestamp.js";
import { renderPlainSpeakerMessage } from "../transcript-design.js";

initTheme("dark", false);

describe("AssistantMessageComponent plain surface", () => {
	test("renders assistant content as an unboxed speaker line + body", () => {
		const message = {
			id: "m1",
			role: "assistant",
			provider: "test",
			model: "gpt-test",
			timestamp: 1,
			content: [{ type: "text", text: "I will update the renderer and run verification." }],
		} as unknown as AssistantMessage;

		const component = new AssistantMessageComponent(message, true);
		const plain = component.render(80).map((line) => stripAnsi(line));
		const joined = plain.join("\n");

		assert.match(joined, /GSD/);
		assert.match(joined, /gpt-test/);
		assert.match(joined, /update the renderer/);
		assert.doesNotMatch(joined, /╭/);
		assert.doesNotMatch(joined, /╰/);
		assert.doesNotMatch(joined, /[│┃]/);
	});

	test("renderPlainSpeakerMessage matches component layout", () => {
		const plain = renderPlainSpeakerMessage(["Hey there"], 80, {
			label: "GSD",
			meta: "gpt-test",
			tone: "assistant",
		})
			.map((line) => stripAnsi(line))
			.join("\n");
		assert.match(plain, /GSD/);
		assert.match(plain, /Hey there/);
		assert.doesNotMatch(plain, /╭/);
	});

	test("renders metadata for a zero timestamp", () => {
		const message = {
			id: "m1",
			role: "assistant",
			provider: "test",
			model: "gpt-test",
			timestamp: 0,
			content: [{ type: "text", text: "ok" }],
		} as unknown as AssistantMessage;

		const component = new AssistantMessageComponent(message, true);
		component.setShowMetadata(true);
		const plain = component.render(80).map((line) => stripAnsi(line)).join("\n");
		assert.match(plain, /1969-12-31/);
	});
});
