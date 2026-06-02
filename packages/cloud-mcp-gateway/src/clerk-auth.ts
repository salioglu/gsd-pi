import type { IncomingMessage } from "node:http";
import { createClerkClient } from "@clerk/backend";

export interface ClerkPublicConfig {
  publishableKey: string;
  frontendApiUrl: string;
}

export interface ClerkAuthenticatedUser {
  clerkUserId: string;
  sessionId?: string;
}

export interface ClerkAuthenticator {
  publicConfig: ClerkPublicConfig;
  authenticate(req: IncomingMessage): Promise<ClerkAuthenticatedUser | null>;
}

export function createClerkAuthenticatorFromEnv(
  env: Record<string, string | undefined> = process.env,
): ClerkAuthenticator | undefined {
  const secretKey = env.CLERK_SECRET_KEY;
  const publishableKey = env.CLERK_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  if (!secretKey || !publishableKey) return undefined;
  const frontendApiUrl = env.CLERK_FRONTEND_API_URL ?? decodeClerkFrontendApiUrl(publishableKey);
  if (!frontendApiUrl) return undefined;

  const client = createClerkClient({
    secretKey,
    publishableKey,
  });
  const jwtKey = env.CLERK_JWT_KEY;

  return {
    publicConfig: { publishableKey, frontendApiUrl },
    async authenticate(req) {
      const state = await client.authenticateRequest(toWebRequest(req), {
        ...(jwtKey ? { jwtKey } : {}),
      });
      if (!state.isAuthenticated) return null;
      const auth = state.toAuth();
      return auth.userId
        ? {
          clerkUserId: auth.userId,
          ...(auth.sessionId ? { sessionId: auth.sessionId } : {}),
        }
        : null;
    },
  };
}

export function decodeClerkFrontendApiUrl(publishableKey: string): string | undefined {
  const match = /^(pk_(?:test|live))_([^$]+)\$?$/.exec(publishableKey);
  if (!match) return undefined;
  try {
    const decoded = Buffer.from(match[2]!, "base64").toString("utf8").replace(/\0/g, "").trim();
    if (!decoded) return undefined;
    return /^https?:\/\//.test(decoded) ? decoded : `https://${decoded}`;
  } catch {
    return undefined;
  }
}

function toWebRequest(req: IncomingMessage): Request {
  const host = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host;
  const url = new URL(req.url ?? "/", `http://${host ?? "localhost"}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  return new Request(url, {
    method: req.method ?? "GET",
    headers,
  });
}
