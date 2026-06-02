import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './server.js';
import type { SessionManager } from './session-manager.js';

const MAX_JSON_BODY_BYTES = 1024 * 1024;

export interface HttpMcpServerOptions {
  host: string;
  port: number;
  authToken?: string;
  allowNoAuth?: boolean;
}

export async function listenHttpMcpServer(
  sessionManager: SessionManager,
  options: HttpMcpServerOptions,
): Promise<{ close: () => Promise<void>; url: string }> {
  validateHttpMcpOptions(options);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/healthz') {
        return sendJson(res, 200, { ok: true, server: 'gsd-mcp-server', mcpPath: '/mcp' });
      }

      if (url.pathname !== '/mcp') {
        return sendJson(res, 404, { error: 'Not found' });
      }

      if (!authorize(req, options)) {
        res.writeHead(401, {
          'content-type': 'application/json',
          'www-authenticate': 'Bearer',
        });
        return res.end(JSON.stringify({ error: 'missing or invalid bearer token' }));
      }

      const body = req.method === 'POST' ? await readJson(req) : undefined;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const { server: mcpServer } = await createMcpServer(sessionManager);
      res.on('finish', () => {
        void mcpServer.close().catch(() => undefined);
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (err instanceof BadRequestError) {
        return sendJson(res, 400, { error: err.message });
      }
      return sendJson(res, 500, { error: 'Internal server error' });
    }
  });

  await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve));
  const displayHost = options.host === '0.0.0.0' ? 'localhost' : options.host;
  return {
    url: `http://${displayHost}:${options.port}/mcp`,
    close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

export function validateHttpMcpOptions(options: HttpMcpServerOptions): void {
  if (options.allowNoAuth || options.authToken?.trim() || isLoopbackHost(options.host)) return;
  throw new Error(
    'refusing to expose unauthenticated gsd-mcp-server on a non-loopback host; set GSD_MCP_AUTH_TOKEN, pass --auth-token, or explicitly pass --no-auth',
  );
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized.startsWith('127.');
}

function authorize(req: IncomingMessage, options: HttpMcpServerOptions): boolean {
  if (options.allowNoAuth || !options.authToken) return true;
  return extractBearerToken(req.headers.authorization) === options.authToken;
}

function extractBearerToken(value: string | string[] | undefined): string | undefined {
  const header = Array.isArray(value) ? value[0] : value;
  if (!header) return undefined;
  const trimmed = header.trim();
  const schemeEnd = findFirstWhitespaceIndex(trimmed);
  if (schemeEnd <= 0) return undefined;
  if (trimmed.slice(0, schemeEnd).toLowerCase() !== 'bearer') return undefined;
  const token = trimmed.slice(schemeEnd).trimStart();
  return token || undefined;
}

function findFirstWhitespaceIndex(value: string): number {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 9 || code === 10 || code === 12 || code === 13 || code === 32) return i;
  }
  return -1;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      throw new BadRequestError('Request body too large');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    throw new BadRequestError('Invalid JSON request body');
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

class BadRequestError extends Error {}
