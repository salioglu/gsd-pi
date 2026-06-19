// Project/App: gsd-pi
// File Purpose: Legacy chat turn connection hook tests (no-op in Variant A).

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { reconcileChatTurnConnections } from "../chat-turn-connect.js";
import { UserMessageComponent } from "../user-message.js";

describe("reconcileChatTurnConnections", () => {
	test("is a no-op for plain transcript layout", () => {
		const user = new UserMessageComponent("hi");
		const before = user.render(80).join("\n");
		reconcileChatTurnConnections([user]);
		const after = user.render(80).join("\n");
		assert.equal(before, after);
	});
});
