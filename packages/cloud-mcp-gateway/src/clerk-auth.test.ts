import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeClerkFrontendApiUrl } from "./clerk-auth.js";

test("decodes Clerk frontend API URL from publishable key", () => {
  const encoded = Buffer.from("example.clerk.accounts.dev").toString("base64");
  assert.equal(
    decodeClerkFrontendApiUrl(`pk_test_${encoded}$`),
    "https://example.clerk.accounts.dev",
  );
});

test("rejects invalid Clerk publishable keys", () => {
  assert.equal(decodeClerkFrontendApiUrl("not-a-key"), undefined);
});
