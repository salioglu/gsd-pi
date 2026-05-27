// Project/App: gsd-pi
// File Purpose: Detect when an assistant turn should bridge from a user turn.

import { Spacer } from "@gsd/pi-tui";
import { UserMessageComponent } from "./user-message.js";

export function chatTurnFollowsUser(children: readonly unknown[]): boolean {
	for (let i = children.length - 1; i >= 0; i--) {
		const child = children[i];
		if (child instanceof Spacer) continue;
		return child instanceof UserMessageComponent;
	}
	return false;
}
