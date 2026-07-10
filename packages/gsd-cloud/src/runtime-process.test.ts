// Project/App: Open GSD
// File Purpose: Regression coverage for detached cloud runtime process timing and shutdown.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLOUD_RUNTIME_INITIAL_CONNECT_WINDOW_MS } from "./cloud-runtime.js";
import {
  BACKGROUND_RUNTIME_READY_TIMEOUT_MS,
  stopBackgroundRuntime,
} from "./runtime-process.js";

test("background startup allows the cloud runtime's full initial reconnect window", () => {
  assert.ok(BACKGROUND_RUNTIME_READY_TIMEOUT_MS > CLOUD_RUNTIME_INITIAL_CONNECT_WINDOW_MS);
});

test("stop waits for the detached runtime to exit before removing its state", { timeout: 5_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-stop-"));
  const configPath = join(root, "daemon.yaml");
  const statePath = join(root, "cloud-runtime.json");
  const child = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),200));process.send?.('ready');setInterval(()=>{},1000)",
  ], { stdio: ["ignore", "ignore", "ignore", "ipc"] });

  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("message", () => resolve());
    });
    assert.ok(child.pid);
    writeFileSync(statePath, `${JSON.stringify({ pid: child.pid, projects: [root] })}\n`);

    const startedAt = Date.now();
    assert.equal(await stopBackgroundRuntime(configPath), true);

    assert.ok(Date.now() - startedAt >= 150);
    assert.equal(existsSync(statePath), false);
  } finally {
    child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
