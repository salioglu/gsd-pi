// Project/App: gsd-pi
// File Purpose: Regression tests for ScheduleWakeup tool behavior.

import test, { mock } from "node:test";
import assert from "node:assert/strict";

import { autoSession } from "../auto-runtime-state.ts";
import { registerScheduleWakeupTool } from "../bootstrap/schedule-wakeup-tool.ts";

test("ScheduleWakeup arms an interactive wakeup when auto-mode is inactive", async () => {
  autoSession.reset();
  mock.timers.enable({ apis: ["setTimeout"] });

  const sent: Array<{ message: unknown; options: unknown }> = [];
  let tool: any;
  const pi = {
    registerTool(registered: any) {
      tool = registered;
    },
    sendMessage(message: unknown, options: unknown) {
      sent.push({ message, options });
    },
  };

  try {
    registerScheduleWakeupTool(pi as any);
    assert.ok(tool, "ScheduleWakeup tool should be registered");

    const result = await tool.execute(
      "call-1",
      {
        delaySeconds: 1,
        prompt: "Check the external job and report back.",
        reason: "poll external job",
      },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /Wakeup scheduled for 1s/);
    assert.equal(sent.length, 0, "wakeup should not dispatch synchronously");

    mock.timers.tick(999);
    assert.equal(sent.length, 0, "wakeup should wait for the configured delay");

    mock.timers.tick(1);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].options, { triggerTurn: true });
    assert.deepEqual(sent[0].message, {
      customType: "gsd-schedule-wakeup",
      content: "Check the external job and report back.",
      display: true,
      details: {
        delaySeconds: 1,
        reason: "poll external job",
      },
    });
  } finally {
    mock.timers.reset();
    autoSession.reset();
  }
});
