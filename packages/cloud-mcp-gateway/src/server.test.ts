import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { ClerkAuthenticator } from "./clerk-auth.js";
import { createGatewayServer } from "./server.js";

test("gateway requires an explicit user bearer token", () => {
  const prior = process.env.GSD_CLOUD_USER_TOKEN;
  delete process.env.GSD_CLOUD_USER_TOKEN;
  try {
    assert.throws(() => createGatewayServer(), /GSD_CLOUD_USER_TOKEN is required/);
  } finally {
    if (prior === undefined) delete process.env.GSD_CLOUD_USER_TOKEN;
    else process.env.GSD_CLOUD_USER_TOKEN = prior;
  }
});

test("gateway does not expose unexpected error details in HTTP responses", async () => {
  const { server, auth } = createGatewayServer({ userToken: "user-token" });
  auth.authenticateUser = () => {
    throw new Error("stack detail: secret-token");
  };

  const response = await dispatch(server, {
    method: "POST",
    url: "/pairing-codes",
    headers: { authorization: "Bearer user-token" },
  });
  assert.equal(response.status, 500);
  assert.deepEqual(JSON.parse(response.body) as unknown, { error: "Internal server error" });
});

test("gateway reports invalid JSON as a client error", async () => {
  const { server } = createGatewayServer({ userToken: "user-token" });
  const response = await dispatch(server, {
    method: "POST",
    url: "/mcp",
    headers: { authorization: "Bearer user-token" },
    chunks: ["{"],
  });
  assert.equal(response.status, 400);
  assert.deepEqual(JSON.parse(response.body) as unknown, { error: "Invalid JSON request body" });
});

test("gateway rejects oversized JSON request bodies", async () => {
  const { server } = createGatewayServer({ userToken: "user-token" });
  const response = await dispatch(server, {
    method: "POST",
    url: "/mcp",
    headers: { authorization: "Bearer user-token" },
    chunks: [`{"value":"${"a".repeat(1024 * 1024)}"}`],
  });
  assert.equal(response.status, 400);
  assert.deepEqual(JSON.parse(response.body) as unknown, { error: "Request body too large" });
});

test("gateway serves the management frontend", async () => {
  const { server } = createGatewayServer({ userToken: "user-token" });
  const response = await dispatch(server, {
    method: "GET",
    url: "/admin",
    headers: {},
  });

  assert.equal(response.status, 200);
  assert.match(response.body, /Users and Usage/);
  assert.match(response.body, /admin\/api\/users/);
});

test("gateway serves the Clerk account frontend", async () => {
  const { server } = createGatewayServer({
    userToken: "user-token",
    clerkAuth: fakeClerkAuth(),
  });
  const response = await dispatch(server, {
    method: "GET",
    url: "/account",
    headers: {},
  });

  assert.equal(response.status, 200);
  assert.match(response.body, /My MCP Access/);
  assert.match(response.body, /clerk-js@6/);
});

test("account API requires Clerk authentication", async () => {
  const { server } = createGatewayServer({
    userToken: "user-token",
    clerkAuth: fakeClerkAuth(),
  });
  const response = await dispatch(server, {
    method: "GET",
    url: "/account/api/me",
    headers: {},
  });

  assert.equal(response.status, 401);
});

test("account API syncs Clerk users and manages their tokens", async () => {
  const { server, auth } = createGatewayServer({
    userToken: "admin-token",
    clerkAuth: fakeClerkAuth(),
  });

  const me = await dispatch(server, {
    method: "GET",
    url: "/account/api/me",
    headers: { authorization: "Bearer clerk-session-u1" },
  });
  assert.equal(me.status, 200);
  const meBody = JSON.parse(me.body) as { user: { userId: string; clerkUserId: string; plan: string }; tokens: unknown[] };
  assert.equal(meBody.user.clerkUserId, "clerk_u1");
  assert.equal(meBody.user.plan, "free");
  assert.deepEqual(meBody.tokens, []);

  const created = await dispatch(server, {
    method: "POST",
    url: "/account/api/tokens",
    headers: { authorization: "Bearer clerk-session-u1" },
    chunks: [JSON.stringify({ label: "Claude" })],
  });
  assert.equal(created.status, 201);
  const createdBody = JSON.parse(created.body) as { tokenId: string; userToken: string };
  assert.match(createdBody.userToken, /^gsd_usr_/);
  assert.equal(auth.authenticateUser(createdBody.userToken), meBody.user.userId);

  const revoked = await dispatch(server, {
    method: "POST",
    url: `/account/api/tokens/${encodeURIComponent(createdBody.tokenId)}/revoke`,
    headers: { authorization: "Bearer clerk-session-u1" },
  });
  assert.equal(revoked.status, 200);
  assert.equal(auth.authenticateUser(createdBody.userToken), null);
});

test("account API cannot revoke another Clerk user's token", async () => {
  const { server } = createGatewayServer({
    userToken: "admin-token",
    clerkAuth: fakeClerkAuth(),
  });
  const created = await dispatch(server, {
    method: "POST",
    url: "/account/api/tokens",
    headers: { authorization: "Bearer clerk-session-u1" },
    chunks: [JSON.stringify({ label: "Mine" })],
  });
  const createdBody = JSON.parse(created.body) as { tokenId: string };

  const blocked = await dispatch(server, {
    method: "POST",
    url: `/account/api/tokens/${encodeURIComponent(createdBody.tokenId)}/revoke`,
    headers: { authorization: "Bearer clerk-session-u2" },
  });
  assert.equal(blocked.status, 404);
});

test("account API creates pairing codes for the Clerk user", async () => {
  const { server, auth } = createGatewayServer({
    userToken: "admin-token",
    clerkAuth: fakeClerkAuth(),
  });
  const response = await dispatch(server, {
    method: "POST",
    url: "/account/api/pairing-codes",
    headers: { authorization: "Bearer clerk-session-u1" },
  });
  assert.equal(response.status, 201);
  const body = JSON.parse(response.body) as { code: string };
  const issued = auth.exchangePairingCode(body.code);
  assert.equal(issued.userId, "clerk_clerk_u1");
});

test("admin API requires admin bearer token when configured", async () => {
  const { server } = createGatewayServer({ userToken: "user-token", adminToken: "admin-token" });

  const rejected = await dispatch(server, {
    method: "GET",
    url: "/admin/api/overview",
    headers: { authorization: "Bearer user-token" },
  });
  assert.equal(rejected.status, 401);

  const accepted = await dispatch(server, {
    method: "GET",
    url: "/admin/api/overview",
    headers: { authorization: "Bearer admin-token" },
  });
  assert.equal(accepted.status, 200);
  assert.equal((JSON.parse(accepted.body) as { totalUsers: number }).totalUsers, 1);
});

test("admin API creates users and returns raw user tokens once", async () => {
  const { server, auth } = createGatewayServer({ userToken: "admin-token" });
  const response = await dispatch(server, {
    method: "POST",
    url: "/admin/api/users",
    headers: { authorization: "Bearer admin-token" },
    chunks: [JSON.stringify({ name: "Ada Lovelace", email: "ada@example.com", issueToken: true })],
  });

  assert.equal(response.status, 201);
  const body = JSON.parse(response.body) as { user: { userId: string; plan: string }; userToken: string; tokenId: string };
  assert.equal(body.user.plan, "free");
  assert.equal(auth.authenticateUser(body.userToken), body.user.userId);
  assert.match(body.userToken, /^gsd_usr_/);
  assert.match(body.tokenId, /^tok_/);

  const users = await dispatch(server, {
    method: "GET",
    url: "/admin/api/users",
    headers: { authorization: "Bearer admin-token" },
  });
  assert.equal(users.status, 200);
  assert.equal((JSON.parse(users.body) as { users: unknown[] }).users.length, 2);
});

test("public registration is opt-in", async () => {
  const disabled = createGatewayServer({ userToken: "admin-token" });
  const rejected = await dispatch(disabled.server, {
    method: "POST",
    url: "/register",
    headers: {},
    chunks: [JSON.stringify({ email: "new@example.com" })],
  });
  assert.equal(rejected.status, 403);

  const enabled = createGatewayServer({ userToken: "admin-token", allowRegistration: true });
  const accepted = await dispatch(enabled.server, {
    method: "POST",
    url: "/register",
    headers: {},
    chunks: [JSON.stringify({ email: "new@example.com", name: "New User" })],
  });
  assert.equal(accepted.status, 201);
  const body = JSON.parse(accepted.body) as { user: { userId: string; plan: string }; userToken: string };
  assert.equal(body.user.plan, "free");
  assert.equal(enabled.auth.authenticateUser(body.userToken), body.user.userId);
});

test("admin overview includes usage totals", async () => {
  const { server, usage } = createGatewayServer({ userToken: "admin-token" });
  usage.recordToolCall({
    userId: "local-user",
    toolName: "gsd_status",
    durationMs: 15,
    ok: true,
  });
  usage.recordToolCall({
    userId: "local-user",
    toolName: "gsd_status",
    durationMs: 1,
    ok: false,
    billable: false,
    throttled: true,
  });

  const response = await dispatch(server, {
    method: "GET",
    url: "/admin/api/overview",
    headers: { authorization: "Bearer admin-token" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(projectOverview(JSON.parse(response.body)), {
    totalCalls: 2,
    billableCalls: 1,
    throttledCalls: 1,
  });
});

test("runtime websocket rejects device tokens supplied in the URL query", () => {
  const { server, auth } = createGatewayServer({ userToken: "user-token" });
  const { code } = auth.createPairingCode("local-user");
  const issued = auth.exchangePairingCode(code, "Laptop");
  const socket = new MockUpgradeSocket();

  server.emit(
    "upgrade",
    {
      url: `/runtime/connect?device_token=${encodeURIComponent(issued.deviceToken)}`,
      headers: {},
    },
    socket,
    Buffer.alloc(0),
  );

  assert.match(socket.output, /401 Unauthorized/);
  assert.equal(socket.destroyed, true);
});

async function dispatch(
  server: ReturnType<typeof createGatewayServer>["server"],
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    chunks?: string[];
  },
): Promise<{ status: number; body: string }> {
  const req = new MockRequest(request);
  const res = new MockResponse();
  server.emit("request", req, res);
  return res.done;
}

class MockRequest extends EventEmitter {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  private readonly chunks: string[];

  constructor(params: { method: string; url: string; headers: Record<string, string>; chunks?: string[] }) {
    super();
    this.method = params.method;
    this.url = params.url;
    this.headers = params.headers;
    this.chunks = params.chunks ?? [];
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<Buffer> {
    for (const chunk of this.chunks) yield Buffer.from(chunk);
  }
}

class MockResponse extends EventEmitter {
  headersSent = false;
  private status = 0;
  private resolveDone!: (value: { status: number; body: string }) => void;
  readonly done = new Promise<{ status: number; body: string }>((resolve) => {
    this.resolveDone = resolve;
  });

  writeHead(status: number): void {
    this.status = status;
    this.headersSent = true;
  }

  end(body: string): void {
    this.resolveDone({ status: this.status, body });
  }
}

class MockUpgradeSocket extends EventEmitter {
  output = "";
  destroyed = false;

  write(chunk: string): void {
    this.output += chunk;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

function fakeClerkAuth(): ClerkAuthenticator {
  return {
    publicConfig: {
      publishableKey: "pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk",
      frontendApiUrl: "https://example.clerk.accounts.dev",
    },
    authenticate: async (req) => {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      if (token === "clerk-session-u1") return { clerkUserId: "clerk_u1", sessionId: "sess_u1" };
      if (token === "clerk-session-u2") return { clerkUserId: "clerk_u2", sessionId: "sess_u2" };
      return null;
    },
  };
}

function projectOverview(value: unknown): { totalCalls: number; billableCalls: number; throttledCalls: number } {
  const body = value as { totalCalls: number; billableCalls: number; throttledCalls: number };
  return {
    totalCalls: body.totalCalls,
    billableCalls: body.billableCalls,
    throttledCalls: body.throttledCalls,
  };
}
