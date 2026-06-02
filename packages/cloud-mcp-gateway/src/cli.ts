#!/usr/bin/env node
import { parseArgs } from "node:util";
import { listenGateway } from "./server.js";

const { values } = parseArgs({
  options: {
    port: { type: "string" },
    host: { type: "string" },
    "auth-store": { type: "string" },
    "usage-store": { type: "string" },
    "allow-registration": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(`Usage: gsd-cloud-mcp-gateway [options]

Options:
  --host <host>              Host to bind. Defaults to 0.0.0.0.
  --port <port>              Port to bind. Defaults to PORT or 8787.
  --auth-store <path>        Persist users, hashed tokens, and pairing codes.
  --usage-store <path>       Persist aggregate usage metrics and recent calls.
  --allow-registration       Enable public POST /register self-registration.
  -h, --help                 Show this help.

Environment:
  GSD_CLOUD_USER_TOKEN       Required seed admin bearer token.
  GSD_CLOUD_ADMIN_TOKEN      Optional separate admin UI/API bearer token.
  GSD_CLOUD_AUTH_STORE_PATH  Default auth store path.
  GSD_CLOUD_USAGE_STORE_PATH Default usage store path.
  CLERK_SECRET_KEY           Enables Clerk-backed /account user auth.
  CLERK_PUBLISHABLE_KEY      Clerk publishable key for /account.
  CLERK_JWT_KEY              Optional Clerk JWT public key for networkless verification.
  CLERK_FRONTEND_API_URL     Optional override for ClerkJS script origin.
  GSD_CLOUD_FREE_CALLS_PER_MINUTE  Free-plan minute throttle. Default 12.
  GSD_CLOUD_FREE_CALLS_PER_DAY     Free-plan daily quota. Default 100.
  GSD_CLOUD_FREE_CALLS_PER_MONTH   Free-plan monthly quota. Default 1000.
  GSD_CLOUD_PAID_CALLS_PER_MINUTE  Paid-plan minute throttle. Default 60.
  GSD_CLOUD_PAID_CALLS_PER_DAY     Paid-plan daily quota. Default 2000.
  GSD_CLOUD_PAID_CALLS_PER_MONTH   Paid-plan monthly quota. Default 50000.
`);
  process.exit(0);
}

listenGateway({
  port: values.port ? Number(values.port) : undefined,
  host: values.host,
  authStorePath: values["auth-store"],
  usageStorePath: values["usage-store"],
  allowRegistration: values["allow-registration"],
}).then(({ url }) => {
  process.stderr.write(`[gsd-cloud-mcp-gateway] listening on ${url}\n`);
  process.stderr.write(`[gsd-cloud-mcp-gateway] admin UI available at ${url}/admin\n`);
}).catch((err) => {
  process.stderr.write(`[gsd-cloud-mcp-gateway] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
