import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer } from "ws";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { renderAccountUi } from "./account-ui.js";
import { renderAdminUi } from "./admin-ui.js";
import { createClerkAuthenticatorFromEnv, type ClerkAuthenticatedUser, type ClerkAuthenticator } from "./clerk-auth.js";
import { createGatewayMcpServer } from "./mcp.js";
import { extractBearerToken, FileAuthStore, InMemoryAuthStore, type UserRecord } from "./auth-store.js";
import { RuntimeRegistry } from "./runtime-registry.js";
import { parseUsageLimitConfig, UsageLimiter, type UsageQuotaStatus } from "./usage-limits.js";
import { FileUsageStore, InMemoryUsageStore, type UsageSummaryRow } from "./usage-store.js";

const MAX_JSON_BODY_BYTES = 1024 * 1024;

export interface GatewayServerOptions {
  port?: number;
  host?: string;
  userToken?: string;
  userId?: string;
  authStorePath?: string;
  usageStorePath?: string;
  adminToken?: string;
  allowRegistration?: boolean;
  usageLimiter?: UsageLimiter;
  clerkAuth?: ClerkAuthenticator;
}

export function createGatewayServer(options: GatewayServerOptions = {}) {
  const userId = options.userId ?? "local-user";
  const userToken = options.userToken ?? process.env.GSD_CLOUD_USER_TOKEN;
  if (!userToken) {
    throw new Error("GSD_CLOUD_USER_TOKEN is required");
  }
  const authStorePath = options.authStorePath ?? process.env.GSD_CLOUD_AUTH_STORE_PATH;
  const usageStorePath = options.usageStorePath ?? process.env.GSD_CLOUD_USAGE_STORE_PATH;
  const adminToken = options.adminToken ?? process.env.GSD_CLOUD_ADMIN_TOKEN;
  const allowRegistration = options.allowRegistration ?? parseBoolean(process.env.GSD_CLOUD_ALLOW_REGISTRATION);
  const auth = authStorePath
    ? new FileAuthStore(authStorePath, { token: userToken, userId, role: "admin" })
    : new InMemoryAuthStore({ token: userToken, userId, role: "admin" });
  const usage = usageStorePath ? new FileUsageStore(usageStorePath) : new InMemoryUsageStore();
  const usageLimiter = options.usageLimiter ?? new UsageLimiter(parseUsageLimitConfig());
  const clerkAuth = options.clerkAuth ?? createClerkAuthenticatorFromEnv();
  const registry = new RuntimeRegistry();
  const wss = new WebSocketServer({ noServer: true });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && url.pathname === "/healthz") {
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) {
        return sendHtml(res, 200, renderAdminUi());
      }

      if (req.method === "GET" && (url.pathname === "/account" || url.pathname === "/account/")) {
        return sendHtml(res, 200, renderAccountUi(clerkAuth?.publicConfig));
      }

      if (url.pathname.startsWith("/admin/api/")) {
        const adminUser = requireAdmin(req, auth, adminToken);
        if (!adminUser) return sendJson(res, 401, { error: "Unauthorized" });
        return handleAdminApi({
          req,
          res,
          pathname: url.pathname,
          auth,
          registry,
          usage,
          usageLimiter,
        });
      }

      if (url.pathname.startsWith("/account/api/")) {
        if (!clerkAuth) return sendJson(res, 503, { error: "Clerk authentication is not configured" });
        const clerkUser = await clerkAuth.authenticate(req);
        if (!clerkUser) return sendJson(res, 401, { error: "Unauthorized" });
        return handleAccountApi({
          req,
          res,
          pathname: url.pathname,
          auth,
          usage,
          usageLimiter,
          clerkUser,
        });
      }

      if (req.method === "POST" && url.pathname === "/register") {
        if (!allowRegistration) return sendJson(res, 403, { error: "Registration is disabled" });
        const body = await readJson(req);
        const email = optionalString(body.email);
        if (!email) return sendJson(res, 400, { error: "Email is required" });
        const existing = auth.listUsers().find((user) => user.email?.toLowerCase() === email.toLowerCase());
        if (existing) return sendJson(res, 409, { error: "User already exists" });
        const user = auth.createUser({
          email,
          name: optionalString(body.name),
          role: "member",
          plan: "free",
        });
        const issued = auth.issueUserToken(user.userId, { label: "registration" });
        return sendJson(res, 201, { user, userToken: issued.userToken, tokenId: issued.tokenId });
      }

      if (req.method === "POST" && url.pathname === "/pairing-codes") {
        const authedUser = requireUser(req, auth);
        if (!authedUser) return sendJson(res, 401, { error: "Unauthorized" });
        try {
          return sendJson(res, 200, auth.createPairingCode(authedUser));
        } catch (err) {
          return sendJson(res, 400, { error: err instanceof Error ? err.message : "Unable to create pairing code" });
        }
      }

      if (req.method === "POST" && url.pathname === "/pairing/exchange") {
        const body = await readJson(req);
        const code = typeof body.code === "string" ? body.code : "";
        const runtimeName = typeof body.runtimeName === "string" ? body.runtimeName : undefined;
        try {
          return sendJson(res, 200, auth.exchangePairingCode(code, runtimeName));
        } catch {
          return sendJson(res, 400, { error: "Pairing code is invalid or expired" });
        }
      }

      if (url.pathname === "/mcp") {
        const authedUser = requireUser(req, auth);
        if (!authedUser) return sendJson(res, 401, { error: "Unauthorized" });
        const body = req.method === "POST" ? await readJson(req) : undefined;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        const mcp = createGatewayMcpServer({
          userId: authedUser,
          registry,
          usage,
          usageLimiter,
          getUser: (id) => auth.getUser(id),
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      if (err instanceof BadRequestError) {
        return sendJson(res, 400, { error: err.message });
      }
      sendJson(res, 500, { error: "Internal server error" });
    }
  });

  server.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/runtime/connect") {
        socket.destroy();
        return;
      }
      const deviceToken = extractBearerToken(req.headers.authorization);
      const device = auth.authenticateDevice(deviceToken);
      if (!device) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        registry.attachRuntime({
          userId: device.userId,
          runtimeId: device.runtimeId,
          runtimeName: device.runtimeName,
          socket: ws,
        });
        ws.send(JSON.stringify({ type: "connected", requestId: randomUUID(), runtimeId: device.runtimeId }));
      });
    } catch {
      socket.destroy();
    }
  });

  return { server, auth, registry, usage, usageLimiter };
}

export async function listenGateway(options: GatewayServerOptions = {}): Promise<{
  close: () => Promise<void>;
  url: string;
}> {
  const { server } = createGatewayServer(options);
  const port = options.port ?? Number(process.env.PORT ?? 8787);
  const host = options.host ?? "0.0.0.0";
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  return {
    url: `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

async function handleAdminApi(params: {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  auth: InMemoryAuthStore;
  registry: RuntimeRegistry;
  usage: InMemoryUsageStore;
  usageLimiter: UsageLimiter;
}): Promise<void> {
  const { req, res, pathname, auth, registry, usage, usageLimiter } = params;
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (req.method === "GET" && pathname === "/admin/api/overview") {
    const users = auth.listUsers();
    const summary = usage.getSummary();
    return sendJson(res, 200, {
      totalUsers: users.length,
      activeUsers: users.filter((user) => !user.disabled).length,
      disabledUsers: users.filter((user) => user.disabled).length,
      onlineRuntimes: registry.listRuntimeSummaries().length,
      totalCalls: summary.totalCalls,
      billableCalls: summary.billableCalls,
      failedCalls: summary.failedCalls,
      throttledCalls: summary.throttledCalls,
      averageDurationMs: summary.averageDurationMs,
    });
  }

  if (req.method === "GET" && pathname === "/admin/api/users") {
    return sendJson(res, 200, {
      users: buildAdminUsers(auth, usage, usageLimiter),
    });
  }

  if (req.method === "POST" && pathname === "/admin/api/users") {
    const body = await readJson(req);
    const user = auth.createUser({
      email: optionalString(body.email),
      name: optionalString(body.name),
      role: body.role === "admin" ? "admin" : "member",
      plan: normalizePlan(body.plan),
      quotaOverrides: parseQuotaOverrides(body),
    });
    const issueToken = body.issueToken !== false;
    const issued = issueToken ? auth.issueUserToken(user.userId, { label: optionalString(body.tokenLabel) ?? "initial" }) : undefined;
    return sendJson(res, 201, {
      user,
      ...(issued ? { userToken: issued.userToken, tokenId: issued.tokenId } : {}),
    });
  }

  if (req.method === "POST" && segments[2] === "users" && segments[3] && segments[4] === "tokens") {
    const user = auth.getUser(segments[3]);
    if (!user) return sendJson(res, 404, { error: "User not found" });
    const body = await readJson(req);
    const issued = auth.issueUserToken(user.userId, { label: optionalString(body.label) ?? "manual" });
    return sendJson(res, 201, {
      userId: user.userId,
      tokenId: issued.tokenId,
      userToken: issued.userToken,
    });
  }

  if (req.method === "POST" && segments[2] === "users" && segments[3] && segments[4] === "disabled") {
    const user = auth.getUser(segments[3]);
    if (!user) return sendJson(res, 404, { error: "User not found" });
    const body = await readJson(req);
    const disabled = body.disabled === true;
    if (disabled && isLastActiveAdmin(auth, user)) {
      return sendJson(res, 400, { error: "Cannot disable the last active admin user" });
    }
    return sendJson(res, 200, { user: auth.updateUser(user.userId, { disabled }) });
  }

  if (req.method === "POST" && segments[2] === "users" && segments[3] && segments[4] === "pairing-codes") {
    const user = auth.getUser(segments[3]);
    if (!user) return sendJson(res, 404, { error: "User not found" });
    try {
      return sendJson(res, 201, auth.createPairingCode(user.userId));
    } catch (err) {
      return sendJson(res, 400, { error: err instanceof Error ? err.message : "Unable to create pairing code" });
    }
  }

  if (req.method === "POST" && segments[2] === "tokens" && segments[3] && segments[4] === "revoke") {
    const revoked = auth.revokeUserTokenById(segments[3]);
    return sendJson(res, revoked ? 200 : 404, revoked ? { revoked: true } : { error: "Token not found" });
  }

  if (req.method === "GET" && pathname === "/admin/api/runtimes") {
    return sendJson(res, 200, { runtimes: registry.listRuntimeSummaries() });
  }

  if (req.method === "GET" && pathname === "/admin/api/usage") {
    return sendJson(res, 200, usage.getSummary());
  }

  sendJson(res, 404, { error: "Not found" });
}

async function handleAccountApi(params: {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  auth: InMemoryAuthStore;
  usage: InMemoryUsageStore;
  usageLimiter: UsageLimiter;
  clerkUser: ClerkAuthenticatedUser;
}): Promise<void> {
  const { req, res, pathname, auth, usage, usageLimiter, clerkUser } = params;
  const user = syncClerkGatewayUser(auth, clerkUser);
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (req.method === "GET" && pathname === "/account/api/me") {
    return sendJson(res, 200, buildAccountResponse(auth, usage, usageLimiter, user.userId));
  }

  if (req.method === "POST" && pathname === "/account/api/tokens") {
    const body = await readJson(req);
    const issued = auth.issueUserToken(user.userId, { label: optionalString(body.label) ?? "manual" });
    return sendJson(res, 201, {
      tokenId: issued.tokenId,
      userToken: issued.userToken,
    });
  }

  if (req.method === "POST" && segments[2] === "tokens" && segments[3] && segments[4] === "revoke") {
    const token = auth.listUserTokens(user.userId).find((record) => record.tokenId === segments[3]);
    if (!token) return sendJson(res, 404, { error: "Token not found" });
    const revoked = auth.revokeUserTokenById(token.tokenId);
    return sendJson(res, revoked ? 200 : 404, revoked ? { revoked: true } : { error: "Token not found" });
  }

  if (req.method === "POST" && pathname === "/account/api/pairing-codes") {
    try {
      return sendJson(res, 201, auth.createPairingCode(user.userId));
    } catch (err) {
      return sendJson(res, 400, { error: err instanceof Error ? err.message : "Unable to create pairing code" });
    }
  }

  sendJson(res, 404, { error: "Not found" });
}

function syncClerkGatewayUser(auth: InMemoryAuthStore, clerkUser: ClerkAuthenticatedUser): UserRecord {
  const existing = auth.getUserByClerkUserId(clerkUser.clerkUserId);
  if (existing) return existing;
  return auth.createUser({
    userId: `clerk_${clerkUser.clerkUserId}`,
    clerkUserId: clerkUser.clerkUserId,
    role: "member",
    plan: "free",
  });
}

function buildAccountResponse(
  auth: InMemoryAuthStore,
  usage: InMemoryUsageStore,
  usageLimiter: UsageLimiter,
  userId: string,
): {
  user: UserRecord;
  tokens: ReturnType<InMemoryAuthStore["listUserTokens"]>;
  usage: UsageSummaryRow;
  quota: UsageQuotaStatus;
} {
  const user = auth.getUser(userId);
  if (!user) throw new Error(`Unknown user: ${userId}`);
  const usageRow = usage.getSummary().byUser.find((row) => row.userId === userId) ?? {
    userId,
    calls: 0,
    billableCalls: 0,
    failures: 0,
    throttled: 0,
    totalDurationMs: 0,
    averageDurationMs: 0,
  };
  return {
    user,
    tokens: auth.listUserTokens(userId),
    usage: usageRow,
    quota: usageLimiter.inspect(user, usage),
  };
}

function buildAdminUsers(auth: InMemoryAuthStore, usage: InMemoryUsageStore, usageLimiter: UsageLimiter): Array<UserRecord & {
  tokens: ReturnType<InMemoryAuthStore["listUserTokens"]>;
  usage: UsageSummaryRow;
  quota: UsageQuotaStatus;
}> {
  const usageRows = new Map<string, UsageSummaryRow>();
  for (const row of usage.getSummary().byUser) {
    if (row.userId) usageRows.set(row.userId, row);
  }
  return auth.listUsers().map((user) => ({
    ...user,
    tokens: auth.listUserTokens(user.userId),
    usage: usageRows.get(user.userId) ?? {
      userId: user.userId,
      calls: 0,
      billableCalls: 0,
      failures: 0,
      throttled: 0,
      totalDurationMs: 0,
      averageDurationMs: 0,
    },
    quota: usageLimiter.inspect(user, usage),
  }));
}

function requireUser(req: IncomingMessage, auth: InMemoryAuthStore): string | null {
  return auth.authenticateUser(extractBearerToken(req.headers.authorization));
}

function requireAdmin(req: IncomingMessage, auth: InMemoryAuthStore, adminToken: string | undefined): string | null {
  const token = extractBearerToken(req.headers.authorization);
  if (adminToken) return tokenMatches(token, adminToken) ? "admin-token" : null;
  const userId = auth.authenticateUser(token);
  if (!userId) return null;
  return auth.getUser(userId)?.role === "admin" ? userId : null;
}

function tokenMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function isLastActiveAdmin(auth: InMemoryAuthStore, user: UserRecord): boolean {
  if (user.role !== "admin" || user.disabled) return false;
  const activeAdmins = auth.listUsers().filter((candidate) => candidate.role === "admin" && !candidate.disabled);
  return activeAdmins.length <= 1;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      throw new BadRequestError("Request body too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    throw new BadRequestError("Invalid JSON request body");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizePlan(value: unknown): UserRecord["plan"] {
  if (value === "paid" || value === "unlimited") return value;
  return "free";
}

function parseQuotaOverrides(body: Record<string, unknown>): UserRecord["quotaOverrides"] {
  const overrides: NonNullable<UserRecord["quotaOverrides"]> = {};
  for (const [bodyKey, overrideKey] of [
    ["callsPerMinute", "callsPerMinute"],
    ["callsPerDay", "callsPerDay"],
    ["callsPerMonth", "callsPerMonth"],
  ] as const) {
    const parsed = optionalLimit(body[bodyKey]);
    if (parsed !== undefined) overrides[overrideKey] = parsed;
  }
  return Object.keys(overrides).length ? overrides : undefined;
}

function optionalLimit(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}

function parseBoolean(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes";
}

class BadRequestError extends Error {}
