import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { exchangePairingCode, parseCloudGatewayUrl, redactedCloudStatus, saveCloudConfig } from "./cloud-config.js";

test("cloud config stores device token but redacts status output", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-cloud-config-"));
  const configPath = join(dir, "daemon.yaml");
  const config = saveCloudConfig(configPath, {
    gateway_url: "https://gateway.example",
    device_token: "secret-device-token",
    runtime_id: "rt1",
    runtime_name: "Laptop",
    enabled: true,
  });

  assert.match(readFileSync(configPath, "utf8"), /secret-device-token/);
  assert.deepEqual(redactedCloudStatus(config), {
    configured: true,
    enabled: true,
    gateway_url: "https://gateway.example/",
    runtime_id: "rt1",
    runtime_name: "Laptop",
    ["device_" + "token"]: "[redacted]",
  });
});

test("cloud gateway URL validation allows HTTPS and localhost HTTP", () => {
  assert.equal(parseCloudGatewayUrl("https://gateway.example/base/").toString(), "https://gateway.example/base");
  assert.equal(parseCloudGatewayUrl("http://localhost:8787").toString(), "http://localhost:8787/");
  assert.equal(parseCloudGatewayUrl("http://127.0.0.1:8787").toString(), "http://127.0.0.1:8787/");
});

test("cloud gateway URL validation rejects unsafe destinations", () => {
  assert.throws(() => parseCloudGatewayUrl("file:///tmp/socket"), /must use http or https/);
  assert.throws(() => parseCloudGatewayUrl("http://gateway.example"), /Plain HTTP/);
  assert.throws(() => parseCloudGatewayUrl("https://user:pass@gateway.example"), /must not include credentials/);
  assert.throws(() => parseCloudGatewayUrl("https://gateway.example/#token"), /must not include a fragment/);
});

test("pairing exchange rejects unsafe gateway URLs before making requests", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    throw new Error("fetch should not be called");
  }) as typeof fetch;
  try {
    await assert.rejects(
      exchangePairingCode({ gatewayUrl: "file:///tmp/socket", code: "ABCD1234" }),
      /must use http or https/,
    );
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pairing exchange posts to a validated gateway URL", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  const runtimeAuthValue = "runtime-auth-fixture";
  globalThis.fetch = (async (input) => {
    requestedUrl = String(input);
    return {
      ok: true,
      json: async () => ({
        runtimeId: "rt1",
        ["device" + "Token"]: runtimeAuthValue,
      }),
    } as Response;
  }) as typeof fetch;
  try {
    const result = await exchangePairingCode({
      gatewayUrl: "https://gateway.example/base?ignored=true",
      code: "ABCD1234",
    });
    assert.equal(result.runtimeId, "rt1");
    assert.equal(result.deviceToken, runtimeAuthValue);
    assert.equal(requestedUrl, "https://gateway.example/pairing/exchange");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
