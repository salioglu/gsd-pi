import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLoopbackHost, validateHttpMcpOptions } from './http.js';

test('HTTP MCP refuses unauthenticated public bind by default', () => {
  assert.throws(
    () => validateHttpMcpOptions({ host: '0.0.0.0', port: 8787 }),
    /refusing to expose unauthenticated/,
  );
});

test('HTTP MCP allows loopback development without auth', () => {
  assert.doesNotThrow(() => validateHttpMcpOptions({ host: '127.0.0.1', port: 8787 }));
  assert.doesNotThrow(() => validateHttpMcpOptions({ host: 'localhost', port: 8787 }));
  assert.equal(isLoopbackHost('::1'), true);
});

test('HTTP MCP allows public bind with bearer token', () => {
  assert.doesNotThrow(() =>
    validateHttpMcpOptions({ host: '0.0.0.0', port: 8787, authToken: 'secret' }),
  );
});
